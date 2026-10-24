import { createHash } from 'node:crypto';
import { google, type calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import { env, requireCalendarConfig } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Booking } from '../bookings/booking.model.js';
import { Room } from '../rooms/room.model.js';
import { User } from '../users/user.model.js';
import { OutboxEvent, type OutboxEventRecord } from '../outbox/outbox.model.js';
import {
  OutboxHandlerError,
  type OutboxHandler,
} from '../outbox/outbox.service.js';

export interface CalendarGateway {
  getEvent(id: string): Promise<CalendarEvent | null>;
  createEvent(event: CalendarEvent): Promise<void>;
  updateEvent(id: string, event: CalendarEvent): Promise<void>;
  deleteEvent(id: string): Promise<void>;
}
export interface CalendarEvent {
  id: string;
  summary: string;
  location: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: Array<{ email: string; displayName?: string }>;
  extendedProperties: { private: { bookingId: string } };
}
type ClientCalendarEvent = calendar_v3.Schema$Event;

export function deterministicEventId(bookingId: string): string {
  return `b${createHash('sha256').update(`booking-calendar:${bookingId.toLowerCase()}`).digest('hex')}`;
}

/**
 * Format a canonical instant as a local RFC3339 value with its explicit offset.
 * The Calendar event also carries the IANA timezone, so Google never has to
 * infer whether an already-UTC value should be converted a second time.
 */
export function calendarDateTime(value: Date, timezone: string): string {
  const formatted = DateTime.fromJSDate(value, { zone: 'utc' })
    .setZone(timezone)
    .toISO({ suppressMilliseconds: true });
  if (!formatted) throw new Error('Could not format Calendar date-time');
  return formatted;
}

export function createGoogleCalendarGateway(): CalendarGateway {
  const config = requireCalendarConfig();
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const calendar = google.calendar({ version: 'v3', auth });
  return {
    async getEvent(id) {
      try {
        const response = await calendar.events.get({
          calendarId: config.calendarId,
          eventId: id,
        });
        return fromGoogleEvent(response.data);
      } catch (error) {
        if (googleStatus(error) === 404) return null;
        throw classifyGoogleError(error, 'GOOGLE_CALENDAR_GET_FAILED');
      }
    },
    async createEvent(event) {
      try {
        await calendar.events.insert({
          calendarId: config.calendarId,
          sendUpdates: 'none',
          requestBody: event as ClientCalendarEvent,
        });
      } catch (error) {
        const status = googleStatus(error);
        if (status === 404)
          throw new OutboxHandlerError('GOOGLE_CALENDAR_NOT_FOUND', false);
        throw classifyGoogleError(error, 'GOOGLE_CALENDAR_CREATE_FAILED');
      }
    },
    async updateEvent(id, event) {
      try {
        await calendar.events.update({
          calendarId: config.calendarId,
          eventId: id,
          sendUpdates: 'none',
          requestBody: event as ClientCalendarEvent,
        });
      } catch (error) {
        const status = googleStatus(error);
        if (status === 404)
          throw new OutboxHandlerError('GOOGLE_CALENDAR_NOT_FOUND', false);
        throw classifyGoogleError(error, 'GOOGLE_CALENDAR_UPDATE_FAILED');
      }
    },
    async deleteEvent(id) {
      try {
        await calendar.events.delete({
          calendarId: config.calendarId,
          eventId: id,
          sendUpdates: 'none',
        });
      } catch (error) {
        if (googleStatus(error) === 404) return;
        throw classifyGoogleError(error, 'GOOGLE_CALENDAR_DELETE_FAILED');
      }
    },
  };
}

export function createCalendarWorkProjector(): OutboxHandler {
  return async (source) => {
    if (
      source.eventType !== 'BOOKING_APPROVED' ||
      source.payload.bookingId !== String(source.aggregateId)
    ) {
      throw new OutboxHandlerError('INVALID_APPROVAL_EVENT', false);
    }
    try {
      await OutboxEvent.updateOne(
        {
          eventType: 'CALENDAR_BOOKING_CREATE',
          aggregateType: 'BOOKING',
          aggregateId: source.aggregateId,
        },
        {
          $setOnInsert: {
            eventType: 'CALENDAR_BOOKING_CREATE',
            aggregateType: 'BOOKING',
            aggregateId: source.aggregateId,
            payload: {
              bookingId: source.payload.bookingId,
              occurredAt: source.payload.occurredAt,
              sourceEventId: String(source._id),
            },
            status: 'PENDING',
            availableAt: new Date(),
            attemptCount: 0,
            maxAttempts: source.maxAttempts,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 11000
      ))
        throw error;
      const existing = await OutboxEvent.exists({
        eventType: 'CALENDAR_BOOKING_CREATE',
        aggregateType: 'BOOKING',
        aggregateId: source.aggregateId,
      });
      if (!existing)
        throw new OutboxHandlerError('CALENDAR_WORK_UPSERT_FAILED', true);
    }
  };
}

export function createCalendarSyncHandler(
  gateway: CalendarGateway,
): OutboxHandler {
  return async (event: Readonly<OutboxEventRecord>) =>
    synchronizeBooking(event, gateway);
}

export function createCalendarDeleteHandler(
  gateway: CalendarGateway,
): OutboxHandler {
  return async (event) => {
    if (
      event.eventType !== 'CALENDAR_BOOKING_DELETE' ||
      event.payload.bookingId !== String(event.aggregateId)
    ) {
      throw new OutboxHandlerError('INVALID_CALENDAR_DELETE_WORK', false);
    }
    const booking = await Booking.findById(event.aggregateId).select(
      '+calendarEventId +calendarLastError',
    );
    if (!booking) throw new OutboxHandlerError('BOOKING_NOT_FOUND', false);
    if (booking.status !== 'CANCELLED')
      throw new OutboxHandlerError('BOOKING_NOT_CANCELLED', false);

    const bookingId = String(booking._id);
    const expectedId = deterministicEventId(bookingId);
    if (booking.calendarEventId && booking.calendarEventId !== expectedId)
      throw new OutboxHandlerError('CALENDAR_EVENT_ID_MISMATCH', false);
    try {
      await gateway.deleteEvent(expectedId);
      await Booking.updateOne(
        { _id: booking._id, status: 'CANCELLED' },
        {
          $set: {
            calendarSyncStatus: 'CANCELLED',
            calendarSyncedAt: null,
            calendarLastError: null,
            calendarEventId: expectedId,
          },
        },
      );
    } catch (error) {
      const classified =
        error instanceof OutboxHandlerError
          ? error
          : new OutboxHandlerError('GOOGLE_CALENDAR_TEMPORARY_FAILURE', true);
      await Booking.updateOne(
        { _id: booking._id, status: 'CANCELLED' },
        {
          $set: {
            calendarSyncStatus: 'CANCEL_FAILED',
            calendarLastError: classified.errorCode,
          },
        },
      ).catch(() => undefined);
      throw classified;
    }
  };
}

async function synchronizeBooking(
  event: Readonly<OutboxEventRecord>,
  gateway: CalendarGateway,
): Promise<void> {
  if (
    event.eventType !== 'CALENDAR_BOOKING_CREATE' ||
    event.payload.bookingId !== String(event.aggregateId)
  ) {
    throw new OutboxHandlerError('INVALID_CALENDAR_WORK', false);
  }
  const booking = await Booking.findById(event.aggregateId).select(
    '+calendarEventId +calendarLastError',
  );
  if (!booking) throw new OutboxHandlerError('BOOKING_NOT_FOUND', false);
  if (booking.status !== 'APPROVED')
    throw new OutboxHandlerError('BOOKING_NOT_APPROVED', false);
  const [room, requester] = await Promise.all([
    Room.findById(booking.room).select('name location'),
    User.findById(booking.requester).select('name email'),
  ]);
  if (!room) throw new OutboxHandlerError('ROOM_NOT_FOUND', false);
  if (!requester) throw new OutboxHandlerError('REQUESTER_NOT_FOUND', false);
  const bookingId = String(booking._id);
  const eventId = deterministicEventId(bookingId);
  if (booking.calendarEventId && booking.calendarEventId !== eventId) {
    await markSync(bookingId, 'FAILED', 'CALENDAR_EVENT_ID_MISMATCH');
    throw new OutboxHandlerError('CALENDAR_EVENT_ID_MISMATCH', false);
  }
  const expected: CalendarEvent = {
    id: eventId,
    summary: `Meeting - ${room.name}`,
    location: room.location,
    ...(booking.description ? { description: booking.description } : {}),
    start: {
      dateTime: calendarDateTime(booking.startAt, env.APP_TIMEZONE),
      timeZone: env.APP_TIMEZONE,
    },
    end: {
      dateTime: calendarDateTime(booking.endAt, env.APP_TIMEZONE),
      timeZone: env.APP_TIMEZONE,
    },
    attendees: deduplicateAttendees([
      { email: requester.email, displayName: requester.name },
      ...booking.guests.map((guest) => ({
        email: guest.email,
        ...(guest.name ? { displayName: guest.name } : {}),
      })),
    ]),
    extendedProperties: { private: { bookingId } },
  };
  try {
    let existing = await gateway.getEvent(eventId);
    if (existing) {
      verifyOwnership(existing, bookingId);
      if (!sameInstantSchedule(existing, expected)) {
        await gateway.updateEvent(eventId, expected);
      }
    } else {
      try {
        await gateway.createEvent(expected);
      } catch (error) {
        if (
          !(error instanceof OutboxHandlerError) ||
          error.errorCode !== 'GOOGLE_EVENT_ALREADY_EXISTS'
        )
          throw error;
        existing = await gateway.getEvent(eventId);
        if (!existing)
          throw new OutboxHandlerError(
            'GOOGLE_EVENT_CONFLICT_UNVERIFIED',
            true,
          );
        verifyOwnership(existing, bookingId);
        if (!sameInstantSchedule(existing, expected)) {
          await gateway.updateEvent(eventId, expected);
        }
      }
    }
    await markSync(bookingId, 'SYNCED', null, eventId);
  } catch (error) {
    const classified =
      error instanceof OutboxHandlerError
        ? error
        : new OutboxHandlerError('GOOGLE_CALENDAR_TEMPORARY_FAILURE', true);
    await markSync(
      bookingId,
      classified.retryable ? 'PENDING' : 'FAILED',
      classified.errorCode,
    ).catch(() => undefined);
    logger.warn(
      { bookingId, errorCode: classified.errorCode },
      'Calendar sync attempt failed',
    );
    throw classified;
  }
}

function deduplicateAttendees(
  values: Array<{ email: string; displayName?: string }>,
) {
  const attendees = new Map<string, { email: string; displayName?: string }>();
  for (const attendee of values)
    attendees.set(attendee.email.trim().toLowerCase(), {
      ...attendee,
      email: attendee.email.trim().toLowerCase(),
    });
  return [...attendees.values()];
}
function sameInstantSchedule(
  left: CalendarEvent,
  right: CalendarEvent,
): boolean {
  return (
    Date.parse(left.start.dateTime) === Date.parse(right.start.dateTime) &&
    Date.parse(left.end.dateTime) === Date.parse(right.end.dateTime)
  );
}
function verifyOwnership(event: CalendarEvent, bookingId: string): void {
  if (
    event.id !== deterministicEventId(bookingId) ||
    event.extendedProperties.private.bookingId !== bookingId
  ) {
    throw new OutboxHandlerError('GOOGLE_EVENT_OWNERSHIP_MISMATCH', false);
  }
}
async function markSync(
  bookingId: string,
  status: 'PENDING' | 'SYNCED' | 'FAILED',
  code: string | null,
  eventId?: string,
) {
  const update: Record<string, unknown> = {
    calendarSyncStatus: status,
    calendarSyncedAt: status === 'SYNCED' ? new Date() : null,
    calendarLastError: code,
  };
  if (eventId) update.calendarEventId = eventId;
  const result = await Booking.updateOne(
    { _id: bookingId, status: 'APPROVED' },
    { $set: update },
  );
  if (!result.matchedCount)
    throw new OutboxHandlerError('BOOKING_SYNC_STATE_WRITE_FAILED', true);
}
function fromGoogleEvent(event: ClientCalendarEvent): CalendarEvent | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;
  return {
    id: event.id,
    summary: event.summary ?? '',
    location: event.location ?? '',
    ...(event.description ? { description: event.description } : {}),
    start: {
      dateTime: event.start.dateTime,
      timeZone: event.start.timeZone ?? 'UTC',
    },
    end: {
      dateTime: event.end.dateTime,
      timeZone: event.end.timeZone ?? 'UTC',
    },
    attendees: (event.attendees ?? []).flatMap((person) =>
      person.email
        ? [
            {
              email: person.email,
              ...(person.displayName
                ? { displayName: person.displayName }
                : {}),
            },
          ]
        : [],
    ),
    extendedProperties: {
      private: {
        bookingId: event.extendedProperties?.private?.bookingId ?? '',
      },
    },
  };
}
function googleStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: number; response?: { status?: number } };
  return candidate.response?.status ?? candidate.code;
}
function classifyGoogleError(
  error: unknown,
  fallback: string,
): OutboxHandlerError {
  const status = googleStatus(error);
  if (status === 409)
    return new OutboxHandlerError('GOOGLE_EVENT_ALREADY_EXISTS', true);
  if (status === 429) {
    const headers =
      error && typeof error === 'object'
        ? (error as { response?: { headers?: Record<string, string> } })
            .response?.headers
        : undefined;
    const raw = headers?.['retry-after'];
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
    return new OutboxHandlerError(
      'GOOGLE_RATE_LIMITED',
      true,
      Math.min(seconds * 1000, 3_600_000),
    );
  }
  if (status === 401)
    return new OutboxHandlerError('GOOGLE_AUTHENTICATION_FAILED', false);
  if (status === 403)
    return new OutboxHandlerError('GOOGLE_PERMISSION_DENIED', false);
  if (status === 400)
    return new OutboxHandlerError('GOOGLE_INVALID_EVENT', false);
  if (status && status >= 500)
    return new OutboxHandlerError('GOOGLE_SERVER_ERROR', true);
  return new OutboxHandlerError(fallback, true);
}

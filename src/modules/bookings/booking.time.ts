import { DateTime } from 'luxon';
import { AppError } from '../../shared/errors/app-error.js';

export interface BookingWindow {
  today: string;
  maximumDate: string;
}

export function bookingWindow(now: Date, timezone: string): BookingWindow {
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  const lastDay = localNow.plus({ months: 1 });
  return { today: localNow.toISODate()!, maximumDate: lastDay.toISODate()! };
}

export function parseBookingInterval(
  date: string,
  startTime: string,
  endTime: string,
  timezone: string,
): { startAt: Date; endAt: Date } {
  const localStart = DateTime.fromFormat(
    `${date} ${startTime}`,
    'yyyy-MM-dd HH:mm',
    {
      zone: timezone,
      locale: 'en-US',
      setZone: true,
    },
  );
  const localEnd = DateTime.fromFormat(
    `${date} ${endTime}`,
    'yyyy-MM-dd HH:mm',
    {
      zone: timezone,
      locale: 'en-US',
      setZone: true,
    },
  );
  if (
    !localStart.isValid ||
    !localEnd.isValid ||
    localStart.toISODate() !== date ||
    localEnd.toISODate() !== date
  ) {
    throw new AppError(
      400,
      'INVALID_BOOKING_TIME',
      'Booking date or time is invalid in the configured timezone',
    );
  }
  // Reject nonexistent wall times shifted forward by Luxon across a DST gap.
  if (
    localStart.hour !== Number(startTime.slice(0, 2)) ||
    localStart.minute !== Number(startTime.slice(3)) ||
    localEnd.hour !== Number(endTime.slice(0, 2)) ||
    localEnd.minute !== Number(endTime.slice(3))
  ) {
    throw new AppError(
      400,
      'INVALID_BOOKING_TIME',
      'Local time does not exist in the configured timezone',
    );
  }
  if (localEnd.toMillis() <= localStart.toMillis()) {
    throw new AppError(
      400,
      'INVALID_BOOKING_TIME',
      'End time must be after start time on the same local date',
    );
  }
  return {
    startAt: localStart.toUTC().toJSDate(),
    endAt: localEnd.toUTC().toJSDate(),
  };
}

export function validateBookingDate(
  date: string,
  now: Date,
  timezone: string,
): void {
  const parsedDate = DateTime.fromFormat(date, 'yyyy-MM-dd', {
    zone: timezone,
    locale: 'en-US',
  });
  if (!parsedDate.isValid || parsedDate.toISODate() !== date) {
    throw new AppError(400, 'INVALID_BOOKING_TIME', 'Booking date is invalid');
  }
  const window = bookingWindow(now, timezone);
  if (date < window.today || date > window.maximumDate) {
    throw new AppError(
      400,
      'BOOKING_DATE_OUT_OF_RANGE',
      'Booking date is outside the allowed booking window',
    );
  }
}

export function validateFutureStart(startAt: Date, now: Date): void {
  if (startAt.getTime() <= now.getTime()) {
    throw new AppError(
      400,
      'BOOKING_IN_PAST',
      'Booking must start in the future',
    );
  }
}

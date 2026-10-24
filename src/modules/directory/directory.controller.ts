import type { RequestHandler } from 'express';
import { searchDirectory } from './directory.service.js';

export const search: RequestHandler = async (_req, res) => {
  const query = res.locals.validatedQuery.q as string;
  const people = await searchDirectory(query);
  res.json({ success: true, data: { people } });
};

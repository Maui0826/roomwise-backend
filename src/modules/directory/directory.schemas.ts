import { z } from 'zod';

export const directorySearchSchema = z
  .object({ q: z.string().trim().min(2).max(80) })
  .strict();

export type DirectorySearchQuery = z.infer<typeof directorySearchSchema>;

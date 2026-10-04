import { z } from 'zod';

/** Calendar date without time, e.g. 2026-10-12. */
export const isoDate = z.iso.date({ error: 'Enter a valid date' });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** ISO 8601 timestamp in UTC, e.g. 2026-10-12T09:30:00.000Z. */
export const isoDateTime = z.iso.datetime();

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Runtime schema for a `Paginated<T>` response, for clients that validate what they receive. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}

export interface HealthStatus {
  status: 'ok';
  service: string;
  timestamp: string;
}

/** Error body returned by the API for 4xx responses. */
export interface ApiError {
  statusCode: number;
  message: string;
  issues?: { path: string; message: string }[];
  /** Business-rule violations (e.g. leave problems), when the request was well-formed but not allowed. */
  problems?: { code: string; message: string }[];
  /** Machine-readable reason, e.g. PASSWORD_CHANGE_REQUIRED. */
  code?: string;
}

/** A login account, e.g. who requested or approved something. */
export const userRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});
export type UserRef = z.infer<typeof userRefSchema>;

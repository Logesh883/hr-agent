import { z } from 'zod';

/** Calendar date without time, e.g. 2026-10-12. */
export const isoDate = z.iso.date({ error: 'Enter a valid date' });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
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
}

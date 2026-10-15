/** API contracts: common. */
import { z } from 'zod';

/** Every mutating API request must carry this header (CSRF defence, see core auth). */
export const CSRF_HEADER = 'x-emberline-csrf';

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SystemStatus = z.object({
  version: z.string(),
  ptyd: z.enum(['connecting', 'connected', 'disconnected']),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

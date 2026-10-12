/** Public REST API contracts shared by core and web. Grows milestone by milestone. */
import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

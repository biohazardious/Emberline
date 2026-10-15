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

/**
 * Bumped when the REST/WebSocket contract changes incompatibly. The web bundle compares it with
 * core's to ask for a reload after an upgrade instead of failing on changed payloads.
 */
export const API_VERSION = 1;

export const SystemStatus = z.object({
  version: z.string(),
  apiVersion: z.number().int(),
  ptyd: z.enum(['connecting', 'connected', 'disconnected']),
  /** True when the connected runner speaks an older ptyd protocol than this core needs. */
  runnerOutdated: z.boolean(),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/**
 * A branch name that git accepts and that can never be read as an option (S19): no leading `-`,
 * no `..`, `//`, `@{`, trailing `/` or `.lock` (see git-check-ref-format).
 */
export const GitBranchName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, 'branch names may contain letters, digits, ".", "_", "/" and "-"')
  .refine(
    (name) =>
      !name.startsWith('-') &&
      !name.startsWith('/') &&
      !name.startsWith('.') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.endsWith('.lock') &&
      !name.includes('..') &&
      !name.includes('//') &&
      !name.includes('/.'),
    'not a valid git branch name',
  );

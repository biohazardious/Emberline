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

/** The opt-in Docker engine sidecar (compose profile `docker`), as core's last probe saw it. */
export const DockerEngineStatus = z.object({
  /** `EMBERLINE_DOCKER_HOST` is set; false = Docker is off. */
  enabled: z.boolean(),
  /** The engine answered the last probe; runs get `DOCKER_HOST` only then. */
  available: z.boolean(),
  /** The engine's server version, while available. */
  version: z.string().nullable(),
  /** Why an enabled engine is unavailable (CLI output, one line). */
  error: z.string().optional(),
});
export type DockerEngineStatus = z.infer<typeof DockerEngineStatus>;

export const SystemStatus = z.object({
  version: z.string(),
  apiVersion: z.number().int(),
  ptyd: z.enum(['connecting', 'connected', 'disconnected']),
  /** True when the connected runner speaks an older ptyd protocol than this core needs (PTYD_MIN_PROTOCOL_VERSION). */
  runnerOutdated: z.boolean(),
  /** The runner works but is older than PTYD_PROTOCOL_VERSION: an update brings extras, nothing breaks. */
  runnerUpdateAvailable: z.boolean(),
  docker: DockerEngineStatus,
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

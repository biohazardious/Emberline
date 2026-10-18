/** API contracts: per-worktree preview environments (Phase 2.3). */
import { z } from 'zod';

/**
 * A run's preview. `command` previews run a dev server in the runner (a terminal); `compose`
 * previews (worktree.yml v2) start a service of the project's compose file in the Docker engine,
 * which takes a while: `starting` until the service answers HTTP, else `failed`.
 */
export const RunPreviewStatus = z.object({
  runId: z.string(),
  status: z.enum(['stopped', 'starting', 'running', 'exited', 'failed']),
  kind: z.enum(['command', 'compose']),
  terminalId: z.string().nullable(),
  command: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  detectedCommand: z.string().nullable(),
  /** Why a compose preview failed or stopped (Emberline's own words). */
  error: z.string().nullable(),
  /** The end of the build or container output (at most 2000 chars): untrusted, show it as text. */
  logs: z.string().nullable(),
  /** Why the preview is not the configured one, e.g. "compose.yaml not found yet — previewing dev". */
  note: z.string().optional(),
});
export type RunPreviewStatus = z.infer<typeof RunPreviewStatus>;

export const StartPreviewBody = z.object({
  command: z.string().trim().min(1).max(500).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
});
export type StartPreviewBody = z.input<typeof StartPreviewBody>;

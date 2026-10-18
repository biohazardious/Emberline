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

/**
 * The container preview of a project's main workspace: always a compose preview (the approved
 * worktree.yml's compose preview service, started from main in project `emberline-main-<p8>-preview`).
 * The same shape as a run's, with `runId` null and `targetId` 'main'.
 */
export const MainPreviewStatus = RunPreviewStatus.extend({
  runId: z.null(),
  targetId: z.literal('main'),
  /**
   * Why main cannot have a container preview now (no compose preview service approved, the Docker
   * engine is off or does not answer, the compose file is not in main yet); absent when it can.
   */
  unavailable: z.string().optional(),
});
export type MainPreviewStatus = z.infer<typeof MainPreviewStatus>;

/**
 * Where the runner's browser (Live Browser, agents' Playwright) opens a target's preview, as the
 * runner sees it: `compose` a running container preview on the engine's host; `command` a running
 * dev server in the runner (localhost there); `static` the token demo URL on core, or null when the
 * target has no demo entry yet.
 */
export const BrowserUrlKind = z.enum(['compose', 'command', 'static']);
export type BrowserUrlKind = z.infer<typeof BrowserUrlKind>;

export const BrowserUrlResponse = z.object({
  url: z.string().nullable(),
  kind: BrowserUrlKind,
  /** Why it is not the container preview, or why there is no URL (Emberline's words). */
  note: z.string().optional(),
});
export type BrowserUrlResponse = z.infer<typeof BrowserUrlResponse>;

/**
 * The `preview` tool of a run's agent (`emberline-mcp`): `POST /api/internal/runs/:id/preview`
 * with the run's hook token. `restart` starts the preview again even when it runs (it then serves
 * the worktree as it is now).
 */
export const AgentPreviewBody = z.object({ restart: z.boolean().optional() });
export type AgentPreviewBody = z.infer<typeof AgentPreviewBody>;

/**
 * What the tool answers: the run's preview `status` once it is running or failed (or still
 * `starting` when the wait ran out), `unavailable` when this run cannot have one (no engine for its
 * container preview, no preview service or dev script). `url` and `kind` are the runner-side URL
 * (as in {@link BrowserUrlResponse}): the preview when it runs, else this run's static build or null.
 */
export const AgentPreviewResponse = z.object({
  status: z.enum(['stopped', 'starting', 'running', 'exited', 'failed', 'unavailable']),
  url: z.string().nullable(),
  kind: BrowserUrlKind,
  error: z.string().optional(),
  /** The end of the build or container output (untrusted). */
  logs: z.string().optional(),
  note: z.string().optional(),
});
export type AgentPreviewResponse = z.infer<typeof AgentPreviewResponse>;

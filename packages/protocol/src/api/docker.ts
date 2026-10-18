/**
 * API contracts: the Docker page. What Emberline runs in the opt-in Docker engine sidecar (only
 * the compose projects whose names Emberline makes), its disk use and cleanup state, and the
 * actions a person takes on a project.
 */
import { z } from 'zod';
import { DockerEngineStatus } from './common.js';
import { RunState } from './runs.js';

export const DockerOwnerKind = z.enum(['agent', 'preview', 'main', 'orphan']);
export type DockerOwnerKind = z.infer<typeof DockerOwnerKind>;

/** The run a project belongs to (an agent's project, or a run's preview project). */
const DockerRunOwnerFields = {
  runId: z.string(),
  /** The run's display title (e.g. "SHOP-1 Login"); null for ad-hoc runs. */
  runTitle: z.string().nullable(),
  ticketId: z.string().nullable(),
  ticketKey: z.string().nullable(),
  ticketTitle: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  runState: RunState,
  /** The run's agent is alive (or rate limited, waiting for its window). */
  live: z.boolean(),
  /** The run ended and kept its worktree (it waits in Review). */
  inReview: z.boolean(),
};

/**
 * Who a project belongs to. `agent`: a run's own project (`emberline-<id8>`, shared by handoff
 * successors in the same worktree; the newest live run, else the newest). `preview`: a run's preview
 * project. `main`: Build & Verify on a project's main workspace. `orphan`: nothing in Emberline uses
 * it any more; the next cleanup removes it.
 */
export const DockerProjectOwner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), ...DockerRunOwnerFields }),
  z.object({ kind: z.literal('preview'), ...DockerRunOwnerFields }),
  z.object({ kind: z.literal('main'), projectId: z.string(), projectName: z.string() }),
  z.object({ kind: z.literal('orphan') }),
]);
export type DockerProjectOwner = z.infer<typeof DockerProjectOwner>;

/** Docker's container states; anything else Docker prints (`removing`) is `unknown`. */
export const DockerContainerState = z.enum([
  'running',
  'exited',
  'created',
  'restarting',
  'paused',
  'dead',
  'unknown',
]);
export type DockerContainerState = z.infer<typeof DockerContainerState>;

export const DockerContainer = z.object({
  name: z.string(),
  /** The compose service (label `com.docker.compose.service`). */
  service: z.string().nullable(),
  state: DockerContainerState,
  /** Docker's status text, e.g. "Up 2 hours", "Exited (1) 3 minutes ago". */
  status: z.string(),
  /** Published host ports (unique, ascending). */
  ports: z.array(z.number().int()),
  image: z.string(),
  /** As Docker prints them: "2026-10-18 08:00:00 +0000 UTC", "2 hours ago". */
  createdAt: z.string(),
  runningFor: z.string(),
});
export type DockerContainer = z.infer<typeof DockerContainer>;

export const DockerProject = z.object({
  name: z.string(),
  /** `compose ls` status, e.g. "running(2)", "exited(1)"; null when compose did not list it. */
  status: z.string().nullable(),
  owner: DockerProjectOwner,
  containers: z.array(DockerContainer),
  /** The next cleanup removes it (always true for an `orphan`, false otherwise). */
  stale: z.boolean(),
});
export type DockerProject = z.infer<typeof DockerProject>;

/** One row of `docker system df`, values as Docker prints them. */
export const DockerDiskRow = z.object({
  /** `Images`, `Containers`, `Local Volumes`, `Build Cache`. */
  type: z.string(),
  total: z.string(),
  active: z.string(),
  size: z.string(),
  /** e.g. "1.2GB (50%)". */
  reclaimable: z.string(),
});
export type DockerDiskRow = z.infer<typeof DockerDiskRow>;

export const DockerCleanupState = z.object({
  /** When the last sweep (scheduled or "Clean up now") listed the engine; null before the first one. */
  lastSweepAt: z.string().nullable(),
  /** The projects that sweep removed. */
  lastSweepRemoved: z.array(z.string()),
  /** When images and build cache were last pruned; null before the first prune. */
  lastPruneAt: z.string().nullable(),
  /** A sweep is running now. */
  sweeping: z.boolean(),
});
export type DockerCleanupState = z.infer<typeof DockerCleanupState>;

/**
 * `GET /api/docker`. With the engine off: `engine.enabled` false and empty lists. A failed docker
 * call never fails the request: each part carries its own error and the rest still lists.
 */
export const DockerOverview = z.object({
  engine: DockerEngineStatus,
  disk: z.object({ rows: z.array(DockerDiskRow), error: z.string().optional() }),
  cleanup: DockerCleanupState,
  projects: z.array(DockerProject),
  /** `docker compose ls` failed or printed something unexpected (projects then come from containers only). */
  projectsError: z.string().optional(),
  /** `docker ps` failed or printed something unexpected (projects then have no containers). */
  containersError: z.string().optional(),
  /** The engine is enabled but does not answer: nothing could be listed. */
  error: z.string().optional(),
});
export type DockerOverview = z.infer<typeof DockerOverview>;

/** `POST /api/docker/projects/:name/stop` and `.../remove`. */
export const DockerProjectActionResponse = z.object({
  project: z.string(),
  action: z.enum(['stop', 'remove']),
  owner: DockerProjectOwner,
  /** Said when the project belongs to a live agent ("The agent of SHOP-1 is running and may be using it."). */
  warning: z.string().nullable(),
});
export type DockerProjectActionResponse = z.infer<typeof DockerProjectActionResponse>;

/** `GET /api/docker/projects/:name/logs?service=<svc>`. */
export const DockerProjectLogsResponse = z.object({
  project: z.string(),
  /** The service asked for; null = every service of the project. */
  service: z.string().nullable(),
  /** The end of `docker compose logs` (at most 2000 chars, no control sequences): untrusted, show it as text. */
  logs: z.string(),
});
export type DockerProjectLogsResponse = z.infer<typeof DockerProjectLogsResponse>;

/**
 * `POST /api/docker/cleanup`: the sweep ran now, with the image and build cache prune. When the
 * engine could not be listed (`listed` false) nothing was removed, the prune still ran, and `error`
 * says why (still 200).
 */
export const DockerCleanupResponse = z.object({
  /** The leftover projects taken down. */
  removed: z.array(z.string()),
  /** `docker compose ls` answered, so leftovers could be looked for. */
  listed: z.boolean(),
  /** The image and build cache prune ran and succeeded. */
  pruned: z.boolean(),
  /** Why the listing failed (Emberline's words plus the CLI output tail, one line). */
  error: z.string().optional(),
});
export type DockerCleanupResponse = z.infer<typeof DockerCleanupResponse>;

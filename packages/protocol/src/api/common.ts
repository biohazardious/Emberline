/** API contracts: common. */
import { z } from 'zod';

/**
 * Every mutating API request must carry this header (CSRF defence, see core auth). Signed in, its
 * value is the per-login key from `SessionIssued.sessionKey`; before that, any non-empty value.
 */
export const CSRF_HEADER = 'x-emberline-csrf';
/** The WebSocket subprotocol core accepts and echoes. */
export const WS_PROTOCOL = 'emberline';
/** A WebSocket carries the per-login key as the extra subprotocol `emberline.key.<key>` (never in its URL). */
export const SESSION_KEY_PROTOCOL_PREFIX = 'emberline.key.';

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
  /**
   * Why the runner cannot be used, when core knows (core itself is fine: `status` stays `ok`).
   * `not_answering`: core has not reached the runner for longer than a restart takes.
   */
  runnerProblem: z.enum(['not_answering']).optional(),
  /** What to tell the person about `runnerProblem`. */
  runnerMessage: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * Bumped when the REST/WebSocket contract changes incompatibly. The web bundle compares it with
 * core's to ask for a reload after an upgrade instead of failing on changed payloads.
 * 2 (0.5.0): changes and live connections need the per-login key, which older bundles never send.
 */
export const API_VERSION = 2;

/** The Docker engine sidecar (compose service `docker`, on unless `EMBERLINE_DOCKER_ENGINE=0`), as core's last probe saw it. */
export const DockerEngineStatus = z.object({
  /** The engine is switched on (`EMBERLINE_DOCKER_HOST` set, `EMBERLINE_DOCKER_ENGINE` not `0`); false = Docker is off. */
  enabled: z.boolean(),
  /** The first probe has answered; until then the engine's state is unknown ("checking"). */
  checked: z.boolean(),
  /** The engine answered the last probe; runs get `DOCKER_HOST` only then. */
  available: z.boolean(),
  /** The engine's server version, while available. */
  version: z.string().nullable(),
  /** Why an enabled engine is unavailable (CLI output, one line). */
  error: z.string().optional(),
  /**
   * Why the engine is not enabled; absent while it is. `switched_off`: `EMBERLINE_DOCKER_ENGINE=0`.
   * `not_configured`: core has no `EMBERLINE_DOCKER_HOST` (a compose file older than 0.3.5, or dev).
   */
  reason: z.enum(['switched_off', 'not_configured']).optional(),
});
export type DockerEngineStatus = z.infer<typeof DockerEngineStatus>;

export const SystemStatus = z.object({
  version: z.string(),
  apiVersion: z.number().int(),
  ptyd: z.enum(['connecting', 'connected', 'disconnected']),
  /**
   * True when the connected runner speaks an older ptyd protocol than this core needs
   * (PTYD_MIN_PROTOCOL_VERSION): a security update of the runner image is required, and until then
   * core starts no agent and runs no command in the runner.
   */
  runnerOutdated: z.boolean(),
  /** The runner works but is older than PTYD_PROTOCOL_VERSION: an update brings extras, nothing breaks. */
  runnerUpdateAvailable: z.boolean(),
  /**
   * The connected runner is current but its service socket is not locked (it was started as another
   * user than root, or its start has not finished): core starts no agent and runs no command in it.
   */
  runnerNotSecured: z.boolean(),
  /** The runner is connected but still securing its service socket: nothing starts yet, for a few seconds. */
  runnerStarting: z.boolean(),
  /**
   * `not_answering`: core has not reached the runner for longer than a restart takes (stopped,
   * crashing, or started as another user than root). Null otherwise.
   */
  runnerProblem: z.enum(['not_answering']).nullable(),
  /**
   * The runner's host lets any process trace another of its user (Yama `ptrace_scope` 0, or no
   * Yama): agents could take over the runner's own service. False while unknown.
   */
  runnerPtraceUnrestricted: z.boolean(),
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

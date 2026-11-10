import { MATERIALS_ERROR_CODE } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Errors thrown from route handlers; rendered as `{ error, message }` with the given status, plus
 * any `details` fields.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);
/** What a request says when the runner cannot run its command. */
export const RUNNER_NOT_REACHABLE = 'the runner (ptyd) is not reachable';

/**
 * A runner image older than this core (ptyd protocol below PTYD_MIN_PROTOCOL_VERSION): until it is
 * updated, core starts no agent and runs no command in it (see PtydBridge).
 */
export const RUNNER_SECURITY_UPDATE =
  'Security update required: update the runner image. This Emberline needs the runner image of the same release, and until it is updated it starts no agent and runs no command in the runner. From source, run `make up`; with the published images, `docker compose pull && docker compose up -d`.';
export const runnerOutdated = () => unavailable('runner_outdated', RUNNER_SECURITY_UPDATE);

/**
 * A current runner whose `hello` says it is not secured (ptyd runs as the agents' own user, or cannot
 * start what it runs as them): agents could reach its socket, so core starts nothing in it.
 */
export const RUNNER_NOT_SECURED =
  "Runner not secured: the runner's service does not run apart from the coding agents, so an agent could reach it, and Emberline starts no agent and runs no command in the runner. Restart the runner (`make up`, or `docker compose up -d`) and see why in its log (`docker compose logs runner`).";
export const runnerNotSecured = () => unavailable('runner_not_secured', RUNNER_NOT_SECURED);

/**
 * Core has not reached the runner for longer than a restart takes (PtydBridge.startProblem): true for
 * a stopped or crashing runner, and for one started as another user (`user:` in the compose file),
 * which stops at once because its service cannot listen; its log says to remove `user:`.
 */
export const RUNNER_NOT_ANSWERING =
  'The runner has not answered for a while. See why with `docker compose logs runner`. A runner started as another user (`user:` in the compose file) stops at once, and its log says so: remove `user:` and start it again.';

/** Where the upgrade notes are: what a compose file of this release adds (the `ops` service). */
export const UPGRADE_NOTES_URL = 'https://github.com/biohazardious/Emberline/blob/main/CHANGELOG.md';

/**
 * Core's own commands run in the `ops` container (a ptyd in ops mode), and the compose file has no such
 * service, or it does not answer as one: core starts nothing anywhere until it does (see PtydBridge).
 */
export const OPS_MISSING = `Update the compose file: the \`ops\` service is missing. Emberline runs its own commands (git, merges, the Docker CLI) in it, and until it answers Emberline starts no agent and runs no command. See the upgrade notes: ${UPGRADE_NOTES_URL}`;
export const opsMissing = () => unavailable('ops_missing', OPS_MISSING);

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      // Reference files and links get a plain sentence and the code the wizard shows next to the area.
      const first = error.issues[0];
      if (first && error.issues.every((i) => i.path[0] === 'materials' || i.path[0] === 'referenceUrls')) {
        return reply.code(400).send({
          error: MATERIALS_ERROR_CODE,
          field: first.path[0] === 'referenceUrls' ? 'links' : 'files',
          message: first.message,
        });
      }
      return reply.code(400).send({ error: 'bad_request', message: z.prettifyError(error) });
    }
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ ...error.details, error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal', message: 'internal server error' });
  });
}

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

/** A current runner whose service socket is not locked (see PtydBridge): core starts nothing in it. */
export const RUNNER_NOT_SECURED =
  "Runner not secured: the runner has not locked its service's socket, so a coding agent could stand in for it, and Emberline starts no agent and runs no command in the runner. The runner locks it as it starts, as root: if it was started as another user (`user:` in the compose file), remove that and restart it (`make up`, or `docker compose up -d`); otherwise restart it and see its log.";
export const runnerNotSecured = () => unavailable('runner_not_secured', RUNNER_NOT_SECURED);

/** A runner that has just started and not locked its socket yet: nothing starts for a few seconds. */
export const RUNNER_STARTING =
  'The runner is starting: it is securing its service, and Emberline starts nothing in it until then. Try again in a few seconds.';
export const runnerStarting = () => unavailable('runner_starting', RUNNER_STARTING);

/** The runner runs as another user than root on a socket folder an earlier start locked (PtydBridge.startProblem). */
/** Core has not reached the runner for longer than a restart takes (PtydBridge.startProblem). */
export const RUNNER_NOT_ANSWERING =
  'The runner has not answered for a while. See why with `docker compose logs runner`. If the runner service sets `user:` in the compose file, remove it: the runner must start as root.';

export const RUNNER_MUST_START_AS_ROOT =
  'Runner cannot start: it must start as root to secure its service socket. Remove `user:` from the runner service in the compose file, then start it again (`make up`, or `docker compose up -d`).';

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

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

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
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'bad_request', message: z.prettifyError(error) });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ ...error.details, error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal', message: 'internal server error' });
  });
}

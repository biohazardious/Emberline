import type { ReviewComment, Run, RunReviewState } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { ReviewService } from '../review/service.js';

export function registerReviewRoutes(app: FastifyInstance, review: ReviewService): void {
  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/review',
    async (request): Promise<RunReviewState> => await review.state(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/review/comments',
    async (request, reply): Promise<ReviewComment> => {
      const comment = await review.addComment(request.params.id, request.body);
      reply.code(201);
      return comment;
    },
  );
  app.patch<{ Params: { id: string; commentId: string } }>(
    '/api/runs/:id/review/comments/:commentId',
    async (request): Promise<ReviewComment> =>
      await review.updateComment(request.params.id, request.params.commentId, request.body),
  );
  app.delete<{ Params: { id: string; commentId: string } }>(
    '/api/runs/:id/review/comments/:commentId',
    async (request, reply) => {
      review.deleteComment(request.params.id, request.params.commentId);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/review/request-changes',
    async (request): Promise<{ run: Run; sent: number }> => review.requestChanges(request.params.id, request.body),
  );
  app.put<{ Params: { id: string } }>(
    '/api/runs/:id/review/viewed',
    async (request): Promise<RunReviewState> => await review.markViewed(request.params.id, request.body),
  );
}

import type { ForgeIssueListResponse, ImportIssuesResponse, IssueSyncResponse } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { IssueImportService } from '../tickets/issue-import.js';

export function registerIssueRoutes(app: FastifyInstance, issues: IssueImportService): void {
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/issues',
    async (request): Promise<ForgeIssueListResponse> => issues.list(request.params.id, request.query),
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/issues/import',
    async (request): Promise<ImportIssuesResponse> => issues.import(request.params.id, request.body),
  );

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/issue-sync',
    async (request): Promise<IssueSyncResponse> => issues.getSync(request.params.id),
  );

  app.patch<{ Params: { id: string } }>(
    '/api/projects/:id/issue-sync',
    async (request): Promise<IssueSyncResponse> => issues.updateSync(request.params.id, request.body),
  );
}

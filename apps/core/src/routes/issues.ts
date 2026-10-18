import type { ForgeIssueListResponse, ImportIssuesResponse, IssueSyncResponse, IssueSyncStatus } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { IssueSyncService } from '../forge/issue-sync.js';
import type { IssueImportService } from '../tickets/issue-import.js';

export function registerIssueRoutes(app: FastifyInstance, issues: IssueImportService, sync: IssueSyncService): void {
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

  // "Sync now": one label sync pass for the project; answers with its sync status.
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/issue-sync/run',
    async (request): Promise<IssueSyncStatus> => sync.syncNow(request.params.id),
  );
}

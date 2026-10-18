import {
  type AgentPreviewResponse,
  DiffScope,
  GitCommitBody,
  type GitCommitResponse,
  type GitPushResponse,
  GitStageBody,
  HandoffBody,
  HookEnvelope,
  type PruneWorktreeResponse,
  ResumeRunBody,
  type Run,
  type RunArtifact,
  type RunBuildOutputsResponse,
  type RunDetail,
  type RunDiffSummary,
  type RunFileDiff,
  type TicketCompleteBody,
  TicketPromptBody,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import { contentDisposition, UNTRUSTED_CONTENT_CSP } from '../security-headers.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

/** Hook payloads can carry large tool inputs; core keeps only a summary. */
const HOOK_BODY_LIMIT = 8 * 1024 * 1024;

export function registerRunRoutes(app: FastifyInstance, runs: RunService, scheduler: Scheduler): void {
  app.get('/api/runs', async (): Promise<Run[]> => runs.list());

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request): Promise<RunDetail> => runs.get(request.params.id));

  /** Queues the run; it starts right away when a slot and quota are available. */
  app.post('/api/runs', async (request, reply): Promise<Run> => {
    const run = await scheduler.submit(request.body as never);
    reply.code(201);
    return run;
  });

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/runs/:id/screen-text',
    async (request): Promise<{ text: string | null }> => ({
      text: await runs.screenText(request.params.id, Math.min(80, Math.max(1, Number(request.query.lines ?? 24) || 24))),
    }),
  );

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (request): Promise<Run> => runs.stop(request.params.id));

  /** Manual resume (ignores the quota pause): live session gets a prompt, ended ones `--resume`. */
  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (request): Promise<Run> => {
    const { text } = ResumeRunBody.parse(request.body ?? {});
    return runs.resume(request.params.id, text || undefined);
  });

  /** Continues a waiting run on another provider/model in the same worktree. */
  app.post<{ Params: { id: string } }>('/api/runs/:id/handoff', async (request, reply): Promise<Run> => {
    const { route } = HandoffBody.parse(request.body ?? {});
    const run = await scheduler.handOff(request.params.id, route);
    reply.code(201);
    return run;
  });

  /** Sends a follow-up prompt into a live run (or resumes an ended session with that prompt). */
  app.post<{ Params: { id: string } }>('/api/runs/:id/prompt', async (request): Promise<Run> => {
    const { text } = TicketPromptBody.parse(request.body);
    return runs.prompt(request.params.id, text);
  });

  /** Per-run git diff summary against base branch (`branch`), `unstaged`, or `staged`. */
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/api/runs/:id/diff',
    async (request): Promise<RunDiffSummary> => {
      const scope = request.query.scope ? DiffScope.parse(request.query.scope) : 'branch';
      return runs.diff(request.params.id, scope);
    },
  );

  /** Full original/modified contents and patch for a single file in the run's worktree. */
  app.get<{ Params: { id: string }; Querystring: { path?: string; scope?: string } }>(
    '/api/runs/:id/diff/file',
    async (request): Promise<RunFileDiff> => {
      if (!request.query.path) throw badRequest('query parameter "path" is required');
      const scope = request.query.scope ? DiffScope.parse(request.query.scope) : 'branch';
      return runs.fileDiff(request.params.id, request.query.path, scope);
    },
  );

  app.post<{ Params: { id: string } }>('/api/runs/:id/git/stage', async (request): Promise<RunDiffSummary> => {
    const body = GitStageBody.parse(request.body ?? {});
    return runs.stage(request.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/git/commit', async (request): Promise<GitCommitResponse> => {
    const body = GitCommitBody.parse(request.body ?? {});
    return runs.commit(request.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/git/push', async (request): Promise<GitPushResponse> => {
    return runs.push(request.params.id);
  });

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/artifacts',
    async (request): Promise<RunArtifact[]> => runs.artifacts(request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/runs/:id/artifacts/raw',
    async (request, reply) => {
      if (!request.query.path) throw badRequest('query parameter "path" is required');
      const { buffer, contentType, fileName } = await runs.readArtifact(request.params.id, request.query.path);
      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', contentDisposition('inline', fileName));
      // Agent-written HTML/SVG must not run with the Emberline origin.
      reply.header('Content-Security-Policy', UNTRUSTED_CONTENT_CSP);
      return reply.send(buffer);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/build-outputs',
    async (request): Promise<RunBuildOutputsResponse> => runs.buildOutputs(request.params.id),
  );

  /** Streams a build output (APKs can be hundreds of MB) as a download, never inline. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/runs/:id/build-outputs/download',
    async (request, reply) => {
      if (!request.query.path) throw badRequest('query parameter "path" is required');
      const { stream, fileName, size } = await runs.openBuildOutput(request.params.id, request.query.path);
      try {
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Length', String(size));
        reply.header('Content-Disposition', contentDisposition('attachment', fileName));
        reply.header('Content-Security-Policy', UNTRUSTED_CONTENT_CSP);
      } catch (error) {
        stream.destroy();
        throw error;
      }
      return reply.send(stream);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/worktree/prune',
    async (request): Promise<PruneWorktreeResponse> => runs.pruneWorktree(request.params.id, (request.body ?? {}) as never),
  );

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/preview',
    async (request) => runs.previewStatus(request.params.id, request.host),
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/preview/start',
    async (request) => runs.startPreview(request.params.id, request.body ?? {}, request.host),
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/preview/stop',
    async (request) => runs.stopPreview(request.params.id, request.host),
  );

  app.post('/api/runs/gc', async (request) => {
    return runs.garbageCollect((request.body ?? {}) as never);
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    await runs.remove(request.params.id);
    return { ok: true };
  });

  /**
   * Called by `emberline-hook` inside the runner. Exempt from cookie/CSRF auth (see auth
   * plugin); authenticated by the per-run bearer token instead.
   */
  app.post('/api/internal/hooks', { bodyLimit: HOOK_BODY_LIMIT }, async (request) => {
    const envelope = HookEnvelope.parse(request.body);
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const run = runs.ingestHook(envelope, token);
    return { ok: true, state: run.state };
  });

  /** The agent's `ticket_complete` MCP tool; same per-run bearer token as the hooks. */
  app.post<{ Params: { id: string } }>('/api/internal/runs/:id/complete', { bodyLimit: HOOK_BODY_LIMIT }, async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    runs.recordCompletion(request.params.id, token, request.body as TicketCompleteBody);
    return { ok: true };
  });

  /**
   * The agent's `preview` tool (`emberline-mcp`): starts this run's own preview if needed and answers
   * its runner-side URL. Same per-run bearer token; the run is the token's, never one from the body.
   */
  app.post<{ Params: { id: string } }>('/api/internal/runs/:id/preview', async (request): Promise<AgentPreviewResponse> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return runs.agentPreview(request.params.id, token, request.body);
  });

  /** `emberline-mcp` checks in on startup: this run's agent has the `ticket_complete` tool. No body. */
  app.post<{ Params: { id: string } }>('/api/internal/runs/:id/completion-tool', async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    runs.recordCompletionToolReady(request.params.id, token);
    return { ok: true };
  });
}

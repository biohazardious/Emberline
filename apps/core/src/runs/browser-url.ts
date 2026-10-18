/**
 * Where the runner's browser opens a target's preview (Live Browser, an agent's preview tool), as
 * the runner sees it. It runs on the compose network, so a container preview answers on the
 * engine's name at its published port, a command preview on the runner's own localhost, and core at
 * `config.hookUrl`. Never the browser-facing URL (`previewUrl`) and never `localhost:7420`.
 */
import type { BrowserUrlResponse, RunPreviewStatus } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { projects, runs } from '../db/schema.js';
import { AGENT_DEMO_TOKEN_TTL_MS, DemoTokens, demoBasePath } from '../demo-token.js';
import { engineHostName } from '../docker/compose.js';
import { badRequest, notFound } from '../errors.js';
import { detectDemoEntryRelPath } from '../factory/workspace-status.js';
import type { MainPreviews } from './main-preview.js';

export interface BrowserUrlDeps {
  db: Db;
  config: Pick<CoreConfig, 'hookUrl' | 'dockerHost'>;
  /** Run previews' status (RunService.previewStatus). */
  runPreviewStatus: (runId: string) => Promise<RunPreviewStatus>;
  mainPreviews: Pick<MainPreviews, 'status'>;
  /** Mints the agent demo token; a fresh one on the same database when omitted. */
  demoTokens?: DemoTokens;
}

/**
 * The runner-side URL of `target` ('main' or a run id of the project): a running compose preview →
 * `http://<engine host>:<port>/`; a running command preview of a run → `http://localhost:<port>/`;
 * otherwise the token demo URL `${hookUrl}/api/demo/<token>/` (7-day agent token), or `url: null`
 * when the target has no demo entry. 400 without a target, 404 for an unknown project or a run
 * that is not one of the project's.
 */
export async function resolveBrowserUrl(deps: BrowserUrlDeps, projectId: string, target: string | undefined): Promise<BrowserUrlResponse> {
  if (!target) throw badRequest('target is required: main or a run id of this project');
  const project = deps.db.select({ id: projects.id, path: projects.path }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw notFound('no such project');
  let workspacePath = project.path;
  let preview: Pick<RunPreviewStatus, 'status' | 'kind' | 'port'>;
  if (target === 'main') {
    preview = await deps.mainPreviews.status(project.id);
  } else {
    const run = deps.db.select({ projectId: runs.projectId, worktreePath: runs.worktreePath }).from(runs).where(eq(runs.id, target)).get();
    if (!run || run.projectId !== project.id) throw notFound('no such run in this project');
    workspacePath = run.worktreePath;
    preview = await deps.runPreviewStatus(target);
  }

  if (preview.status === 'running' && preview.port) {
    if (preview.kind === 'compose') return { url: `http://${engineHostName(deps.config.dockerHost ?? '')}:${preview.port}/`, kind: 'compose' };
    return { url: `http://localhost:${preview.port}/`, kind: 'command' };
  }

  const note =
    preview.kind === 'compose' && preview.status === 'starting'
      ? 'the container preview is still starting; this is the static build'
      : undefined;
  if (!(await detectDemoEntryRelPath(workspacePath))) {
    return { url: null, kind: 'static', note: note ?? 'no preview is running and there is no demo build yet: run Build & Verify' };
  }
  const tokens = deps.demoTokens ?? new DemoTokens(deps.db);
  const url = `${deps.config.hookUrl}${demoBasePath(tokens.mint({ projectId: project.id, targetId: target }, AGENT_DEMO_TOKEN_TTL_MS))}`;
  return { url, kind: 'static', ...(note ? { note } : {}) };
}

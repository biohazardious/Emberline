/**
 * The `preview` tool of a run's agent (`emberline-mcp` → `POST /api/internal/runs/:id/preview`):
 * starts the run's own preview when it does not run (the normal start: compose or command per the
 * approved worktree.yml, with its fallback), waits for a container start to end, and answers the
 * URL the runner's browser opens (runs/browser-url.ts). A run that cannot have a preview gets
 * `unavailable` with the reason, never an error status. RunService authenticates the run first.
 */
import type { AgentPreviewBody, AgentPreviewResponse, BrowserUrlResponse, RunPreviewStatus } from '@emberline/protocol';
import { HttpError } from '../errors.js';

/**
 * How long one tool call waits for a container preview to come up. The readiness checks alone may
 * take the compose preview's `readyTimeoutMs` (2 min) after `up`, and `up --build` builds first;
 * 5 min covers a typical build plus readiness while staying one reasonable tool call. A longer
 * build answers `starting`, and the agent calls the tool again (it then waits for the same start).
 */
export const AGENT_PREVIEW_WAIT_MS = 5 * 60_000;

export interface AgentPreviewDeps {
  /** The run's preview now (RunService.previewStatus). */
  status(): Promise<RunPreviewStatus>;
  /** The normal start (RunService.startPreview with an empty body). */
  start(): Promise<RunPreviewStatus>;
  /** The background container start still going, if any (it settles once its outcome is recorded). */
  pendingStart(): Promise<unknown> | undefined;
  /** Why the run has nothing to preview at all, or null when it has (a preview service or a dev script). */
  nothingToPreview(): string | null;
  /** The runner-side URL of the run (resolveBrowserUrl for the run's id). */
  browserUrl(): Promise<BrowserUrlResponse>;
  waitMs: number;
}

const needsStart = (status: RunPreviewStatus['status']) => status !== 'running' && status !== 'starting';

export async function agentPreview(deps: AgentPreviewDeps, body: AgentPreviewBody): Promise<AgentPreviewResponse> {
  let current = await deps.status();
  if (body.restart || needsStart(current.status)) {
    const reason = deps.nothingToPreview();
    if (reason) return answer(deps, 'unavailable', { error: reason });
    try {
      current = await deps.start();
    } catch (error) {
      // No engine for the container preview, no compose file and nothing to fall back to, the
      // worktree is gone, no free port: the agent falls back to the static build.
      if (!(error instanceof HttpError)) throw error;
      const hint = typeof error.details?.hint === 'string' ? ` (${error.details.hint})` : '';
      return answer(deps, 'unavailable', { error: `${error.message}${hint}` });
    }
  }
  const pending = deps.pendingStart();
  if (pending) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([pending.catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.waitMs)))]);
    clearTimeout(timer);
    current = await deps.status();
  }
  return answer(deps, current.status, {
    ...(current.error ? { error: current.error } : {}),
    ...(current.logs ? { logs: current.logs } : {}),
    ...(current.note ? { note: current.note } : {}),
  });
}

async function answer(
  deps: AgentPreviewDeps,
  status: AgentPreviewResponse['status'],
  extra: Pick<AgentPreviewResponse, 'error' | 'logs' | 'note'>,
): Promise<AgentPreviewResponse> {
  const browser = await deps.browserUrl();
  const note = [extra.note, browser.note].filter(Boolean).join('; ');
  return { status, url: browser.url, kind: browser.kind, ...extra, ...(note ? { note } : {}) };
}

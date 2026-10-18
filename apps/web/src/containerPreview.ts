/**
 * Container previews in Preview & Build and Live Browser: which view a target opens with, the
 * texts of a preview's state, the runner browser's URL for a target, and the QA request text.
 */
import type { BrowserUrlResponse, RunPreviewStatus, WorkspaceDemoTarget } from '@emberline/protocol';

/** The fields of a run's or main's preview status these helpers read (`unavailable`: main only). */
export type PreviewLike = Pick<
  RunPreviewStatus,
  'status' | 'kind' | 'port' | 'url' | 'error' | 'command' | 'detectedCommand'
> & {
  unavailable?: string;
};

/**
 * How long Live Browser waits for a container preview to answer before it opens the static build:
 * the readiness timeout of a compose preview (120 s) plus a little.
 */
export const PREVIEW_WAIT_MS = 125_000;
export const PREVIEW_POLL_MS = 2_000;

/** Core's prefix of a main preview whose refresh after a merge failed (it is then down). */
const REFRESH_FAILED = 'the refresh after a merge failed: ';

/**
 * The view a target opens with: its container preview when the approved worktree.yml previews a
 * compose service and the Docker engine can run it (main: core reports no `unavailable` reason;
 * a run: a compose preview, the engine and its worktree), else the static build. A preview that was
 * started (also a command preview, the fallback) stays the primary view, so its state and Stop stay
 * in reach. Null until the status answered.
 */
export function choosePrimaryView(
  target: Pick<WorkspaceDemoTarget, 'kind' | 'exists'>,
  preview: PreviewLike | undefined,
  engineAvailable: boolean,
): 'container' | 'static' | null {
  if (!preview) return null;
  // A started preview (a command preview too: the fallback) stays in view with its state and Stop.
  if (preview.status !== 'stopped') return 'container';
  if (preview.kind !== 'compose') return 'static';
  if (target.kind === 'main') return preview.unavailable ? 'static' : 'container';
  return engineAvailable && target.exists ? 'container' : 'static';
}

/** The preview's state as a badge. */
export function previewBadge(p: PreviewLike): { text: string; className: string } {
  switch (p.status) {
    case 'running':
      return { text: p.port ? `Running on :${p.port}` : 'Running', className: 'badge badge-ok' };
    case 'starting':
      return { text: 'Starting…', className: 'badge badge-soft' };
    case 'failed':
      return { text: 'Failed', className: 'badge badge-bad' };
    case 'exited':
      return { text: 'Exited', className: 'badge badge-warn' };
    default:
      return { text: 'Stopped', className: 'badge' };
  }
}

/**
 * What went wrong with a failed or exited preview; null otherwise. A main preview whose refresh
 * after a merge failed was taken down: its hint says so and how to bring it back.
 */
export function previewProblem(p: PreviewLike): { title: string; detail: string; hint: string | null } | null {
  if (p.status !== 'failed' && p.status !== 'exited') return null;
  const error = p.error?.trim() || 'no reason was recorded';
  const refreshFailed = error.startsWith(REFRESH_FAILED);
  return {
    title: `The container preview ${p.status}`,
    detail: refreshFailed ? error.slice(REFRESH_FAILED.length) : error,
    hint: refreshFailed ? 'the refresh after the last merge failed — Start to retry' : null,
  };
}

/** The container view's body while no page is shown: what Start runs, or what is happening. */
export function previewEmptyText(p: PreviewLike, label: string): string {
  switch (p.status) {
    case 'starting':
      return 'Building and starting the container; the first start can take a few minutes.';
    case 'running':
      return 'The preview runs but has no address yet.';
    case 'failed':
    case 'exited':
      return 'Nothing is serving. Start to try again.';
    default: {
      const what = p.command ?? p.detectedCommand ?? 'the compose preview service';
      return `Start runs ${what} from ${label} in the Docker engine.`;
    }
  }
}

/**
 * Whether the preview can show in a frame: an https page cannot frame a plain-http preview (mixed
 * content), so it opens in a new tab instead.
 */
export function previewFrameMode(pageProtocol: string, url: string): { frame: boolean; note: string | null } {
  if (pageProtocol === 'https:' && url.startsWith('http:')) {
    return { frame: false, note: 'The preview is plain HTTP and this page is HTTPS, so it opens in a new tab.' };
  }
  return { frame: true, note: null };
}

/**
 * The factory request of Live Browser's QA check. It names no URL: the QA run opens its own work
 * through the `preview` tool, which knows where the run's preview answers for the runner.
 */
export function qaRequestPrompt(): string {
  return [
    "[Live Browser QA Verification] Open this run's preview with the `preview` tool: it starts the preview if needed and returns the URL that serves this run's own work.",
    'If the tool is not available, build the project and open $EMBERLINE_DEMO_URL instead.',
    'Use your Playwright MCP browser tools (mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_click / mcp__playwright__browser_press_key, mcp__playwright__browser_take_screenshot) to interact with the primary UI controls and flows,',
    'check that there are no console errors, and leave the app open in the browser.',
  ].join(' ');
}

export interface RunnerBrowserDeps {
  /** The target's container preview applies ({@link choosePrimaryView} is 'container'). */
  container: boolean;
  status: () => Promise<PreviewLike>;
  /** Starts the container preview; throws when core refuses (e.g. 409 without the engine). */
  start: () => Promise<PreviewLike>;
  /** Builds the static demo; its outcome does not matter here (browser-url says what exists). */
  buildStatic: () => Promise<void>;
  /** `GET /api/projects/:id/browser-url?target=`: the URL as the runner sees it. */
  browserUrl: () => Promise<BrowserUrlResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  describeError?: (err: unknown) => string;
}

export interface RunnerBrowserUrl {
  /** Where the runner browser goes; null when the target has nothing to open. */
  url: string | null;
  /** What to tell the person (why it is the static build, or why nothing opens). */
  message: string | null;
  /** The message reports a problem (show it as an error). */
  problem: boolean;
}

/**
 * Where Live Browser navigates the runner's browser for a target. With a container preview it
 * starts the preview when it is not running, waits for it (up to `timeoutMs`), then asks core for
 * the runner-side URL; without one it builds the static demo first, as Open Live Demo always did.
 */
export async function resolveRunnerBrowserUrl(
  deps: RunnerBrowserDeps,
  opts: { timeoutMs: number; pollMs: number } = { timeoutMs: PREVIEW_WAIT_MS, pollMs: PREVIEW_POLL_MS },
): Promise<RunnerBrowserUrl> {
  const describe = deps.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  let previewError: string | null = null;
  if (deps.container) {
    try {
      let status = await deps.status();
      if (status.status !== 'running' && status.status !== 'starting') status = await deps.start();
      const deadline = deps.now() + opts.timeoutMs;
      while (status.status === 'starting' && deps.now() < deadline) {
        await deps.sleep(Math.min(opts.pollMs, Math.max(0, deadline - deps.now())));
        status = await deps.status();
      }
      const problem = previewProblem(status);
      if (problem) previewError = `${problem.title}: ${problem.detail}`;
    } catch (err) {
      previewError = `The container preview could not start: ${describe(err)}`;
    }
  } else {
    await deps.buildStatic().catch(() => undefined);
  }

  const res = await deps.browserUrl();
  if (!res.url) {
    const message = previewError
      ? `${previewError}. There is nothing else to open yet.`
      : `Nothing to open yet: ${res.note ?? 'build the project or start its preview first'}.`;
    return { url: null, message, problem: true };
  }
  if (previewError && res.kind !== 'compose') {
    return { url: res.url, message: `${previewError}. Opening the static build instead.`, problem: true };
  }
  return { url: res.url, message: res.note ?? null, problem: false };
}

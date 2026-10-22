import type { BrowserUrlResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  FRAMING_UNKNOWN_NOTE,
  IPV6_FRAME_NOTE,
  LIVE_BROWSER_FOLLOWING_NOTE,
  OPEN_IN_NEW_TAB,
  type PreviewLike,
  choosePrimaryView,
  framingRefusedText,
  framingView,
  headerOpenShown,
  recheckFraming,
  liveBrowserNote,
  LIVE_BROWSER_CAN_FOLLOW_NOTE,
  FOLLOW_AGENT,
  offersFollow,
  bannerAfterSnapshot,
  PLAYTEST_ELSEWHERE_TEXT,
  PLAYTEST_HELD_MESSAGE,
  PLAYTEST_STARTED_TEXT,
  playtestStartBanner,
  previewBadge,
  previewEmptyText,
  previewFrameMode,
  previewProblem,
  qaRequestPrompt,
  resolveRunnerBrowserUrl,
} from './containerPreview';

const main = { kind: 'main' as const, exists: true };
const run = { kind: 'worktree' as const, exists: true };
const preview = (over: Partial<PreviewLike> = {}): PreviewLike => ({
  status: 'stopped',
  kind: 'compose',
  port: null,
  url: null,
  error: null,
  command: null,
  detectedCommand: null,
  ...over,
});

describe('primary view', () => {
  it('is the container preview for main when it can have one', () => {
    expect(choosePrimaryView(main, preview(), false)).toBe('container');
  });

  it('is the static build for main without a compose preview service or the engine', () => {
    const unavailable =
      'the approved worktree.yml has no compose preview service, so main has no container preview';
    expect(choosePrimaryView(main, preview({ unavailable }), true)).toBe('static');
  });

  it('keeps a started main preview visible even once it became unavailable, so it can be stopped', () => {
    expect(choosePrimaryView(main, preview({ status: 'exited', unavailable: 'engine off' }), false)).toBe(
      'container',
    );
  });

  it('is the container preview for a run with a compose preview service and the engine', () => {
    expect(choosePrimaryView(run, preview(), true)).toBe('container');
  });

  it('is the static build for a run without the engine, a compose preview or its worktree', () => {
    expect(choosePrimaryView(run, preview(), false)).toBe('static');
    expect(choosePrimaryView(run, preview({ kind: 'command' }), true)).toBe('static');
    expect(choosePrimaryView({ kind: 'worktree', exists: false }, preview(), true)).toBe('static');
  });

  it('keeps a started command preview (the fallback) visible with its Stop, but never offers to start one', () => {
    expect(choosePrimaryView(run, preview({ kind: 'command', status: 'running', port: 4300 }), true)).toBe(
      'container',
    );
    expect(choosePrimaryView(run, preview({ kind: 'command', status: 'exited' }), false)).toBe('container');
    expect(choosePrimaryView(run, preview({ kind: 'command' }), true)).toBe('static');
  });

  it('keeps a started run preview visible while the engine is away', () => {
    expect(choosePrimaryView(run, preview({ status: 'failed', error: 'x' }), false)).toBe('container');
  });

  it('is unknown until the preview status answered', () => {
    expect(choosePrimaryView(main, undefined, true)).toBeNull();
  });
});

describe('status badge', () => {
  it('names each state', () => {
    expect(previewBadge(preview())).toEqual({ text: 'Stopped', className: 'badge' });
    expect(previewBadge(preview({ status: 'starting', port: 4325 }))).toEqual({
      text: 'Starting…',
      className: 'badge badge-soft',
    });
    expect(previewBadge(preview({ status: 'running', port: 4325 }))).toEqual({
      text: 'Running on :4325',
      className: 'badge badge-ok',
    });
    expect(previewBadge(preview({ status: 'failed' }))).toEqual({
      text: 'Failed',
      className: 'badge badge-bad',
    });
    expect(previewBadge(preview({ status: 'exited' }))).toEqual({
      text: 'Exited',
      className: 'badge badge-warn',
    });
  });

  it('says running without a port', () => {
    expect(previewBadge(preview({ status: 'running' })).text).toBe('Running');
  });
});

describe('preview problem', () => {
  it('is null while nothing went wrong', () => {
    expect(previewProblem(preview())).toBeNull();
    expect(previewProblem(preview({ status: 'running', port: 4325 }))).toBeNull();
  });

  it('shows the error of a failed or exited preview', () => {
    expect(
      previewProblem(
        preview({ status: 'failed', error: '"web" did not answer HTTP on port 80 within 120 s' }),
      ),
    ).toEqual({
      title: 'The container preview failed',
      detail: '"web" did not answer HTTP on port 80 within 120 s',
      hint: null,
    });
    expect(
      previewProblem(preview({ status: 'exited', error: 'the "web" container is not running' })),
    ).toEqual({
      title: 'The container preview exited',
      detail: 'the "web" container is not running',
      hint: null,
    });
  });

  it('says a failed refresh after a merge took main down, and how to retry', () => {
    const problem = previewProblem(
      preview({
        status: 'failed',
        error: 'the refresh after a merge failed: "web" did not answer HTTP on port 80 within 120 s',
      }),
    );
    expect(problem).toEqual({
      title: 'The container preview failed',
      detail: '"web" did not answer HTTP on port 80 within 120 s',
      hint: 'the refresh after the last merge failed — Start to retry',
    });
  });

  it('has a detail even without an error text', () => {
    expect(previewProblem(preview({ status: 'failed' }))?.detail).toBe('no reason was recorded');
  });
});

describe('empty preview text', () => {
  it('says what Start runs, what is being built, or why nothing shows', () => {
    expect(previewEmptyText(preview({ command: 'web (compose.yaml, port 80)' }), 'main')).toBe(
      'Start runs web (compose.yaml, port 80) from main in the Docker engine.',
    );
    expect(previewEmptyText(preview(), 'YOG-3 · coder')).toBe(
      'Start runs the compose preview service from YOG-3 · coder in the Docker engine.',
    );
    expect(previewEmptyText(preview({ status: 'starting' }), 'main')).toBe(
      'Building and starting the container; the first start can take a few minutes.',
    );
    expect(previewEmptyText(preview({ status: 'failed', error: 'x' }), 'main')).toBe(
      'Nothing is serving. Start to try again.',
    );
    expect(previewEmptyText(preview({ status: 'running' }), 'main')).toBe(
      'The preview runs but has no address yet.',
    );
  });

  it('names the service from the detected command when none was started yet', () => {
    expect(previewEmptyText(preview({ detectedCommand: 'web (compose.yaml, port 80)' }), 'main')).toBe(
      'Start runs web (compose.yaml, port 80) from main in the Docker engine.',
    );
  });
});

describe('preview frame', () => {
  it('frames an http preview in an http page', () => {
    expect(previewFrameMode('http:', 'http://192.168.1.16:4325')).toEqual({ frame: true, note: null });
  });

  it('opens a plain-http preview in a new tab from an https page (the browser would block it as mixed content)', () => {
    expect(previewFrameMode('https:', 'http://emberline.lan:4325')).toEqual({
      frame: false,
      note: 'The preview is plain HTTP and this page is HTTPS, so it opens in a new tab.',
    });
  });

  it('frames an https preview anywhere', () => {
    expect(previewFrameMode('https:', 'https://previews.lan:4325')).toEqual({ frame: true, note: null });
  });

  it('frames a preview on an IPv6 address with a note (the frame policy cannot name it, so it allows any address)', () => {
    expect(previewFrameMode('http:', 'http://[fd00::5]:4325')).toEqual({
      frame: true,
      note: IPV6_FRAME_NOTE,
    });
    expect(previewFrameMode('https:', 'https://[fd00::5]:4325')).toEqual({
      frame: true,
      note: IPV6_FRAME_NOTE,
    });
    expect(IPV6_FRAME_NOTE).toBe(
      "Emberline is open on an IPv6 address, which a browser's frame policy cannot name, so previews can be framed from any address. Open Emberline by its host name to limit that to the preview ports.",
    );
  });
});

describe('QA request', () => {
  it('opens the run’s own preview through the preview tool, with the env fallback, and embeds no URL', () => {
    const text = qaRequestPrompt();
    expect(text.startsWith('[Live Browser QA Verification]')).toBe(true);
    expect(text).toContain('`preview` tool');
    expect(text).toContain('$EMBERLINE_DEMO_URL');
    expect(text).toMatch(/console errors/);
    expect(text).toMatch(/primary/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/localhost|7420/);
  });
});

describe('runner browser URL', () => {
  interface Calls {
    status: number;
    start: number;
    build: number;
    browserUrl: number;
    sleeps: number[];
  }

  function deps(opts: {
    container: boolean;
    statuses?: PreviewLike[];
    start?: PreviewLike | Error;
    browserUrl: BrowserUrlResponse;
  }) {
    const calls: Calls = { status: 0, start: 0, build: 0, browserUrl: 0, sleeps: [] };
    const statuses = [...(opts.statuses ?? [preview()])];
    let clock = 0;
    return {
      calls,
      deps: {
        container: opts.container,
        status: async () => {
          calls.status += 1;
          return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        },
        start: async () => {
          calls.start += 1;
          if (opts.start instanceof Error) throw opts.start;
          return opts.start ?? preview({ status: 'starting', port: 4325 });
        },
        buildStatic: async () => {
          calls.build += 1;
        },
        browserUrl: async () => {
          calls.browserUrl += 1;
          return opts.browserUrl;
        },
        sleep: async (ms: number) => {
          calls.sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
      },
    };
  }

  it('starts the container preview, waits until it runs, then opens the runner-side URL', async () => {
    const d = deps({
      container: true,
      statuses: [
        preview(),
        preview({ status: 'starting', port: 4325 }),
        preview({ status: 'running', port: 4325 }),
      ],
      browserUrl: { url: 'http://docker:4325/', kind: 'compose' },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res).toEqual({ url: 'http://docker:4325/', message: null, problem: false });
    expect(d.calls.start).toBe(1);
    expect(d.calls.build).toBe(0);
    expect(d.calls.browserUrl).toBe(1);
  });

  it('does not start a preview that already runs', async () => {
    const d = deps({
      container: true,
      statuses: [preview({ status: 'running', port: 4325 })],
      browserUrl: { url: 'http://docker:4325/', kind: 'compose' },
    });
    await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(d.calls.start).toBe(0);
    expect(d.calls.sleeps).toEqual([]);
  });

  it('builds the static demo when no container preview applies', async () => {
    const d = deps({
      container: false,
      browserUrl: { url: 'http://core:7420/api/demo/tok/', kind: 'static' },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res.url).toBe('http://core:7420/api/demo/tok/');
    expect(d.calls.build).toBe(1);
    expect(d.calls.start).toBe(0);
    expect(d.calls.status).toBe(0);
  });

  it('stops waiting at the timeout and says the static build is shown', async () => {
    const d = deps({
      container: true,
      statuses: [preview({ status: 'starting', port: 4325 })],
      browserUrl: {
        url: 'http://core:7420/api/demo/tok/',
        kind: 'static',
        note: 'the container preview is still starting; this is the static build',
      },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 3_000, pollMs: 1_000 });
    expect(d.calls.sleeps.reduce((a, b) => a + b, 0)).toBe(3_000);
    expect(res).toEqual({
      url: 'http://core:7420/api/demo/tok/',
      message: 'the container preview is still starting; this is the static build',
      problem: false,
    });
  });

  it('opens the static fallback with the reason when the container preview failed', async () => {
    const d = deps({
      container: true,
      statuses: [preview(), preview({ status: 'failed', error: 'boom' })],
      browserUrl: { url: 'http://core:7420/api/demo/tok/', kind: 'static' },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res).toEqual({
      url: 'http://core:7420/api/demo/tok/',
      message: 'The container preview failed: boom. Opening the static build instead.',
      problem: true,
    });
  });

  it('reports a start the server refused', async () => {
    const d = deps({
      container: true,
      start: new Error('enable the Docker engine'),
      browserUrl: { url: null, kind: 'static', note: 'no demo entry yet' },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res).toEqual({
      url: null,
      message:
        'The container preview could not start: enable the Docker engine. There is nothing else to open yet.',
      problem: true,
    });
  });

  it('says clearly when there is nothing to open', async () => {
    const d = deps({
      container: false,
      browserUrl: { url: null, kind: 'static', note: 'main has no demo yet' },
    });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res).toEqual({
      url: null,
      message: 'Nothing to open yet: main has no demo yet.',
      problem: true,
    });
  });
});

describe('framing', () => {
  it('a refusing app gets the panel text with its reason', () => {
    expect(framingRefusedText('X-Frame-Options: DENY')).toBe(
      'This app does not allow being shown inside another page (X-Frame-Options: DENY). Open it in a new tab.',
    );
  });

  it('the panel text has no parentheses without a reason', () => {
    expect(framingRefusedText(null)).toBe(
      'This app does not allow being shown inside another page. Open it in a new tab.',
    );
  });

  it('maps framing to the view', () => {
    expect(
      framingView(
        preview({ status: 'running', framing: { state: 'refused', reason: 'X-Frame-Options: DENY' } }),
      ),
    ).toBe('refused');
    expect(framingView(preview({ status: 'running', framing: { state: 'unknown', reason: null } }))).toBe(
      'unknown',
    );
    expect(framingView(preview({ status: 'running', framing: { state: 'allowed', reason: null } }))).toBe(
      'allowed',
    );
    expect(framingView(preview({ status: 'running' }))).toBe('allowed');
  });

  it('shows no notice while the preview is not running', () => {
    expect(framingView(preview({ status: 'stopped', framing: { state: 'refused', reason: 'x' } }))).toBe(
      'allowed',
    );
  });

  it("the unknown note and the button are the spec's", () => {
    expect(FRAMING_UNKNOWN_NOTE).toBe('If the preview stays blank, open it in a new tab.');
    expect(OPEN_IN_NEW_TAB).toBe('Open in new tab');
  });
});

describe('liveBrowserNote', () => {
  it("says when the view follows an agent's tab", () => {
    expect(liveBrowserNote({ following: true })).toBe(LIVE_BROWSER_FOLLOWING_NOTE);
    expect(liveBrowserNote({ following: false })).toBeNull();
    expect(liveBrowserNote({})).toBeNull();
    expect(liveBrowserNote(null)).toBeNull();
  });

  it('offers to follow the agent while the person stays on the project tab', () => {
    expect(LIVE_BROWSER_CAN_FOLLOW_NOTE).toBe('An agent is using the browser.');
    expect(FOLLOW_AGENT).toBe('Follow it');
    expect(liveBrowserNote({ following: false, canFollow: true })).toBe(LIVE_BROWSER_CAN_FOLLOW_NOTE);
    expect(offersFollow({ following: false, canFollow: true })).toBe(true);
    expect(offersFollow({ following: true, canFollow: true })).toBe(false);
    expect(offersFollow({ following: true })).toBe(false);
    expect(offersFollow({})).toBe(false);
    expect(offersFollow(null)).toBe(false);
  });
});

describe('Auto-Interact start banner (B-12)', () => {
  it('says when Auto-Interact runs for another project instead of claiming it started', () => {
    expect(PLAYTEST_ELSEWHERE_TEXT).toBe(
      'Auto-Interact is running for another project. Start it here once that one stops.',
    );
    expect(playtestStartBanner({ playtestActive: false, playtestElsewhere: true })).toEqual({
      kind: 'info',
      text: PLAYTEST_ELSEWHERE_TEXT,
    });
    expect(playtestStartBanner({ playtestActive: true })).toEqual({
      kind: 'ok',
      text: PLAYTEST_STARTED_TEXT,
    });
    expect(PLAYTEST_STARTED_TEXT).toBe(
      'Browser Auto-Interact started! Watch the viewport and Agent Activity stream in real time.',
    );
    expect(playtestStartBanner({ playtestActive: false })).toBeUndefined();
    expect(playtestStartBanner(null)).toBeUndefined();
  });

  it('drops only the refusal, once the other project stops', () => {
    const refusal = { kind: 'info' as const, text: PLAYTEST_ELSEWHERE_TEXT };
    const other = { kind: 'err' as const, text: 'down' };
    expect(bannerAfterSnapshot(refusal, { playtestElsewhere: true })).toBe(refusal);
    expect(bannerAfterSnapshot(refusal, { playtestElsewhere: false })).toBeUndefined();
    expect(bannerAfterSnapshot(refusal, {})).toBeUndefined();
    expect(bannerAfterSnapshot(other, { playtestElsewhere: false })).toBe(other);
    const heldStop = { kind: 'info' as const, text: PLAYTEST_HELD_MESSAGE };
    expect(bannerAfterSnapshot(heldStop, { playtestElsewhere: true })).toBe(heldStop);
    expect(bannerAfterSnapshot(heldStop, { playtestElsewhere: false })).toBeUndefined();
    expect(bannerAfterSnapshot(undefined, { playtestElsewhere: false })).toBeUndefined();
  });
});

describe('framing panel header', () => {
  it('shows the header Open link only when the frame is usable', () => {
    expect(headerOpenShown('refused', { frame: true })).toBe(false);
    expect(headerOpenShown('allowed', { frame: false })).toBe(false);
    expect(headerOpenShown('allowed', { frame: true })).toBe(true);
    expect(headerOpenShown('unknown', { frame: true })).toBe(true);
    expect(headerOpenShown('allowed', null)).toBe(true);
  });

  it('Reload shows the recheck answer, rereads only after a failure, and runs once at a time', async () => {
    const shown: string[] = [];
    let refreshed = 0;
    const guard = { current: false };
    let release!: (v: string) => void;
    const first = recheckFraming(guard, {
      post: () => new Promise<string>((r) => (release = r)),
      show: (s) => shown.push(s),
      refresh: async () => void refreshed++,
    });
    expect(
      await recheckFraming(guard, {
        post: async () => 'second',
        show: (s) => shown.push(s),
        refresh: async () => void refreshed++,
      }),
    ).toEqual({ ran: false, error: null });
    release('fresh');
    await first;
    expect(shown).toEqual(['fresh']);
    expect(refreshed).toBe(0);
    const failed = await recheckFraming(guard, {
      post: async () => {
        throw new Error('down');
      },
      show: () => undefined,
      refresh: async () => void refreshed++,
    });
    expect(failed.ran).toBe(true);
    expect(refreshed).toBe(1);
  });
});

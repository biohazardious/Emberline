import type { BrowserUrlResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  type PreviewLike,
  choosePrimaryView,
  previewBadge,
  previewEmptyText,
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
    const unavailable = 'the approved worktree.yml has no compose preview service, so main has no container preview';
    expect(choosePrimaryView(main, preview({ unavailable }), true)).toBe('static');
  });

  it('keeps a started main preview visible even once it became unavailable, so it can be stopped', () => {
    expect(choosePrimaryView(main, preview({ status: 'exited', unavailable: 'engine off' }), false)).toBe('container');
  });

  it('is the container preview for a run with a compose preview service and the engine', () => {
    expect(choosePrimaryView(run, preview(), true)).toBe('container');
  });

  it('is the static build for a run without the engine, a compose preview or its worktree', () => {
    expect(choosePrimaryView(run, preview(), false)).toBe('static');
    expect(choosePrimaryView(run, preview({ kind: 'command' }), true)).toBe('static');
    expect(choosePrimaryView({ kind: 'worktree', exists: false }, preview(), true)).toBe('static');
  });

  it('never makes a running command preview the container view', () => {
    expect(choosePrimaryView(run, preview({ kind: 'command', status: 'running', port: 4300 }), true)).toBe('static');
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
    expect(previewBadge(preview({ status: 'failed' }))).toEqual({ text: 'Failed', className: 'badge badge-bad' });
    expect(previewBadge(preview({ status: 'exited' }))).toEqual({ text: 'Exited', className: 'badge badge-warn' });
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
    expect(previewProblem(preview({ status: 'failed', error: '"web" did not answer HTTP on port 80 within 120 s' }))).toEqual({
      title: 'The container preview failed',
      detail: '"web" did not answer HTTP on port 80 within 120 s',
      hint: null,
    });
    expect(previewProblem(preview({ status: 'exited', error: 'the "web" container is not running' }))).toEqual({
      title: 'The container preview exited',
      detail: 'the "web" container is not running',
      hint: null,
    });
  });

  it('says a failed refresh after a merge took main down, and how to retry', () => {
    const problem = previewProblem(
      preview({ status: 'failed', error: 'the refresh after a merge failed: "web" did not answer HTTP on port 80 within 120 s' }),
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
    expect(previewEmptyText(preview({ status: 'running' }), 'main')).toBe('The preview runs but has no address yet.');
  });

  it('names the service from the detected command when none was started yet', () => {
    expect(previewEmptyText(preview({ detectedCommand: 'web (compose.yaml, port 80)' }), 'main')).toBe(
      'Start runs web (compose.yaml, port 80) from main in the Docker engine.',
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
      statuses: [preview(), preview({ status: 'starting', port: 4325 }), preview({ status: 'running', port: 4325 })],
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
      message: 'The container preview could not start: enable the Docker engine. There is nothing else to open yet.',
      problem: true,
    });
  });

  it('says clearly when there is nothing to open', async () => {
    const d = deps({ container: false, browserUrl: { url: null, kind: 'static', note: 'main has no demo yet' } });
    const res = await resolveRunnerBrowserUrl(d.deps, { timeoutMs: 10_000, pollMs: 1_000 });
    expect(res).toEqual({
      url: null,
      message: 'Nothing to open yet: main has no demo yet.',
      problem: true,
    });
  });
});

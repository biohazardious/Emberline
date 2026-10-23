// @vitest-environment happy-dom
import type { Run, RunPreviewStatus } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { ReviewView } from './components/ReviewView';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoDiff', () => ({ MonacoDiff: () => null }));
vi.mock('./components/TerminalView', () => ({ TerminalView: () => null }));

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
  state: 'done',
  branch: 'emberline/run-r1',
  worktreePath: '/workspaces/shop/.worktrees/r1',
  endedAt: '2026-10-23T11:00:00.000Z',
  stateChangedAt: '2026-10-23T11:00:00.000Z',
  attention: null,
} as unknown as Run;

const DOWN_FAILED = 'the preview could not be taken down: its containers may still be running; stop it again';
const preview = (over: Partial<RunPreviewStatus>): RunPreviewStatus => ({
  runId: 'r1',
  status: 'failed',
  kind: 'compose',
  terminalId: null,
  command: 'compose web',
  port: 4301,
  url: 'http://localhost:4301',
  detectedCommand: 'compose web',
  error: DOWN_FAILED,
  logs: null,
  ...over,
});

let status: RunPreviewStatus;
let stops: number;

beforeEach(() => {
  stops = 0;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/runs/r1/preview': () => status,
      'POST /api/runs/r1/preview/stop': () => {
        stops++;
        status = preview({ status: 'stopped', error: null, url: null, port: null });
        return status;
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('ReviewView: a compose preview whose containers could not be taken down (I-3)', () => {
  it('offers Stop Preview, not a new preview, and Stop runs the stop again', async () => {
    status = preview({ downFailed: true });
    await renderDom(createElement(ReviewView, { run }), { path: '/runs/r1/review' });
    await waitFor(() => expect(document.body.textContent).toContain(`Preview failed: ${DOWN_FAILED}`));
    expect(queryButton('Preview Server')).toBeNull();
    await click(getButton('Stop Preview'));
    await waitFor(() => expect(stops).toBe(1));
    await waitFor(() => expect(queryButton('Preview Server')).not.toBeNull());
  });

  it('a preview that failed otherwise offers a new preview', async () => {
    status = preview({ error: 'the build failed' });
    await renderDom(createElement(ReviewView, { run }), { path: '/runs/r1/review' });
    await waitFor(() => expect(document.body.textContent).toContain('Preview failed: the build failed'));
    expect(queryButton('Stop Preview')).toBeNull();
    expect(queryButton('Preview Server')).not.toBeNull();
  });
});

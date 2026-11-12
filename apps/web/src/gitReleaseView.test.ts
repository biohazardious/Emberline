// @vitest-environment happy-dom
import type { GitPageStatus, ReleaseJob, ReleaseStep } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { GitReleaseTab } from './components/git/GitReleaseTab';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const HEAD = 'a'.repeat(40);
const status = (over: Partial<GitPageStatus> = {}): GitPageStatus =>
  ({
    isGitRepo: true,
    defaultBranch: 'main',
    workingBranch: 'develop',
    latestTag: 'v0.8.0',
    hasOrigin: true,
    originUrl: 'https://github.com/o/app.git',
    forgeRelease: true,
    release: { ok: true, reason: null },
    releaseJob: null,
    releaseDraft: null,
    releaseSummary: { head: HEAD, commits: 4, tickets: 2, checks: ['build', 'test'] },
    ...over,
  }) as GitPageStatus;
const NAMES = [
  'promote',
  'checks',
  'changelog',
  'push_main',
  'tag',
  'push_tag',
  'forge_release',
  'sync_working',
] as const;
const job = (over: Partial<ReleaseJob> = {}, steps: Record<string, ReleaseStep['status']> = {}): ReleaseJob =>
  ({
    id: 'j1',
    mode: 'publish',
    version: 'v0.9.0',
    notes: 'n',
    head: HEAD,
    working: 'develop',
    state: 'failed',
    steps: NAMES.map((name) => ({ name, status: steps[name] ?? 'pending', detail: null })),
    startedAt: '2026-11-13T00:00:00Z',
    finishedAt: null,
    previousMain: null,
    checked: null,
    promoteOid: null,
    releaseCommit: null,
    releaseUrl: null,
    error: null,
    ...over,
  }) as ReleaseJob;

const B = '/api/projects/p1/git';
const calls: string[] = [];
let failRetry: unknown = null;
const serve = () =>
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [`POST ${B}/release`]: (body) => {
        calls.push(`start ${JSON.stringify(body)}`);
        return {};
      },
      [`POST ${B}/release/draft`]: () => {
        calls.push('draft');
        return {};
      },
      [`POST ${B}/release/retry`]: () => {
        calls.push('retry');
        if (failRetry) throw failRetry;
        return {};
      },
      [`POST ${B}/release/undo-promote`]: () => {
        calls.push('undo');
        return {};
      },
    }),
  );
const show = (s: GitPageStatus) => renderDom(createElement(GitReleaseTab, { projectId: 'p1', status: s }));
const lines = (root: HTMLElement) =>
  [...root.querySelectorAll('[aria-label="What happens"] li')].map((li) => li.textContent);

beforeEach(() => {
  calls.length = 0;
  failRetry = null;
  serve();
});
afterEach(cleanup);

describe('the release tab', () => {
  it('summarises the release and lists the steps of a publish', async () => {
    const { container } = await show(status());
    expect(container.textContent).toContain('develop → main: 4 commits, 2 tickets');
    expect(container.textContent).toContain('Checks: build, test');
    expect(lines(container)).toEqual([
      'Merge develop into main',
      'Run the checks on main: build, test',
      'Add the notes to CHANGELOG.md in the release commit',
      'Push main to origin',
      'Tag v0.8.1',
      'Push the tag to origin',
      'Create the release on github.com',
      'Bring develop up to date with main',
    ]);
  });

  it('leaves out the promote steps when the working branch is main, and says so', async () => {
    const { container } = await show(
      status({
        workingBranch: 'main',
        forgeRelease: false,
        releaseSummary: { head: HEAD, commits: 4, tickets: 2, checks: [] },
      }),
    );
    expect(container.textContent).toContain('Release main as it is');
    expect(container.textContent).toContain('No approved checks; the release runs none');
    expect(lines(container)).toEqual([
      'No approved checks; none run',
      'Add the notes to CHANGELOG.md in the release commit',
      'Push main to origin',
      'Tag v0.8.1',
      'Push the tag to origin',
      'No forge account for github.com: only the tag is pushed',
    ]);
    expect(container.textContent).not.toContain('Promote only');
  });

  it('plans a promote only without the tag, the notes and the release', async () => {
    const { container } = await show(status());
    await click(getButton('Promote only'));
    await waitFor(() => expect(calls).toHaveLength(1));
    // The plan of a promote only is shown by its own radio; the body carries the head.
    expect(calls[0]).toBe(`start ${JSON.stringify({ mode: 'promote_only', head: HEAD })}`);
    expect(container.textContent).toContain('Promote only');
  });

  it('validates the version and sends the head with the notes', async () => {
    const { container } = await show(status());
    const version = container.querySelector<HTMLInputElement>('input[aria-label="Version"]')!;
    expect(version.value).toBe('v0.8.1');
    await typeInto(version, 'nine');
    expect(container.textContent).toContain('A version looks like v1.2.3');
    expect(getButton('Approve and publish').disabled).toBe(true);
    await typeInto(version, 'v1.0.0');
    await typeInto(container.querySelector('textarea')!, '### Added\n- x');
    await click(getButton('Approve and publish'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.slice(6))).toEqual({
      mode: 'publish',
      version: 'v1.0.0',
      notes: '### Added\n- x',
      head: HEAD,
    });
  });

  it('prefills the draft and says when it was written for an older tip', async () => {
    const draft = {
      status: 'ready',
      head: 'b'.repeat(40),
      baseTag: 'v0.8.0',
      version: 'v0.9.0',
      bump: 'minor',
      notes: 'Drafted notes',
      agent: 'claude',
      error: null,
      at: '2026-11-13T00:00:00Z',
    } as const;
    const { container } = await show(status({ releaseDraft: draft }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Version"]')!.value).toBe('v0.9.0');
    expect(container.querySelector('textarea')!.value).toBe('Drafted notes');
    expect(container.textContent).toContain('The draft was written for an older tip of develop');
    const fresh = await show(status({ releaseDraft: { ...draft, head: HEAD } }));
    expect(fresh.container.textContent).not.toContain('older tip');
  });

  it('asks an agent for a draft, and shows a failed one inline', async () => {
    const { container } = await show(
      status({
        releaseDraft: {
          status: 'failed',
          head: HEAD,
          baseTag: null,
          version: null,
          bump: null,
          notes: '',
          agent: null,
          error: 'No agent is available.',
          at: '2026-11-13T00:00:00Z',
        },
      }),
    );
    expect(container.textContent).toContain('No agent is available.');
    await click(getButton('Draft notes with an agent'));
    await waitFor(() => expect(calls).toEqual(['draft']));
  });

  it('blocks both buttons with the reason', async () => {
    const { container } = await show(status({ release: { ok: false, reason: 'Nothing new to release.' } }));
    expect(container.textContent).toContain('Nothing new to release.');
    expect(getButton('Approve and publish').disabled).toBe(true);
    expect(getButton('Promote only').disabled).toBe(true);
  });

  it('shows a failed job with Retry and, before push_main, Undo promote', async () => {
    const failed = job({ error: 'The checks failed.' }, { promote: 'done', checks: 'failed' });
    const { container } = await show(status({ releaseJob: failed }));
    expect(container.textContent).toContain('The checks failed.');
    await click(getButton('Retry'));
    await waitFor(() => expect(calls).toEqual(['retry']));
    await click(getButton('Undo promote'));
    await waitFor(() => expect(calls).toEqual(['retry', 'undo']));
    // The next release is not started from here while the failed one waits.
    expect(container.textContent).not.toContain('Approve and publish');
  });

  it('offers no Undo promote once main was pushed', async () => {
    await show(
      status({
        releaseJob: job(
          {},
          { promote: 'done', checks: 'done', changelog: 'done', push_main: 'done', tag: 'failed' },
        ),
      }),
    );
    expect(() => getButton('Undo promote')).toThrow();
    expect(getButton('Retry')).toBeTruthy();
  });

  it('turns Retry into starting again when the server asks for a restart', async () => {
    failRetry = new ApiRequestError(409, 'restart_needed', "origin's main moved: start the release again");
    const failed = job({}, { promote: 'skipped', checks: 'done', push_main: 'failed' });
    const { container } = await show(status({ workingBranch: 'main', releaseJob: failed }));
    await click(getButton('Retry'));
    await waitFor(() => expect(container.textContent).toContain("origin's main moved"));
    expect(() => getButton('Retry')).toThrow();
    expect(getButton('Approve and publish')).toBeTruthy();
  });

  it('links the release when done, and shows a running job without actions', async () => {
    const done = job(
      { state: 'done', releaseUrl: 'https://github.com/o/app/releases/tag/v0.9.0' },
      { checks: 'done' },
    );
    const { container } = await show(status({ releaseJob: done }));
    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://github.com/o/app/releases"]');
    expect(link?.textContent).toContain('v0.9.0');
    const running = await show(status({ releaseJob: job({ state: 'running' }, { promote: 'running' }) }));
    expect(running.container.textContent).toContain('Merge develop into main');
    expect(running.container.querySelectorAll('button')).toHaveLength(0);
  });
});

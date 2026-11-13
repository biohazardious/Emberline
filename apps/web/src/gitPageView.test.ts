// @vitest-environment happy-dom
import type { GitBranch, GitPageStatus, GitSync } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from './domRender';
import { AppTopbar } from './components/AppTopbar';
import { GitPage } from './pages/GitPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

// The Commits tab imports the diff editor; Monaco does not load in a DOM test.
vi.mock('./components/MonacoDiff', () => ({ MonacoDiff: () => null }));

const sync = (over: Partial<GitSync> = {}): GitSync => ({
  state: 'idle',
  at: null,
  branch: null,
  files: [],
  message: null,
  ...over,
});
const status = (over: Partial<GitPageStatus> = {}): GitPageStatus =>
  ({
    isGitRepo: true,
    defaultBranch: 'main',
    workingBranch: 'develop',
    checkedOut: 'develop',
    workingMismatch: false,
    mainBehindWorking: 3,
    latestTag: 'v0.8.0',
    hasOrigin: true,
    originUrl: 'https://github.com/o/app.git',
    working: 'up_to_date',
    main: 'up_to_date',
    workingCounts: null,
    mainCounts: null,
    checkedAt: null,
    autoPull: true,
    sync: sync(),
    forgeRelease: false,
    release: { ok: true, reason: null },
    releaseJob: null,
    releaseDraft: null,
    releaseSummary: { head: null, commits: 0, tickets: 0, checks: [], hasChangelog: false },
    backups: [],
    tagsDifferFromOrigin: [],
    tagsNamedLikeBranches: [],
    ...over,
  }) as GitPageStatus;
const branch = (name: string, kind: GitBranch['kind']) =>
  ({ name, kind, liveRuns: [] }) as unknown as GitBranch;

const calls: string[] = [];
function serve(s: GitPageStatus, extra: Record<string, (body: unknown) => unknown> = {}) {
  const log =
    (key: string, fn: (b: unknown) => unknown = () => ({})) =>
    (b: unknown) => {
      calls.push(`${key} ${JSON.stringify(b ?? null)}`);
      return fn(b);
    };
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects/p1/git': () => s,
      'GET /api/projects/p1/git/branches': () => [
        branch('develop', 'working'),
        branch('main', 'main'),
        branch('emberline/x', 'run'),
        branch('12112026_backup', 'origin'),
        branch('emberline/on-origin', 'origin'),
      ],
      'PATCH /api/projects/p1/git': log('PATCH'),
      'POST /api/projects/p1/git/fetch': log('fetch'),
      'POST /api/projects/p1/git/pull': log('pull'),
      'POST /api/projects/p1/git/match-origin': log('match'),
      'POST /api/projects/p1/git/working-branch': log('working'),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, log(k, v)])),
    }),
  );
}
const open = (path = '/projects/p1/git') => renderDom(createElement(GitPage, { projectId: 'p1' }), { path });

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

describe('Git page', () => {
  it('shows the status strip with a tab skeleton', async () => {
    serve(status());
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain('3 commits behind'));
    const text = view.container.textContent ?? '';
    expect(text).toContain('v0.8.0');
    expect(text).toContain('Up to date with origin');
    const tabs = [...view.container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Commits', 'Branches', 'Release']);
    // Run branches stay out of the picker; a branch only on origin is offered (picking it checks it out).
    await waitFor(() =>
      expect([...view.container.querySelectorAll('option')].map((o) => o.value)).toEqual([
        'develop',
        'main',
        '12112026_backup',
      ]),
    );
    expect(view.container.querySelector('option[value="12112026_backup"]')?.textContent).toBe(
      '12112026_backup (on origin)',
    );
  });

  it("says which of origin's tags are named like a branch", async () => {
    serve(status({ tagsNamedLikeBranches: ['main'] }));
    const view = await open();
    await waitFor(() =>
      expect(view.container.textContent).toContain('origin has a tag named like a branch (main)'),
    );
  });

  it("says which tags here differ from origin's", async () => {
    serve(status({ tagsDifferFromOrigin: ['v0.7.0'] }));
    const view = await open();
    await waitFor(() =>
      expect(view.container.textContent).toContain("The tag v0.7.0 here is not the same as origin's v0.7.0."),
    );
  });

  it('opens the tab named by the hash and Promote & release… opens Release', async () => {
    serve(status());
    const view = await open('/projects/p1/git#branches');
    await waitFor(() => getButton('Branches'));
    expect(getButton('Branches').getAttribute('aria-selected')).toBe('true');
    await click(getButton(/Promote & release/));
    expect(getButton('Release').getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#release');
    expect(view.container.querySelector('[role="tabpanel"]')).not.toBeNull();
  });

  it('says so for a folder that is not a git repository, and shows nothing else', async () => {
    serve(status({ isGitRepo: false }));
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain('not a git repository'));
    expect(view.container.querySelector('[role="tab"]')).toBeNull();
    expect(queryButton('Pull')).toBeNull();
  });

  it('asks for an origin and disables Pull without one', async () => {
    serve(status({ hasOrigin: false }));
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain('No origin yet.'));
    expect(view.container.querySelector('a[href="/projects/p1/settings"]')).not.toBeNull();
    expect(getButton('Pull').disabled).toBe(true);
  });

  it('Pull, Refresh and the Auto-pull switch call core', async () => {
    serve(status());
    const view = await open();
    await waitFor(() => getButton('Pull'));
    await click(getButton('Pull'));
    await click(getButton('Refresh'));
    await click(view.container.querySelector('input[role="switch"]') as HTMLInputElement);
    await waitFor(() => expect(calls).toEqual(['pull null', 'fetch null', 'PATCH {"autoPull":false}']));
  });

  it('switching the working branch posts it, and a 409 lists the live runs', async () => {
    serve(status(), {
      'POST /api/projects/p1/git/working-branch': () => {
        throw new ApiRequestError(409, 'runs_live', 'Runs are live.', {
          runs: [{ id: 'r1', title: 'Fix login' }],
        });
      },
    });
    const view = await open();
    await waitFor(() => expect(view.container.querySelectorAll('option')).toHaveLength(3));
    const select = view.container.querySelector('select') as HTMLSelectElement;
    select.value = 'main';
    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Fix login'),
    );
  });

  it.each([
    ['conflict', { files: ['a.ts'] }, {}, 'Pull stopped: a.ts conflict', ['Resolve with a ticket']],
    [
      'conflict',
      { files: ['a.ts'], branch: 'develop' },
      { working: 'diverged' },
      'Pull stopped: a.ts conflict',
      ['Resolve with a ticket', 'Match origin…'],
    ],
    ['rewritten', {}, {}, "Origin's history was rewritten. Match origin keeps", ['Match origin…']],
    ['diverged', { message: 'Both moved.' }, {}, 'Both moved.', ['Match origin…']],
    ['workspace_dirty', {}, {}, 'Pull waits: the main workspace has uncommitted changes', []],
    ['main_unpushed', {}, {}, 'push or promote first', []],
    ['error', { message: 'Origin said no' }, {}, 'Origin said no', []],
    ['idle', { message: 'Checking the merge' }, {}, 'Checking the merge', []],
  ] as const)('shows the %s banner (%j, %j)', async (state, over, page, text, buttons) => {
    serve(
      status({ ...(page as Partial<GitPageStatus>), sync: sync({ state, ...(over as Partial<GitSync>) }) }),
    );
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain(text));
    for (const b of ['Match origin…', 'Resolve with a ticket'])
      expect(queryButton(b) !== null).toBe((buttons as readonly string[]).includes(b));
  });

  it('a conflict in many files names ten in the banner and shows them all on request', async () => {
    const files = Array.from({ length: 90 }, (_, i) => `src/f${i + 1}.ts`);
    serve(status({ sync: sync({ state: 'conflict', files }) }));
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain('and 80 more files conflict'));
    expect(view.container.textContent).not.toContain('src/f11.ts');
    await click(getButton('Show all 90 files'));
    expect(view.container.querySelectorAll('.git-conflict-files li')).toHaveLength(90);
    await click(getButton('Hide the files'));
    expect(view.container.querySelector('.git-conflict-files')).toBeNull();
  });

  it('Match origin… asks first, names the branch and the backup; Resolve with a ticket links to the ticket', async () => {
    serve(status({ sync: sync({ state: 'rewritten', branch: 'develop' }) }));
    await open();
    await waitFor(() => getButton('Match origin…'));
    await click(getButton('Match origin…'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('refs/emberline/backup/develop-');
    // Cancel sends nothing.
    await click(getButton('Cancel', dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toEqual([]);
    await click(getButton('Match origin…'));
    await click(getButton('Match origin', document.querySelector('[role="dialog"]')!));
    await waitFor(() => expect(calls).toContain('match {"branch":"develop"}'));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await cleanup();

    // From a conflict whose branch has diverged from origin, too.
    calls.length = 0;
    serve(
      status({ working: 'diverged', sync: sync({ state: 'conflict', branch: 'develop', files: ['a.ts'] }) }),
    );
    await open();
    await waitFor(() => getButton('Match origin…'));
    await click(getButton('Match origin…'));
    await click(getButton('Match origin', document.querySelector('[role="dialog"]')!));
    await waitFor(() => expect(calls).toContain('match {"branch":"develop"}'));
    await cleanup();

    serve(status({ sync: sync({ state: 'conflict', files: ['a.ts'] }) }), {
      'POST /api/projects/p1/git/pull/ticket': () => ({ ticketId: 't9' }),
    });
    const view = await open();
    await waitFor(() => getButton('Resolve with a ticket'));
    await click(getButton('Resolve with a ticket'));
    await waitFor(() =>
      expect(view.container.querySelector('a[href="/projects/p1/board?ticket=t9"]')).not.toBeNull(),
    );
  });
});

describe('Git page, main workspace off the working branch', () => {
  it('warns on a mismatch and switches back', async () => {
    serve(status({ checkedOut: 'feature', workingMismatch: true }));
    const view = await open();
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        'The main workspace is on feature, not the working branch develop. Factory merges wait until it is switched back.',
      ),
    );
    await click(getButton('Switch back to develop'));
    await waitFor(() => expect(calls).toEqual(['working {"branch":"develop"}']));
  });

  it('warns when the main workspace is detached', async () => {
    serve(status({ checkedOut: null }));
    const view = await open();
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        'The main workspace is not on a branch. Factory merges wait until a branch is checked out.',
      ),
    );
    expect(queryButton(/Switch back/)).toBeNull();
  });

  it("counts origin's new commits, and shows a pulled banner as information", async () => {
    serve(
      status({
        working: 'behind',
        workingCounts: { ahead: 0, behind: 2 },
        sync: sync({ state: 'pulled', message: 'develop now matches origin.' }),
      }),
    );
    const view = await open();
    await waitFor(() => expect(view.container.textContent).toContain('2 new commits on origin'));
    expect(view.container.querySelector('.banner-info')?.textContent).toContain('now matches origin');
  });
});

describe('Git nav item', () => {
  it('is in the top bar after Code Explorer and active on the Git page', async () => {
    const props = {
      location: '/projects/p1/git',
      activeProject: { id: 'p1', name: 'App' },
      mobileNavOpen: false,
      onToggleMobileNav: () => {},
      attentionCount: 0,
      onOpenWizard: () => {},
      theme: 'dark',
      onToggleTheme: () => {},
      onOpenInbox: () => {},
      onOpenCommandPalette: () => {},
      ptyd: 'connecting',
      onLogout: () => {},
    };
    const view = await renderDom(createElement(AppTopbar, props as never), { path: '/projects/p1/git' });
    const tabs = [...view.container.querySelectorAll('a.topbar-tab')];
    const git = tabs.find((a) => a.getAttribute('href') === '/projects/p1/git');
    expect(git?.className).toContain('active');
    expect(git?.getAttribute('title')).toBe('Git: history, branches and releases');
    const code = tabs.findIndex((a) => a.getAttribute('href') === '/projects/p1/code');
    expect(tabs.indexOf(git as Element)).toBe(code + 1);
  });
});

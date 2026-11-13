// @vitest-environment happy-dom
import type { GitBranch, GitPageStatus } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { GitBranchesTab } from './components/git/GitBranchesTab';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoDiff', () => ({
  MonacoDiff: (p: { filePath: string }) => createElement('div', { 'data-testid': 'diff' }, p.filePath),
}));

const branch = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name,
  kind: 'person',
  tip: 'a'.repeat(40),
  subject: 'subject',
  vsMain: { ahead: 1, behind: 0 },
  vsOrigin: null,
  mergedIntoMain: false,
  mergedIntoWorking: false,
  liveRuns: [],
  ...over,
});
const status = {
  isGitRepo: true,
  hasOrigin: true,
  defaultBranch: 'main',
  workingBranch: 'develop',
  backups: ['develop-2026-11-12'],
} as GitPageStatus;
const B = '/api/projects/p1/git';
const calls: string[] = [];
let list: GitBranch[];
let deleteError: unknown = null;

beforeEach(() => {
  calls.length = 0;
  deleteError = null;
  list = [
    branch('main', { kind: 'main', mergedIntoMain: true }),
    branch('develop', { kind: 'working', mergedIntoMain: false }),
    branch('feature/done', { mergedIntoMain: true }),
    branch('feature/wip'),
    branch('emberline/run-1', { kind: 'run', mergedIntoMain: true }),
    branch('emberline/run-2', { kind: 'run' }),
  ];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [`GET ${B}/branches`]: () => list,
      [`POST ${B}/working-branch`]: (body) => {
        calls.push(`working ${JSON.stringify(body)}`);
        throw new ApiRequestError(409, 'runs_live', 'Runs are using the working branch.', {
          runs: [{ id: 'r1', title: 'Fix the login' }],
        });
      },
      [`DELETE ${B}/branches/feature%2Fdone`]: () => {
        calls.push('delete');
        if (deleteError) throw deleteError;
        return { ok: true };
      },
      [`DELETE ${B}/branches/feature%2Fdone?remote=1`]: () => {
        calls.push('delete remote');
        return { ok: true };
      },
      [`GET ${B}/compare?base=develop&head=develop-2026-11-12`]: () => ({
        base: 'develop',
        head: 'develop-2026-11-12',
        mergeBase: null,
        ahead: 3,
        behind: 2,
        files: [],
      }),
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const render = () => renderDom(createElement(GitBranchesTab, { projectId: 'p1', status }));
const rowOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('tbody tr')].find((r) =>
    r.querySelector('td')?.textContent?.startsWith(name),
  );
const has = (row: Element | undefined, label: string) =>
  [...(row?.querySelectorAll('button') ?? [])].some((b) => b.textContent === label);

describe('GitBranchesTab', () => {
  it('hides the run branches behind their count', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('feature/wip'));
    expect(container.textContent).not.toContain('emberline/run-1');
    // A link-styled toggle that says whether it is open, not plain text.
    const toggle = getButton('2 run branches');
    expect(toggle.classList.contains('link-btn')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(getButton('2 run branches').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('emberline/run-1');
    expect(container.textContent).toContain('emberline/run-2');
  });

  it('offers Delete only on a merged branch that is not working, main or in use', async () => {
    list.push(branch('feature/busy', { mergedIntoMain: true, liveRuns: ['r9'] }));
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('feature/wip'));
    expect(has(rowOf(container, 'feature/done'), 'Delete')).toBe(true);
    expect(has(rowOf(container, 'develop'), 'Delete')).toBe(false);
    expect(has(rowOf(container, 'main'), 'Delete')).toBe(false);
    expect(has(rowOf(container, 'feature/wip'), 'Delete')).toBe(false);
    expect(has(rowOf(container, 'feature/busy'), 'Delete')).toBe(false);
    expect(has(rowOf(container, 'develop'), 'Make this the working branch')).toBe(false);
    expect(has(rowOf(container, 'feature/wip'), 'Make this the working branch')).toBe(true);
    await click(getButton('2 run branches'));
    expect(has(rowOf(container, 'emberline/run-1'), 'Make this the working branch')).toBe(false);
  });

  it('sends remote=1 only when Also delete on origin is ticked', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('feature/done'));
    await click(getButton('Delete', rowOf(container, 'feature/done')));
    const box = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    await click(getButton('Delete', document.querySelector('[role="dialog"]')!));
    await waitFor(() => expect(calls).toEqual(['delete']));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await click(getButton('Delete', rowOf(container, 'feature/done')));
    await click(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!);
    await click(getButton('Delete', document.querySelector('[role="dialog"]')!));
    await waitFor(() => expect(calls).toEqual(['delete', 'delete remote']));
  });

  it('lists the runs of a runs_live error', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('feature/wip'));
    await click(getButton('Make this the working branch', rowOf(container, 'feature/wip')));
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Fix the login'),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Runs are using');
  });

  it('compares a backup with the working branch', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('Backups (kept by Match origin)'));
    await click(getButton('Compare'));
    await waitFor(() => expect(container.textContent).toContain('3 ahead, 2 behind'));
  });

  it('lists a branch only on origin: Compare with…, Check out, Make this the working branch', async () => {
    list.push(branch('12112026_backup', { kind: 'origin' }));
    list.push(branch('emberline/run-on-origin', { kind: 'origin' }));
    vi.mocked(api).mockImplementation(
      apiRoutes({
        [`GET ${B}/branches`]: () => list,
        [`POST ${B}/branches`]: (body) => void calls.push(`create ${JSON.stringify(body)}`),
        [`POST ${B}/working-branch`]: (body) => void calls.push(`working ${JSON.stringify(body)}`),
        [`GET ${B}/compare?base=main&head=12112026_backup`]: () => ({
          base: 'main',
          head: '12112026_backup',
          mergeBase: null,
          ahead: 4,
          behind: 0,
          files: [],
        }),
      }),
    );
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('12112026_backup'));
    const row = rowOf(container, '12112026_backup');
    expect(row?.textContent).toContain('on origin');
    expect(row?.textContent).toContain('Only on origin');
    expect(has(row, 'Delete')).toBe(false);
    // An origin-only run branch stays under the run branches' fold.
    expect(container.textContent).not.toContain('emberline/run-on-origin');
    expect(getButton('3 run branches')).toBeDefined();

    await click(getButton('Check out', row));
    await waitFor(() => expect(calls).toEqual(['create {"name":"12112026_backup","from":"origin"}']));
    await click(getButton('Make this the working branch', rowOf(container, '12112026_backup')));
    await waitFor(() => expect(calls).toContain('working {"branch":"12112026_backup"}'));

    const select = rowOf(container, '12112026_backup')!.querySelector('select') as HTMLSelectElement;
    select.value = 'main';
    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() => expect(container.textContent).toContain('4 ahead, 0 behind'));
  });

  it('deletes a merged branch only on origin there alone, and only with the tick', async () => {
    list.push(branch('old-on-origin', { kind: 'origin', mergedIntoMain: true }));
    vi.mocked(api).mockImplementation(
      apiRoutes({
        [`GET ${B}/branches`]: () => list,
        [`DELETE ${B}/branches/old-on-origin?remote=1`]: () => {
          calls.push('delete remote');
          return { ok: true };
        },
      }),
    );
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('old-on-origin'));
    await click(getButton('Delete', rowOf(container, 'old-on-origin')));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('only on origin');
    const confirm = getButton('Delete', dialog);
    expect(confirm.disabled).toBe(true);
    await click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(getButton('Delete', dialog).disabled).toBe(false);
    await click(getButton('Delete', dialog));
    await waitFor(() => expect(calls).toEqual(['delete remote']));
  });

  it('keeps the dialog focus through a re-render and closes on Escape', async () => {
    const { container, rerender } = await render();
    await waitFor(() => expect(container.textContent).toContain('feature/done'));
    await click(getButton('Delete', rowOf(container, 'feature/done')));
    const dialog = document.querySelector('[role="dialog"]')!;
    const box = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    box.focus();
    await rerender(createElement(GitBranchesTab, { projectId: 'p1', status: { ...status } }));
    expect(document.activeElement).toBe(box);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

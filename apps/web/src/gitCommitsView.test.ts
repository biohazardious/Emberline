// @vitest-environment happy-dom
import type { GitCommitSummary, GitPageStatus } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, deferred, renderDom, waitFor } from './domRender';
import { GitCommitsTab } from './components/git/GitCommitsTab';
import { GitDiffView } from './components/git/GitDiffView';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
// Monaco does not run in a DOM test; the stand-in shows which file it was given.
vi.mock('./components/MonacoDiff', () => ({
  MonacoDiff: (p: { filePath: string; modified: string }) =>
    createElement('div', { 'data-testid': 'diff', 'data-modified': p.modified }, p.filePath),
}));

const sha = (n: number) => String(n).repeat(40);
const commit = (n: number, over: Partial<GitCommitSummary> = {}): GitCommitSummary => ({
  sha: sha(n),
  shortSha: String(n).repeat(7),
  subject: `subject ${n}`,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authoredAt: new Date().toISOString(),
  parents: [],
  byFactory: false,
  ticketKey: null,
  ticketId: null,
  labels: [],
  fromOrigin: false,
  ...over,
});
const status = { workingBranch: 'develop' } as GitPageStatus;
const file = (path: string) => ({
  path,
  oldPath: null,
  status: 'modified' as const,
  additions: 2,
  deletions: 1,
  binary: false,
});
const calls: string[] = [];
const B = '/api/projects/p1/git/commits';

beforeEach(() => {
  calls.length = 0;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [`GET ${B}`]: () => ({
        ref: 'develop',
        nextCursor: 50,
        commits: [
          commit(1, {
            byFactory: true,
            ticketKey: 'EMB-4',
            ticketId: 't4',
            labels: [{ kind: 'working', name: 'develop' }],
          }),
          commit(2, { fromOrigin: true }),
        ],
      }),
      [`GET ${B}?cursor=50`]: () => {
        calls.push('cursor=50');
        return { ref: 'develop', nextCursor: null, commits: [commit(3)] };
      },
      [`GET ${B}/${sha(1)}`]: () => ({
        sha: sha(1),
        message: 'subject 1\n\nbody',
        parents: [],
        files: [file('a.ts'), file('b.ts')],
      }),
      [`GET ${B}/${sha(2)}`]: () => ({
        sha: sha(2),
        message: 'subject 2\n\nbody',
        parents: [],
        files: [file('a.ts')],
      }),
      [`GET ${B}/${sha(1)}/file?path=a.ts`]: () => ({
        path: 'a.ts',
        original: '',
        modified: 'x',
        binary: false,
        truncated: false,
      }),
      [`GET ${B}/${sha(1)}/file?path=b.ts`]: () => ({
        path: 'b.ts',
        original: '',
        modified: 'y',
        binary: false,
        truncated: false,
      }),
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const render = () => renderDom(createElement(GitCommitsTab, { projectId: 'p1', status }));
const press = (key: string, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('GitCommitsTab', () => {
  it('shows labels and the factory, origin and ticket chips', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('subject 2'));
    const rows = container.querySelectorAll('.commit-row');
    expect(rows[0]?.classList.contains('commit-row--factory')).toBe(true);
    expect(rows[1]?.classList.contains('commit-row--factory')).toBe(false);
    expect(rows[0]?.textContent).toContain('factory');
    expect(rows[0]?.textContent).toContain('develop');
    expect(rows[1]?.textContent).toContain('from origin');
    const link = rows[0]?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/projects/p1/board?ticket=t4');
    expect(link?.textContent).toBe('EMB-4');
  });

  it('j selects the next file', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('a.ts'));
    await click(container.querySelectorAll('.commit-row-main')[0]!);
    press('j');
    await waitFor(() => expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('b.ts'));
  });

  it('j typed in an input does not move', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('a.ts'));
    const input = document.body.appendChild(document.createElement('input'));
    press('j', input);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('a.ts');
  });

  it('Load more fetches cursor=50', async () => {
    const { container } = await render();
    await waitFor(() => expect(container.textContent).toContain('subject 2'));
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Load more')!);
    await waitFor(() => expect(container.textContent).toContain('subject 3'));
    expect(calls).toEqual(['cursor=50']);
  });

  it('goes back to the newest commit when the working branch changes', async () => {
    const { container, rerender } = await render();
    await waitFor(() => expect(container.textContent).toContain('subject 1\n\nbody'));
    await click(container.querySelectorAll('.commit-row-main')[1]!);
    await waitFor(() =>
      expect(container.querySelector('.git-commit-message')?.textContent).toContain('subject 2'),
    );
    await rerender(
      createElement(GitCommitsTab, { projectId: 'p1', status: { workingBranch: 'next' } as GitPageStatus }),
    );
    await waitFor(() =>
      expect(container.querySelector('.git-commit-message')?.textContent).toContain('subject 1'),
    );
  });
});

describe('GitDiffView', () => {
  const diffOf = (modified: string) => ({
    path: 'a.ts',
    original: '',
    modified,
    binary: false,
    truncated: false,
  });

  it('does not show the previous source diff for the same path', async () => {
    const first = vi.fn(async () => diffOf('first'));
    const gate = deferred<ReturnType<typeof diffOf>>();
    const second = vi.fn(() => gate.promise);
    const { container, rerender } = await renderDom(
      createElement(GitDiffView, { files: [file('a.ts')], loadFile: first }),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diff"]')?.getAttribute('data-modified')).toBe('first'),
    );
    await rerender(createElement(GitDiffView, { files: [file('a.ts')], loadFile: second }));
    expect(container.querySelector('[data-testid="diff"]')).toBeNull();
    gate.resolve(diffOf('second'));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diff"]')?.getAttribute('data-modified')).toBe('second'),
    );
  });
});

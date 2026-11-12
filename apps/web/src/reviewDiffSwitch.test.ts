// @vitest-environment happy-dom
import type { DiffFile, Run, RunDiffSummary, RunFileDiff } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { ReviewView } from './components/ReviewView';
import { apiRoutes, cleanup, deferred, renderDom, settle, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/TerminalView', () => ({ TerminalView: () => null }));

/** A stand-in for Monaco that counts the editors and text models it makes and throws away. */
const fake = vi.hoisted(() => {
  const counts = { editors: 0, editorsDisposed: 0, models: 0, modelsDisposed: 0 };
  type Model = { value: string; getValue(): string; setValue(v: string): void; getLanguageId(): string };
  let shown: { original: Model; modified: Model } | null = null;
  const sub = { dispose: () => undefined };
  const side = {
    onMouseDown: () => sub,
    onDidChangeCursorPosition: () => sub,
    createDecorationsCollection: () => ({ set: () => undefined }),
    revealLineInCenter: () => undefined,
    setPosition: () => undefined,
  };
  const monaco = {
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      setTheme: () => undefined,
      setModelLanguage: () => undefined,
      createModel(value: string, language: string) {
        counts.models += 1;
        const model = {
          value,
          getValue: () => model.value,
          setValue: (v: string) => {
            model.value = v;
          },
          getLanguageId: () => language,
          dispose: () => {
            counts.modelsDisposed += 1;
          },
        };
        return model;
      },
      createDiffEditor() {
        counts.editors += 1;
        return {
          setModel: (m: typeof shown) => {
            shown = m;
          },
          getModel: () => shown,
          getModifiedEditor: () => side,
          getOriginalEditor: () => side,
          updateOptions: () => undefined,
          dispose: () => {
            counts.editorsDisposed += 1;
          },
        };
      },
    },
  };
  return {
    counts,
    monaco,
    shownText: () => shown?.modified.getValue() ?? null,
    shownModel: () => shown?.modified ?? null,
    reset() {
      Object.assign(counts, { editors: 0, editorsDisposed: 0, models: 0, modelsDisposed: 0 });
      shown = null;
    },
  };
});
vi.mock('./monaco', () => ({
  loadMonaco: () => Promise.resolve(fake.monaco),
  monacoTheme: (mode: string) => mode,
}));

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
  state: 'done',
  branch: 'emberline/run-r1',
  worktreePath: '/workspaces/shop/.worktrees/r1',
  endedAt: '2026-11-12T11:00:00.000Z',
  stateChangedAt: '2026-11-12T11:00:00.000Z',
  attention: null,
} as unknown as Run;

const PATHS = ['a.ts', 'b.ts', 'c.ts'];
const file = (path: string): DiffFile => ({
  path,
  oldPath: null,
  status: 'modified',
  additions: 1,
  deletions: 1,
  hash: `h-${path}`,
  staged: false,
  unstaged: false,
});
const summary: RunDiffSummary = {
  runId: 'r1',
  isGitRepo: true,
  branch: 'emberline/run-r1',
  baseBranch: 'main',
  headSha: 'abc',
  aheadCount: 1,
  clean: false,
  hasRemote: false,
  scope: 'branch',
  totalAdditions: 3,
  totalDeletions: 3,
  files: PATHS.map(file),
};
const fileDiff = (path: string): RunFileDiff => ({
  path,
  scope: 'branch',
  status: 'modified',
  binary: false,
  original: `old ${path}`,
  modified: `new ${path}`,
  patch: `-old ${path}\n+new ${path}`,
});

/** Diffs the test answers by hand (the request stays in flight until it does); the rest answer at once. */
let held: Map<string, ReturnType<typeof deferred<RunFileDiff>>>;
let fileRequests: string[];

beforeEach(() => {
  fake.reset();
  held = new Map();
  fileRequests = [];
  const routes: Record<string, () => unknown> = {
    'GET /api/runs/r1/diff?scope=branch': () => summary,
    'GET /api/runs/r1/review': () => ({ comments: [], viewed: [], blockingOpen: 0, carriedBlocking: null }),
  };
  for (const path of PATHS) {
    routes[`GET /api/runs/r1/diff/file?path=${path}&scope=branch`] = () => {
      fileRequests.push(path);
      return held.get(path)?.promise ?? fileDiff(path);
    };
  }
  vi.mocked(api).mockImplementation(apiRoutes(routes));
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const press = (key: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
const shownPath = () => document.querySelector('[data-testid="active-diff-path"]')?.textContent ?? null;
const pending = () => document.querySelector('.monaco-diff-pending') !== null;

async function openReview() {
  await renderDom(createElement(ReviewView, { run }), { path: '/runs/r1/review' });
  await waitFor(() => expect(document.querySelector('[data-monaco-ready="true"]')).not.toBeNull());
  expect(shownPath()).toBe('a.ts');
  expect(fake.shownText()).toBe('new a.ts');
}

describe('ReviewView: switching files keeps one Monaco diff editor', () => {
  it('j/k swap pooled models in the same editor instead of rebuilding it', async () => {
    await openReview();
    await press('j');
    await waitFor(() => expect(fake.shownText()).toBe('new b.ts'));
    const bModel = fake.shownModel();
    await press('j');
    await waitFor(() => expect(fake.shownText()).toBe('new c.ts'));
    await press('k');
    await waitFor(() => expect(fake.shownText()).toBe('new b.ts'));
    await press('k');
    await waitFor(() => expect(fake.shownText()).toBe('new a.ts'));

    expect(fake.counts).toEqual({ editors: 1, editorsDisposed: 0, models: 6, modelsDisposed: 0 });
    // The second visit to b.ts was served from the cache and its models from the pool.
    expect(fileRequests).toEqual(['a.ts', 'b.ts', 'c.ts']);
    await press('j');
    expect(fake.shownModel()).toBe(bModel);
    expect(fake.counts.models).toBe(6);
  });

  it('while the next diff loads, the last one stays on screen under a loading cover', async () => {
    await openReview();
    held.set('b.ts', deferred<RunFileDiff>());
    await press('j');
    await settle();
    expect(shownPath()).toBe('b.ts');
    expect(pending()).toBe(true);
    expect(document.body.textContent).not.toContain('Select a changed file');
    expect(fake.shownText()).toBe('new a.ts');

    await act(async () => held.get('b.ts')!.resolve(fileDiff('b.ts')));
    await waitFor(() => expect(fake.shownText()).toBe('new b.ts'));
    expect(pending()).toBe(false);
    expect(fake.counts.editors).toBe(1);
    expect(fake.counts.editorsDisposed).toBe(0);
  });
});

describe('ReviewView: a late diff for a file already left', () => {
  it('A → B (slow) → back to A: B arriving afterwards does not replace A', async () => {
    await openReview();
    held.set('b.ts', deferred<RunFileDiff>());
    await press('j');
    await settle();
    expect(shownPath()).toBe('b.ts');
    await press('k');
    expect(shownPath()).toBe('a.ts');
    expect(pending()).toBe(false);

    await act(async () => held.get('b.ts')!.resolve(fileDiff('b.ts')));
    await settle();
    expect(shownPath()).toBe('a.ts');
    expect(fake.shownText()).toBe('new a.ts');
    expect(pending()).toBe(false);
    expect(document.querySelector('.monaco-diff-shell')?.hasAttribute('hidden')).toBe(false);
    expect(
      document.querySelector('[data-file-path][aria-selected="true"]')?.getAttribute('data-file-path'),
    ).toBe('a.ts');
  });
});

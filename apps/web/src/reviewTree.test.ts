import type { DiffFile, ReviewComment } from '@emberline/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type DisposableTextModel,
  LazyMonacoModelPool,
  type MonacoModelApi,
} from './components/review/monacoModelPool';
import {
  ancestorDirPaths,
  buildReviewTree,
  computeVirtualWindow,
  filterDiffFiles,
  flattenReviewTree,
  indexCommentCounts,
  orderedTreeFiles,
} from './reviewTree';

function shaFor(seed: string): string {
  let hex = '';
  for (let i = 0; i < 40; i += 1) {
    hex += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
  }
  return hex;
}

function makeFile(path: string, additions = 5, deletions = 2): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions,
    deletions,
    hash: shaFor(path),
    staged: false,
    unstaged: false,
  };
}

function makeComment(overrides: Partial<ReviewComment> & { id: string; filePath: string }): ReviewComment {
  return {
    runId: 'r1',
    round: 1,
    line: 8,
    currentLine: 8,
    outdated: false,
    anchorText: null,
    anchorHash: 'h',
    verifiedAt: null,
    side: 'modified',
    body: 'Feedback',
    intent: 'fix',
    priority: 'important',
    status: 'open',
    createdAt: '2026-11-12T06:00:00.000Z',
    sentAt: null,
    resolvedAt: null,
    carriedTo: null,
    ...overrides,
  };
}

describe('reviewTree: hierarchy, counts, filtering, and virtualisation', () => {
  it('indexes per-file open and blocking counts while ignoring resolved comments', () => {
    const idx = indexCommentCounts([
      makeComment({ id: 'c1', filePath: 'apps/web/src/a.tsx', priority: 'blocking' }),
      makeComment({ id: 'c2', filePath: 'apps/web/src/a.tsx', priority: 'important', status: 'sent' }),
      makeComment({ id: 'c3', filePath: 'apps/web/src/a.tsx', priority: 'blocking', status: 'resolved' }),
      makeComment({ id: 'c4', filePath: 'apps/core/src/b.ts', priority: 'suggestion' }),
    ]);

    expect(idx.totalOpen).toBe(3);
    expect(idx.totalBlocking).toBe(1);
    expect(idx.commentedFileCount).toBe(2);
    expect(idx.byFile.get('apps/web/src/a.tsx')).toEqual({ open: 2, blocking: 1 });
    expect(idx.byFile.get('apps/core/src/b.ts')).toEqual({ open: 1, blocking: 0 });
  });

  it('compacts single-child directories and rolls up file/comment/blocking counts', () => {
    const files = [
      makeFile('README.md', 4, 1),
      makeFile('apps/web/src/pages/ReviewPage.tsx', 40, 10),
      makeFile('apps/web/src/components/ReviewView.tsx', 60, 20),
    ];
    const counts = indexCommentCounts([
      makeComment({ id: 'c1', filePath: 'apps/web/src/pages/ReviewPage.tsx', priority: 'blocking' }),
      makeComment({ id: 'c2', filePath: 'apps/web/src/components/ReviewView.tsx', priority: 'important' }),
    ]);

    const tree = buildReviewTree(files, counts.byFile, new Map());
    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({
      kind: 'dir',
      path: 'apps/web/src',
      label: 'apps/web/src',
      fileCount: 2,
      openComments: 2,
      blockingComments: 1,
      additions: 100,
      deletions: 30,
    });
    expect(tree[1]).toMatchObject({
      kind: 'file',
      path: 'README.md',
    });

    const ordered = orderedTreeFiles(tree);
    expect(ordered.map((f) => f.path)).toEqual([
      'apps/web/src/components/ReviewView.tsx',
      'apps/web/src/pages/ReviewPage.tsx',
      'README.md',
    ]);

    const flat = flattenReviewTree(tree, new Set(['apps/web/src']));
    expect(flat.map((r) => `${r.kind}:${r.path}`)).toEqual(['dir:apps/web/src', 'file:README.md']);
    expect(ancestorDirPaths(tree, 'apps/web/src/pages/ReviewPage.tsx')).toEqual([
      'apps/web/src',
      'apps/web/src/pages',
    ]);
  });

  it('filters files by query and mode (commented, blocking, unviewed)', () => {
    const files = [makeFile('src/alpha.ts'), makeFile('src/beta.ts'), makeFile('src/gamma.ts')];
    const counts = indexCommentCounts([
      makeComment({ id: '1', filePath: 'src/alpha.ts', priority: 'blocking' }),
      makeComment({ id: '2', filePath: 'src/beta.ts', priority: 'important' }),
    ]);
    const viewed = new Map([['src/gamma.ts', shaFor('src/gamma.ts')]]);

    expect(filterDiffFiles(files, counts.byFile, viewed, '', 'commented').map((f) => f.path)).toEqual([
      'src/alpha.ts',
      'src/beta.ts',
    ]);
    expect(filterDiffFiles(files, counts.byFile, viewed, '', 'blocking').map((f) => f.path)).toEqual([
      'src/alpha.ts',
    ]);
    expect(filterDiffFiles(files, counts.byFile, viewed, '', 'unviewed').map((f) => f.path)).toEqual([
      'src/alpha.ts',
      'src/beta.ts',
    ]);
    expect(filterDiffFiles(files, counts.byFile, viewed, 'GAMMA', 'all').map((f) => f.path)).toEqual([
      'src/gamma.ts',
    ]);
  });

  it('computes a bounded virtual window for 350 rows with exact spacer geometry', () => {
    const totalCount = 350;
    const rowHeight = 30;
    const win = computeVirtualWindow({
      totalCount,
      scrollTop: 3000,
      viewportHeight: 480,
      rowHeight,
      overscan: 8,
    });
    const renderedCount = win.endIndex - win.startIndex;

    expect(renderedCount).toBeLessThanOrEqual(34);
    expect(win.topSpacerPx + renderedCount * rowHeight + win.bottomSpacerPx).toBe(totalCount * rowHeight);
  });
});

describe('LazyMonacoModelPool', () => {
  interface FakeModel extends DisposableTextModel {
    disposed: boolean;
    setLanguage(nextLang: string): void;
  }

  function createFakeEditorApi(): { created: FakeModel[]; api: MonacoModelApi<FakeModel> } {
    const created: FakeModel[] = [];
    return {
      created,
      api: {
        createModel: vi.fn((initial: string, lang = 'plaintext'): FakeModel => {
          let value = initial;
          let languageId = lang;
          const model: FakeModel = {
            disposed: false,
            getValue: () => value,
            setValue: (next: string) => {
              value = next;
            },
            getLanguageId: () => languageId,
            setLanguage: (nextLang: string) => {
              languageId = nextLang;
            },
            dispose: vi.fn(() => {
              model.disposed = true;
            }),
          };
          created.push(model);
          return model;
        }),
        setModelLanguage: vi.fn((model: FakeModel, lang: string) => {
          model.setLanguage(lang);
        }),
      },
    };
  }

  it('creates Monaco models strictly lazily per viewed file and evicts LRU entries cleanly', () => {
    const { created, api } = createFakeEditorApi();
    const pool = new LazyMonacoModelPool<FakeModel>(api, 3);

    const first = pool.acquire('file-0.ts\0typescript', {
      original: 'const a = 1;',
      modified: 'const a = 2;',
      language: 'typescript',
    });
    expect(pool.totalCreatedPairs).toBe(1);
    expect(created).toHaveLength(2);

    const revisited = pool.acquire('file-0.ts\0typescript', {
      original: 'const a = 1;',
      modified: 'const a = 3;',
      language: 'typescript',
    });
    expect(revisited).toBe(first);
    expect(pool.totalCreatedPairs).toBe(1);
    expect(first.modified.getValue()).toBe('const a = 3;');

    pool.acquire('file-1.ts\0typescript', { original: '1', modified: '2', language: 'typescript' });
    pool.acquire('file-2.ts\0typescript', { original: '1', modified: '2', language: 'typescript' });
    expect(pool.size).toBe(3);
    expect(first.original.disposed).toBe(false);

    pool.acquire('file-3.ts\0typescript', { original: '1', modified: '2', language: 'typescript' });
    expect(pool.size).toBe(3);
    expect(first.original.disposed).toBe(true);
    expect(first.modified.disposed).toBe(true);

    let detached = false;
    pool.disposeAll(() => {
      detached = true;
    });
    expect(detached).toBe(true);
    expect(pool.size).toBe(0);
    expect(created.every((m) => m.disposed)).toBe(true);
  });
});

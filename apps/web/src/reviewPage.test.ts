// @vitest-environment happy-dom
import type {
  DiffFile,
  ReviewComment,
  RunDetail,
  RunDiffSummary,
  RunFileDiff,
  RunReviewState,
} from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { ReviewPage } from './pages/ReviewPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

vi.mock('./monaco', () => ({
  loadMonaco: () => new Promise(() => undefined),
}));

vi.mock('./components/TerminalView', () => ({ TerminalView: () => null }));

function build300FileFixture(): DiffFile[] {
  const files: DiffFile[] = [];
  for (let i = 0; i < 300; i += 1) {
    const pkg = `pkg-${String(Math.floor(i / 25)).padStart(2, '0')}`;
    const name = `mod-${String(i).padStart(3, '0')}.ts`;
    files.push({
      path: `packages/${pkg}/src/${name}`,
      oldPath: null,
      status: i % 7 === 0 ? 'added' : 'modified',
      additions: (i % 15) + 1,
      deletions: i % 5,
      hash: `${String(i).padStart(40, 'a')}`,
      staged: false,
      unstaged: false,
    });
  }
  return files;
}

const runDetail = {
  id: 'r-300',
  projectId: 'proj-1',
  ticketId: 'EMB-21',
  title: 'EMB-21 Keyboard-first review',
  prompt: 'Implement keyboard-first review page',
  agent: 'claude',
  state: 'done',
  cancelled: false,
  autoRetry: null,
  handedOffTo: null,
  branch: 'emberline/emb-21',
  worktreePath: '/workspaces/.worktrees/emberline/r-300',
  terminalId: null,
  reviewReady: false,
  predecessorRunId: null,
  endedAt: '2026-11-12T06:00:00.000Z',
  stateChangedAt: '2026-11-12T06:00:00.000Z',
  attention: null,
} as unknown as RunDetail;

function pressKey(key: string, init: KeyboardEventInit = {}) {
  return act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe('ReviewPage: 300-file virtualised tree, inline merge gate, and keyboard shortcuts', () => {
  let files: DiffFile[];
  let comments: ReviewComment[];
  let fileDiffRequests: string[];

  const reviewState = (): RunReviewState => {
    const unresolved = comments.filter((c) => c.status !== 'resolved');
    const blockingOpen = unresolved.filter((c) => c.priority === 'blocking').length;
    return {
      comments,
      viewed: [],
      blockingOpen,
      carriedBlocking: null,
    };
  };

  beforeEach(() => {
    files = build300FileFixture();
    fileDiffRequests = [];
    comments = [
      {
        id: 'c-first',
        runId: 'r-300',
        round: 1,
        filePath: files[0]!.path,
        line: 3,
        currentLine: 3,
        outdated: false,
        anchorText: null,
        anchorHash: 'h0',
        verifiedAt: null,
        side: 'modified',
        body: 'Validate input bounds before slicing window',
        intent: 'fix',
        priority: 'important',
        status: 'open',
        createdAt: '2026-11-12T06:01:00.000Z',
        sentAt: null,
        resolvedAt: null,
        carriedTo: null,
      },
      {
        id: 'c-block-2',
        runId: 'r-300',
        round: 1,
        filePath: files[2]!.path,
        line: 12,
        currentLine: 12,
        outdated: false,
        anchorText: null,
        anchorHash: 'h2',
        verifiedAt: null,
        side: 'modified',
        body: 'Blocking leak: dispose Monaco text models on unmount',
        intent: 'fix',
        priority: 'blocking',
        status: 'open',
        createdAt: '2026-11-12T06:02:00.000Z',
        sentAt: null,
        resolvedAt: null,
        carriedTo: null,
      },
    ];

    const summary: RunDiffSummary = {
      runId: 'r-300',
      isGitRepo: true,
      branch: 'emberline/emb-21',
      baseBranch: 'main',
      headSha: 'abc1234',
      aheadCount: 1,
      clean: true,
      hasRemote: false,
      scope: 'branch',
      files,
      totalAdditions: 1200,
      totalDeletions: 300,
    };

    vi.mocked(api).mockImplementation((async (rawPath: string, method = 'GET', body?: unknown) => {
      const url = new URL(rawPath, 'http://localhost');
      const key = `${method} ${url.pathname}`;

      if (key === 'GET /api/runs/r-300') return runDetail;
      if (key === 'GET /api/runs/r-300/diff') return summary;
      if (key === 'GET /api/runs/r-300/diff/file') {
        const filePath = url.searchParams.get('path') ?? files[0]!.path;
        fileDiffRequests.push(filePath);
        const diff: RunFileDiff = {
          path: filePath,
          scope: 'branch',
          status: 'modified',
          original: `export const file = '${filePath}';\nexport const v = 1;\n`,
          modified: `export const file = '${filePath}';\nexport const v = 2;\n`,
          patch: `@@ -1,2 +1,2 @@\n export const file = '${filePath}';\n-export const v = 1;\n+export const v = 2;`,
          binary: false,
        };
        return diff;
      }
      if (key === 'GET /api/runs/r-300/review') return reviewState();
      if (key === 'GET /api/runs/r-300/artifacts') return [];
      if (key === 'POST /api/runs/r-300/review/comments') {
        const payload = body as { filePath: string; body: string; priority: ReviewComment['priority'] };
        const created: ReviewComment = {
          id: `c-new-${comments.length + 1}`,
          runId: 'r-300',
          round: 1,
          filePath: payload.filePath,
          line: null,
          currentLine: null,
          outdated: false,
          anchorText: null,
          anchorHash: null,
          verifiedAt: null,
          side: 'modified',
          body: payload.body,
          intent: 'fix',
          priority: payload.priority,
          status: 'open',
          createdAt: '2026-11-12T06:05:00.000Z',
          sentAt: null,
          resolvedAt: null,
          carriedTo: null,
        };
        comments = [...comments, created];
        return created;
      }
      if (url.pathname.startsWith('/api/runs/r-300/review/comments/') && method === 'PATCH') {
        const id = url.pathname.split('/').pop()!;
        const patch = body as Partial<ReviewComment>;
        comments = comments.map((c) => (c.id === id ? { ...c, ...patch } : c));
        return comments.find((c) => c.id === id);
      }

      throw new ApiRequestError(404, 'not_found', `no test route for ${method} ${rawPath}`);
    }) as typeof api);
  });

  afterEach(async () => {
    await cleanup();
    vi.mocked(api).mockReset();
  });

  it('virtualises a 300-file tree, shows per-file counts & inline merge gate links, and handles shortcuts', async () => {
    await renderDom(createElement(ReviewPage, { id: 'r-300' }), { path: '/runs/r-300/review' });

    await waitFor(() => {
      const activePath = document.querySelector('[data-testid="active-diff-path"]');
      expect(activePath?.textContent).toBe(files[0]!.path);
    });

    expect(fileDiffRequests).toEqual([files[0]!.path]);

    expect(document.body.textContent).toContain('Changed Files (300)');
    const renderedTreeItems = document.querySelectorAll('[role="treeitem"]');
    expect(renderedTreeItems.length).toBeGreaterThan(5);
    expect(renderedTreeItems.length).toBeLessThan(60);

    const file0Comments = document.querySelector(`[data-testid="file-comments-${files[0]!.path}"]`);
    expect(file0Comments?.textContent).toBe('1');
    expect(file0Comments?.className).toContain('review-tabular');

    const file2Blocking = document.querySelector(`[data-testid="file-blocking-${files[2]!.path}"]`);
    expect(file2Blocking?.textContent).toBe('1!');

    const gateAlert = document.querySelector('[aria-label="Merge gate blocking reasons"]');
    expect(gateAlert).not.toBeNull();
    expect(gateAlert?.textContent).toContain('Merge gate blocked (1)');
    const gateLink = gateAlert?.querySelector<HTMLAnchorElement>('a[href="#review-comment-c-block-2"]');
    expect(gateLink).not.toBeNull();
    expect(gateLink?.textContent).toContain(files[2]!.path);

    await click(gateLink!);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="active-diff-path"]')?.textContent).toBe(files[2]!.path);
      const chip = document.getElementById('review-comment-c-block-2');
      expect(chip?.getAttribute('data-focused')).toBe('true');
    });

    await pressKey('k');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="active-diff-path"]')?.textContent).toBe(files[1]!.path);
      const row = document.querySelector(`[data-file-path="${files[1]!.path}"]`);
      expect(row?.getAttribute('data-focused')).toBe('true');
      expect(row?.className).toContain('review-tree-row-focused');
    });

    await pressKey('p');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="active-diff-path"]')?.textContent).toBe(files[0]!.path);
      expect(document.getElementById('review-comment-c-first')?.getAttribute('data-focused')).toBe('true');
    });

    await pressKey('b');
    await waitFor(() => {
      expect(document.body.textContent).toContain('Merge gate blocked (2)');
    });

    await pressKey('c');
    let textarea: HTMLTextAreaElement | null = null;
    await waitFor(() => {
      textarea = document.querySelector<HTMLTextAreaElement>('textarea.comment-composer-body');
      expect(textarea).not.toBeNull();
    });
    await typeInto(textarea!, 'j k n p b ? check');
    expect(document.querySelector('[data-testid="active-diff-path"]')?.textContent).toBe(files[0]!.path);
    await click(getButton('Cancel'));

    await pressKey('?', { shiftKey: true });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Review Keyboard Shortcuts');
    });
    await pressKey('Escape');
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});

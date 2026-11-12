// @vitest-environment happy-dom
import type { DiffFile } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReviewFileTree } from './components/review/ReviewFileTree';
import { cleanup, renderDom, settle } from './domRender';
import { indexCommentCounts } from './reviewTree';

const VIEWPORT_PX = 300;
const ROW_PX = 30;

const files: DiffFile[] = Array.from({ length: 100 }, (_, i) => ({
  path: `f${String(i).padStart(3, '0')}.ts`,
  oldPath: null,
  status: 'modified',
  additions: 1,
  deletions: 0,
  hash: `h${i}`,
  staged: false,
  unstaged: false,
}));

const tree = (selectedFile: string | null) =>
  createElement(ReviewFileTree, {
    files,
    loading: false,
    hasSummary: true,
    scope: 'branch',
    selectedFile,
    keyboardFocusedFile: null,
    commentIndex: indexCommentCounts([]),
    viewedByPath: new Map(),
    filterQuery: '',
    onFilterQueryChange: () => undefined,
    filterMode: 'all',
    onFilterModeChange: () => undefined,
    onSelectFile: () => undefined,
    onToggleViewed: () => undefined,
    onStageToggle: () => undefined,
  });

const viewport = () => document.querySelector<HTMLElement>('.review-tree-viewport')!;
const userScroll = async (top: number) => {
  await act(async () => {
    viewport().scrollTop = top;
    viewport().dispatchEvent(new Event('scroll'));
  });
  await settle();
};
const renderedPaths = () =>
  [...document.querySelectorAll<HTMLElement>('[data-file-path]')].map((el) => el.dataset.filePath);

// happy-dom lays nothing out: give the tree viewport a height so the virtual window has one.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('review-tree-viewport') ? VIEWPORT_PX : 0;
    },
  });
});
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
});
afterEach(cleanup);

describe('ReviewFileTree: scrolling a virtualised tree', () => {
  it('a scroll that takes the selected file out of view is not snapped back', async () => {
    await renderDom(tree('f000.ts'));
    await userScroll(1500);
    expect(viewport().scrollTop).toBe(1500);
    expect(renderedPaths()).toContain('f055.ts');
    expect(renderedPaths()).not.toContain('f000.ts');
  });

  it('moving the selection scrolls it into view, and the user can scroll away again', async () => {
    const view = await renderDom(tree('f000.ts'));
    await view.rerender(tree('f080.ts'));
    await settle();
    expect(viewport().scrollTop).toBe(81 * ROW_PX - VIEWPORT_PX);
    expect(renderedPaths()).toContain('f080.ts');

    await userScroll(0);
    expect(viewport().scrollTop).toBe(0);
    expect(renderedPaths()).toContain('f000.ts');

    await view.rerender(tree('f005.ts'));
    await settle();
    expect(viewport().scrollTop).toBe(0);
  });
});

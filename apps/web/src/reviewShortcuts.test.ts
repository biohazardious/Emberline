import type { ReviewComment } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  isEditableShortcutTarget,
  orderNavigableComments,
  REVIEW_SHORTCUTS,
  type ReviewShortcutContext,
  resolveReviewShortcut,
} from './reviewShortcuts';

function makeComment(overrides: Partial<ReviewComment> & { id: string; filePath: string }): ReviewComment {
  return {
    runId: 'r1',
    round: 1,
    line: 10,
    currentLine: 10,
    outdated: false,
    anchorText: null,
    anchorHash: 'h',
    verifiedAt: null,
    side: 'modified',
    body: `Comment ${overrides.id}`,
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

function baseContext(overrides: Partial<ReviewShortcutContext> = {}): ReviewShortcutContext {
  return {
    files: ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/src/c.ts'],
    selectedFile: 'apps/web/src/a.ts',
    comments: [],
    focusedCommentId: null,
    activeLine: null,
    draftOpen: false,
    shortcutSheetOpen: false,
    modalOpen: false,
    subTab: 'diff',
    ...overrides,
  };
}

describe('reviewShortcuts: editable target guard', () => {
  it('suppresses shortcuts in text inputs, textareas, selects, and contenteditable nodes', () => {
    expect(isEditableShortcutTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('allows shortcuts on checkboxes, buttons, and Monaco read-only cursor textarea', () => {
    expect(isEditableShortcutTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isEditableShortcutTarget({ tagName: 'BUTTON' })).toBe(false);

    const monacoCursor = {
      tagName: 'TEXTAREA',
      classList: { contains: (cls: string) => cls === 'inputarea' },
      closest: (sel: string) => (sel === '.monaco-editor' ? {} : null),
    };
    expect(isEditableShortcutTarget(monacoCursor)).toBe(false);

    const monacoFindInput = {
      tagName: 'TEXTAREA',
      classList: { contains: (cls: string) => cls === 'inputarea' },
      closest: (sel: string) => (sel === '.monaco-editor' || sel === '.find-widget' ? {} : null),
    };
    expect(isEditableShortcutTarget(monacoFindInput)).toBe(true);
  });
});

describe('reviewShortcuts: navigable comment ordering & shortcut actions', () => {
  it('exposes documented shortcut specifications for the ? sheet', () => {
    const allKeys = REVIEW_SHORTCUTS.flatMap((s) => s.keys);
    expect(allKeys).toEqual(expect.arrayContaining(['j', 'k', 'n', 'p', 'c', 'b', '?', 'Esc']));
  });

  it('orders unresolved comments by tree file order, line, and off-diff tail', () => {
    const comments = [
      makeComment({ id: 'off', filePath: 'removed/old.ts', currentLine: 4 }),
      makeComment({ id: 'b-20', filePath: 'apps/web/src/b.ts', currentLine: 20 }),
      makeComment({ id: 'resolved', filePath: 'apps/web/src/a.ts', currentLine: 1, status: 'resolved' }),
      makeComment({ id: 'a-12', filePath: 'apps/web/src/a.ts', currentLine: 12 }),
      makeComment({ id: 'a-3', filePath: 'apps/web/src/a.ts', currentLine: 3 }),
    ];
    const ordered = orderNavigableComments(comments, ['apps/web/src/a.ts', 'apps/web/src/b.ts']);
    expect(ordered.map((c) => c.id)).toEqual(['a-3', 'a-12', 'b-20', 'off']);
  });

  it('navigates next/previous files with j and k and clamps at boundaries', () => {
    const firstToSecond = resolveReviewShortcut({ key: 'j' }, baseContext());
    expect(firstToSecond).toEqual({
      type: 'select-file',
      filePath: 'apps/web/src/b.ts',
      index: 1,
    });

    const atStartK = resolveReviewShortcut({ key: 'k' }, baseContext({ selectedFile: 'apps/web/src/a.ts' }));
    expect(atStartK).toBeNull();

    const atEndJ = resolveReviewShortcut({ key: 'j' }, baseContext({ selectedFile: 'apps/web/src/c.ts' }));
    expect(atEndJ).toBeNull();

    const fromUnselected = resolveReviewShortcut({ key: 'j' }, baseContext({ selectedFile: null }));
    expect(fromUnselected).toEqual({
      type: 'select-file',
      filePath: 'apps/web/src/a.ts',
      index: 0,
    });
  });

  it('cycles through comments across files with n and p and wraps around', () => {
    const c1 = makeComment({ id: 'c1', filePath: 'apps/web/src/a.ts', currentLine: 5 });
    const c2 = makeComment({ id: 'c2', filePath: 'apps/web/src/b.ts', currentLine: 18 });
    const ctx = baseContext({ comments: [c1, c2], focusedCommentId: 'c1' });

    const next = resolveReviewShortcut({ key: 'n' }, ctx);
    expect(next).toEqual({
      type: 'focus-comment',
      comment: c2,
      selectFilePath: 'apps/web/src/b.ts',
    });

    const wrapPrev = resolveReviewShortcut({ key: 'p' }, ctx);
    expect(wrapPrev).toEqual({
      type: 'focus-comment',
      comment: c2,
      selectFilePath: 'apps/web/src/b.ts',
    });

    // When on an uncommented middle file with no comment focused, n/p step spatially relative to selectedFile.
    const c3 = makeComment({ id: 'c3', filePath: 'apps/web/src/c.ts', currentLine: 9 });
    const middleCtx = baseContext({
      selectedFile: 'apps/web/src/b.ts',
      comments: [c1, c3],
      focusedCommentId: null,
    });
    expect(resolveReviewShortcut({ key: 'n' }, middleCtx)).toEqual({
      type: 'focus-comment',
      comment: c3,
      selectFilePath: 'apps/web/src/c.ts',
    });
    expect(resolveReviewShortcut({ key: 'p' }, middleCtx)).toEqual({
      type: 'focus-comment',
      comment: c1,
      selectFilePath: 'apps/web/src/a.ts',
    });
  });

  it('opens the comment composer with c on active diff line or current file', () => {
    expect(resolveReviewShortcut({ key: 'c' }, baseContext())).toEqual({
      type: 'open-composer',
      target: 'file',
    });

    expect(
      resolveReviewShortcut({ key: 'c' }, baseContext({ activeLine: { line: 42, side: 'modified' } })),
    ).toEqual({
      type: 'open-composer',
      target: { line: 42, side: 'modified' },
    });

    expect(resolveReviewShortcut({ key: 'c' }, baseContext({ draftOpen: true }))).toBeNull();
  });

  it('toggles blocking priority with b on focused or active-file comment', () => {
    const important = makeComment({ id: 'c1', filePath: 'apps/web/src/a.ts', priority: 'important' });
    const blocking = makeComment({ id: 'c2', filePath: 'apps/web/src/b.ts', priority: 'blocking' });

    expect(resolveReviewShortcut({ key: 'b' }, baseContext({ comments: [important, blocking] }))).toEqual({
      type: 'toggle-blocking',
      commentId: 'c1',
      nextPriority: 'blocking',
    });

    expect(
      resolveReviewShortcut(
        { key: 'b' },
        baseContext({ comments: [important, blocking], focusedCommentId: 'c2' }),
      ),
    ).toEqual({
      type: 'toggle-blocking',
      commentId: 'c2',
      nextPriority: 'important',
    });
  });

  it('toggles shortcut sheet with ? and Escape while respecting modals and modifiers', () => {
    expect(resolveReviewShortcut({ key: '?', shiftKey: true }, baseContext())).toEqual({
      type: 'toggle-shortcut-sheet',
      open: true,
    });
    expect(resolveReviewShortcut({ key: 'Escape' }, baseContext({ shortcutSheetOpen: true }))).toEqual({
      type: 'toggle-shortcut-sheet',
      open: false,
    });
    expect(resolveReviewShortcut({ key: 'j' }, baseContext({ shortcutSheetOpen: true }))).toBeNull();
    expect(resolveReviewShortcut({ key: 'j' }, baseContext({ modalOpen: true }))).toBeNull();
    expect(resolveReviewShortcut({ key: 'j', ctrlKey: true }, baseContext())).toBeNull();
  });
});

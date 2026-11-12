import type { ReviewComment } from '@emberline/protocol';

export interface ReviewShortcutSpec {
  keys: readonly string[];
  label: string;
  description: string;
  group: 'Navigation' | 'Review' | 'General';
}

export const REVIEW_SHORTCUTS: readonly ReviewShortcutSpec[] = [
  {
    keys: ['j', 'k'],
    label: 'Next / previous file',
    description: 'Move down or up through changed files in the file tree',
    group: 'Navigation',
  },
  {
    keys: ['n', 'p'],
    label: 'Next / previous comment',
    description: 'Jump between unresolved review comments across files',
    group: 'Navigation',
  },
  {
    keys: ['c'],
    label: 'Add comment',
    description: 'Open comment composer on the active diff line or current file',
    group: 'Review',
  },
  {
    keys: ['b'],
    label: 'Toggle blocking',
    description: 'Toggle blocking priority on the focused review comment',
    group: 'Review',
  },
  {
    keys: ['?'],
    label: 'Keyboard shortcuts',
    description: 'Open or close this keyboard shortcut reference sheet',
    group: 'General',
  },
  {
    keys: ['Esc'],
    label: 'Dismiss / close',
    description: 'Close shortcut sheet or cancel an empty comment draft',
    group: 'General',
  },
];

export interface ShortcutKeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

export interface ReviewShortcutContext {
  files: readonly string[];
  selectedFile: string | null;
  comments: readonly ReviewComment[];
  focusedCommentId: string | null;
  activeLine: { line: number; side: 'modified' | 'original' } | null;
  draftOpen: boolean;
  shortcutSheetOpen: boolean;
  modalOpen: boolean;
  subTab: 'diff' | 'artifacts';
}

export type ReviewShortcutAction =
  | { type: 'select-file'; filePath: string; index: number }
  | { type: 'focus-comment'; comment: ReviewComment; selectFilePath: string | null }
  | { type: 'open-composer'; target: { line: number; side: 'modified' | 'original' } | 'file' }
  | { type: 'toggle-blocking'; commentId: string; nextPriority: 'blocking' | 'important' }
  | { type: 'toggle-shortcut-sheet'; open: boolean };

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  classList?: { contains(token: string): boolean };
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
}

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);

/**
 * True when keyboard focus sits inside a user-editable control where single-key shortcuts must not fire.
 * Monaco's read-only cursor trap (`.monaco-editor textarea.inputarea` outside `.find-widget`) is excluded
 * so shortcuts stay responsive after clicking lines in the diff viewer.
 */
export function isEditableShortcutTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;

  if (el.isContentEditable === true) return true;
  if (typeof el.getAttribute === 'function') {
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
  }

  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA') {
    const isMonacoCursorTrap =
      (el.classList?.contains('inputarea') || el.classList?.contains('ime-text-area')) &&
      Boolean(el.closest?.('.monaco-editor')) &&
      !el.closest?.('.find-widget');
    return !isMonacoCursorTrap;
  }
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const inputType = (el.type ?? 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }

  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) {
    return true;
  }

  return false;
}

/**
 * Orders unresolved comments for `n`/`p` traversal: comments on diff files in tree order first
 * (sorted by currentLine/line then createdAt), followed by unresolved off-diff comments.
 */
export function orderNavigableComments(
  comments: readonly ReviewComment[],
  orderedFilePaths: readonly string[],
): ReviewComment[] {
  const unresolved = comments.filter((c) => c.status !== 'resolved');
  if (unresolved.length === 0) return [];

  const fileRank = new Map<string, number>();
  for (let i = 0; i < orderedFilePaths.length; i += 1) {
    fileRank.set(orderedFilePaths[i]!, i);
  }

  return [...unresolved].sort((a, b) => {
    const rankA = fileRank.get(a.filePath);
    const rankB = fileRank.get(b.filePath);
    if (rankA !== undefined && rankB !== undefined) {
      if (rankA !== rankB) return rankA - rankB;
    } else if (rankA !== undefined) {
      return -1;
    } else if (rankB !== undefined) {
      return 1;
    } else {
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) return byPath;
    }
    const lineA = a.currentLine ?? a.line ?? 0;
    const lineB = b.currentLine ?? b.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Pure shortcut resolver for ReviewPage / ReviewView. */
export function resolveReviewShortcut(
  event: ShortcutKeyInput,
  ctx: ReviewShortcutContext,
): ReviewShortcutAction | null {
  if (event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  if (ctx.modalOpen) return null;

  if (ctx.shortcutSheetOpen) {
    if (event.key === 'Escape' || event.key === '?') {
      return { type: 'toggle-shortcut-sheet', open: false };
    }
    return null;
  }

  if (isEditableShortcutTarget(event.target)) return null;

  if (event.key === '?') {
    return { type: 'toggle-shortcut-sheet', open: true };
  }

  if (event.shiftKey) return null;
  if (ctx.subTab !== 'diff') return null;

  switch (event.key) {
    case 'j': {
      if (ctx.files.length === 0) return null;
      const curIdx = ctx.selectedFile ? ctx.files.indexOf(ctx.selectedFile) : -1;
      const nextIdx = curIdx < 0 ? 0 : Math.min(ctx.files.length - 1, curIdx + 1);
      const nextPath = ctx.files[nextIdx];
      if (!nextPath || nextIdx === curIdx) return null;
      return { type: 'select-file', filePath: nextPath, index: nextIdx };
    }

    case 'k': {
      if (ctx.files.length === 0) return null;
      const curIdx = ctx.selectedFile ? ctx.files.indexOf(ctx.selectedFile) : -1;
      const prevIdx = curIdx < 0 ? ctx.files.length - 1 : Math.max(0, curIdx - 1);
      const prevPath = ctx.files[prevIdx];
      if (!prevPath || prevIdx === curIdx) return null;
      return { type: 'select-file', filePath: prevPath, index: prevIdx };
    }

    case 'n':
    case 'p': {
      const ordered = orderNavigableComments(ctx.comments, ctx.files);
      if (ordered.length === 0) return null;
      const curIdx = ctx.focusedCommentId ? ordered.findIndex((c) => c.id === ctx.focusedCommentId) : -1;

      let targetComment: ReviewComment | undefined;
      if (curIdx >= 0) {
        const step = event.key === 'n' ? 1 : -1;
        const nextIdx = (curIdx + step + ordered.length) % ordered.length;
        targetComment = ordered[nextIdx];
      } else {
        const selectedRank = ctx.selectedFile ? ctx.files.indexOf(ctx.selectedFile) : -1;
        if (event.key === 'n') {
          if (selectedRank >= 0) {
            targetComment = ordered.find((c) => {
              const r = ctx.files.indexOf(c.filePath);
              return r < 0 || r >= selectedRank;
            });
          }
          targetComment ??= ordered[0];
        } else {
          if (selectedRank >= 0) {
            for (let i = ordered.length - 1; i >= 0; i -= 1) {
              const candidate = ordered[i]!;
              const r = ctx.files.indexOf(candidate.filePath);
              if (r >= 0 && r <= selectedRank) {
                targetComment = candidate;
                break;
              }
            }
          }
          targetComment ??= ordered.at(-1);
        }
      }

      if (!targetComment) return null;
      const inDiff = ctx.files.includes(targetComment.filePath);
      const selectFilePath =
        inDiff && targetComment.filePath !== ctx.selectedFile ? targetComment.filePath : null;
      return { type: 'focus-comment', comment: targetComment, selectFilePath };
    }

    case 'c': {
      if (!ctx.selectedFile || ctx.draftOpen) return null;
      return {
        type: 'open-composer',
        target: ctx.activeLine ? { line: ctx.activeLine.line, side: ctx.activeLine.side } : 'file',
      };
    }

    case 'b': {
      const ordered = orderNavigableComments(ctx.comments, ctx.files);
      if (ordered.length === 0) return null;
      const target =
        (ctx.focusedCommentId ? ordered.find((c) => c.id === ctx.focusedCommentId) : undefined) ??
        (ctx.selectedFile ? ordered.find((c) => c.filePath === ctx.selectedFile) : undefined);
      if (!target) return null;
      return {
        type: 'toggle-blocking',
        commentId: target.id,
        nextPriority: target.priority === 'blocking' ? 'important' : 'blocking',
      };
    }

    default:
      return null;
  }
}

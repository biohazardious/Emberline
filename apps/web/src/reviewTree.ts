import type { DiffFile, ReviewComment } from '@emberline/protocol';
import { viewedState, type ViewedState } from './reviewComments';

export interface FileCommentSummary {
  open: number;
  blocking: number;
}

export interface CommentCountIndex {
  byFile: ReadonlyMap<string, FileCommentSummary>;
  totalOpen: number;
  totalBlocking: number;
  commentedFileCount: number;
}

export type ReviewTreeFilterMode = 'all' | 'commented' | 'blocking' | 'unviewed';

export interface ReviewTreeDirNode {
  kind: 'dir';
  path: string;
  label: string;
  children: ReviewTreeNode[];
  fileCount: number;
  additions: number;
  deletions: number;
  openComments: number;
  blockingComments: number;
}

export interface ReviewTreeFileNode {
  kind: 'file';
  path: string;
  label: string;
  file: DiffFile;
  openComments: number;
  blockingComments: number;
  viewed: ViewedState;
}

export type ReviewTreeNode = ReviewTreeDirNode | ReviewTreeFileNode;

export type ReviewFlatTreeRow =
  | {
      kind: 'dir';
      key: string;
      path: string;
      label: string;
      depth: number;
      ariaLevel: number;
      posInSet: number;
      setSize: number;
      collapsed: boolean;
      fileCount: number;
      additions: number;
      deletions: number;
      openComments: number;
      blockingComments: number;
    }
  | {
      kind: 'file';
      key: string;
      path: string;
      label: string;
      depth: number;
      ariaLevel: number;
      posInSet: number;
      setSize: number;
      file: DiffFile;
      openComments: number;
      blockingComments: number;
      viewed: ViewedState;
    };

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  adjustedScrollTop: number | null;
}

const ZERO_COUNTS: FileCommentSummary = { open: 0, blocking: 0 };

/** Indexes unresolved open and blocking comment counts per file in O(C). */
export function indexCommentCounts(comments: readonly ReviewComment[]): CommentCountIndex {
  const byFile = new Map<string, FileCommentSummary>();
  let totalOpen = 0;
  let totalBlocking = 0;

  for (const c of comments) {
    if (c.status === 'resolved') continue;
    totalOpen += 1;
    const isBlocking = c.priority === 'blocking';
    if (isBlocking) totalBlocking += 1;
    const prev = byFile.get(c.filePath);
    if (prev) {
      prev.open += 1;
      if (isBlocking) prev.blocking += 1;
    } else {
      byFile.set(c.filePath, { open: 1, blocking: isBlocking ? 1 : 0 });
    }
  }

  return {
    byFile,
    totalOpen,
    totalBlocking,
    commentedFileCount: byFile.size,
  };
}

export function filterDiffFiles(
  files: readonly DiffFile[],
  countsByFile: ReadonlyMap<string, FileCommentSummary>,
  viewedByPath: ReadonlyMap<string, string>,
  query: string,
  mode: ReviewTreeFilterMode,
): DiffFile[] {
  const needle = query.trim().toLowerCase();
  return files.filter((file) => {
    if (needle && !file.path.toLowerCase().includes(needle)) return false;
    if (mode === 'all') return true;
    const counts = countsByFile.get(file.path) ?? ZERO_COUNTS;
    if (mode === 'commented') return counts.open > 0;
    if (mode === 'blocking') return counts.blocking > 0;
    return viewedState(viewedByPath.get(file.path), file.hash) !== 'viewed';
  });
}

interface MutableDir {
  path: string;
  label: string;
  dirs: Map<string, MutableDir>;
  files: ReviewTreeFileNode[];
}

function buildFinalNode(dir: MutableDir): ReviewTreeDirNode {
  const childDirs = [...dir.dirs.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((child) => buildFinalNode(child));
  const childFiles = [...dir.files].sort((a, b) => a.label.localeCompare(b.label));
  const children: ReviewTreeNode[] = [...childDirs, ...childFiles];

  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  let openComments = 0;
  let blockingComments = 0;

  for (const child of children) {
    if (child.kind === 'dir') {
      fileCount += child.fileCount;
      additions += child.additions;
      deletions += child.deletions;
      openComments += child.openComments;
      blockingComments += child.blockingComments;
    } else {
      fileCount += 1;
      additions += child.file.additions;
      deletions += child.file.deletions;
      openComments += child.openComments;
      blockingComments += child.blockingComments;
    }
  }

  const soleChild = children.length === 1 ? children[0] : undefined;
  if (soleChild && soleChild.kind === 'dir' && dir.path !== '') {
    return {
      ...soleChild,
      label: `${dir.label}/${soleChild.label}`,
    };
  }

  return {
    kind: 'dir',
    path: dir.path,
    label: dir.label,
    children,
    fileCount,
    additions,
    deletions,
    openComments,
    blockingComments,
  };
}

/** Builds a compacted folder/file tree with rolled-up diff and comment counts. */
export function buildReviewTree(
  files: readonly DiffFile[],
  countsByFile: ReadonlyMap<string, FileCommentSummary>,
  viewedByPath: ReadonlyMap<string, string>,
): ReviewTreeNode[] {
  const root: MutableDir = { path: '', label: '', dirs: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const fileName = parts.pop() ?? file.path;
    let cursor = root;
    let prefix = '';

    for (const seg of parts) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let sub = cursor.dirs.get(seg);
      if (!sub) {
        sub = { path: prefix, label: seg, dirs: new Map(), files: [] };
        cursor.dirs.set(seg, sub);
      }
      cursor = sub;
    }

    const counts = countsByFile.get(file.path) ?? ZERO_COUNTS;
    cursor.files.push({
      kind: 'file',
      path: file.path,
      label: fileName,
      file,
      openComments: counts.open,
      blockingComments: counts.blocking,
      viewed: viewedState(viewedByPath.get(file.path), file.hash),
    });
  }

  return buildFinalNode(root).children;
}

/** Returns all file nodes in deterministic tree traversal order. */
export function orderedTreeFiles(nodes: readonly ReviewTreeNode[]): DiffFile[] {
  const out: DiffFile[] = [];
  const visit = (list: readonly ReviewTreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'file') out.push(node.file);
      else visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/** Returns all directory paths in the tree (for Collapse All). */
export function allTreeDirPaths(nodes: readonly ReviewTreeNode[]): string[] {
  const out: string[] = [];
  const visit = (list: readonly ReviewTreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') {
        out.push(node.path);
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

/** Returns compacted directory paths containing `filePath` so collapsed parents can expand on jump. */
export function ancestorDirPaths(nodes: readonly ReviewTreeNode[], filePath: string): string[] {
  const trail: string[] = [];
  const search = (list: readonly ReviewTreeNode[]): boolean => {
    for (const node of list) {
      if (node.kind === 'file') {
        if (node.path === filePath) return true;
      } else if (filePath.startsWith(`${node.path}/`)) {
        trail.push(node.path);
        if (search(node.children)) return true;
        trail.pop();
      }
    }
    return false;
  };
  search(nodes);
  return trail;
}

/** Flattens visible tree nodes according to `collapsedDirs`, preserving WAI-ARIA tree metadata. */
export function flattenReviewTree(
  nodes: readonly ReviewTreeNode[],
  collapsedDirs: ReadonlySet<string>,
): ReviewFlatTreeRow[] {
  const rows: ReviewFlatTreeRow[] = [];

  const visit = (list: readonly ReviewTreeNode[], depth: number) => {
    const setSize = list.length;
    for (let i = 0; i < list.length; i += 1) {
      const node = list[i]!;
      const posInSet = i + 1;
      const ariaLevel = depth + 1;
      if (node.kind === 'dir') {
        const collapsed = collapsedDirs.has(node.path);
        rows.push({
          kind: 'dir',
          key: `dir:${node.path}`,
          path: node.path,
          label: node.label,
          depth,
          ariaLevel,
          posInSet,
          setSize,
          collapsed,
          fileCount: node.fileCount,
          additions: node.additions,
          deletions: node.deletions,
          openComments: node.openComments,
          blockingComments: node.blockingComments,
        });
        if (!collapsed) visit(node.children, depth + 1);
      } else {
        rows.push({
          kind: 'file',
          key: `file:${node.path}`,
          path: node.path,
          label: node.label,
          depth,
          ariaLevel,
          posInSet,
          setSize,
          file: node.file,
          openComments: node.openComments,
          blockingComments: node.blockingComments,
          viewed: node.viewed,
        });
      }
    }
  };

  visit(nodes, 0);
  return rows;
}

/** Computes a virtualised row slice for large diffs (300+ files) in O(1). */
export function computeVirtualWindow(params: {
  totalCount: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
  ensureIndex?: number | null;
}): VirtualWindow {
  const { totalCount, rowHeight, overscan = 8, ensureIndex = null } = params;
  if (totalCount === 0) {
    return { startIndex: 0, endIndex: 0, topSpacerPx: 0, bottomSpacerPx: 0, adjustedScrollTop: null };
  }

  const effectiveHeight = params.viewportHeight > 0 ? params.viewportHeight : 640;
  let effectiveScrollTop = Math.max(0, params.scrollTop);
  let adjustedScrollTop: number | null = null;

  if (ensureIndex !== null && ensureIndex >= 0 && ensureIndex < totalCount) {
    const itemTop = ensureIndex * rowHeight;
    const itemBottom = itemTop + rowHeight;
    if (itemTop < effectiveScrollTop) {
      effectiveScrollTop = itemTop;
      adjustedScrollTop = itemTop;
    } else if (itemBottom > effectiveScrollTop + effectiveHeight) {
      effectiveScrollTop = Math.max(0, itemBottom - effectiveHeight);
      adjustedScrollTop = effectiveScrollTop;
    }
  }

  const firstVisible = Math.floor(effectiveScrollTop / rowHeight);
  const visibleCount = Math.ceil(effectiveHeight / rowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(totalCount, firstVisible + visibleCount + overscan);

  return {
    startIndex,
    endIndex,
    topSpacerPx: startIndex * rowHeight,
    bottomSpacerPx: Math.max(0, (totalCount - endIndex) * rowHeight),
    adjustedScrollTop,
  };
}

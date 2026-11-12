import type { DiffFile, DiffScope } from '@emberline/protocol';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  allTreeDirPaths,
  ancestorDirPaths,
  buildReviewTree,
  type CommentCountIndex,
  computeVirtualWindow,
  filterDiffFiles,
  flattenReviewTree,
  type ReviewFlatTreeRow,
  type ReviewTreeFilterMode,
  type ReviewTreeNode,
} from '../../reviewTree';

const ROW_HEIGHT_PX = 30;
const VIRTUALISE_THRESHOLD = 60;

interface Props {
  files: readonly DiffFile[];
  loading: boolean;
  hasSummary: boolean;
  scope: DiffScope;
  selectedFile: string | null;
  keyboardFocusedFile: string | null;
  commentIndex: CommentCountIndex;
  viewedByPath: ReadonlyMap<string, string>;
  filterQuery: string;
  onFilterQueryChange: (next: string) => void;
  filterMode: ReviewTreeFilterMode;
  onFilterModeChange: (next: ReviewTreeFilterMode) => void;
  onSelectFile: (path: string, viaKeyboard?: boolean) => void;
  onToggleViewed: (file: DiffFile, viewed: boolean) => void;
  onStageToggle: (file: DiffFile, unstage: boolean) => void;
}

export function ReviewFileTree({
  files,
  loading,
  hasSummary,
  scope,
  selectedFile,
  keyboardFocusedFile,
  commentIndex,
  viewedByPath,
  filterQuery,
  onFilterQueryChange,
  filterMode,
  onFilterModeChange,
  onSelectFile,
  onToggleViewed,
  onStageToggle,
}: Props) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const filteredFiles = useMemo(
    () => filterDiffFiles(files, commentIndex.byFile, viewedByPath, filterQuery, filterMode),
    [files, commentIndex.byFile, viewedByPath, filterQuery, filterMode],
  );

  const treeNodes: ReviewTreeNode[] = useMemo(
    () => buildReviewTree(filteredFiles, commentIndex.byFile, viewedByPath),
    [filteredFiles, commentIndex.byFile, viewedByPath],
  );

  const allDirs = useMemo(() => allTreeDirPaths(treeNodes), [treeNodes]);

  // Expand any collapsed ancestor directory when `selectedFile` moves there (e.g. via j/k, n/p, or gate link).
  useEffect(() => {
    if (!selectedFile) return;
    const ancestors = ancestorDirPaths(treeNodes, selectedFile);
    if (ancestors.length === 0) return;
    setCollapsedDirs((prev) => {
      if (!ancestors.some((dir) => prev.has(dir))) return prev;
      const next = new Set(prev);
      for (const dir of ancestors) next.delete(dir);
      return next;
    });
  }, [selectedFile, treeNodes]);

  const rows = useMemo(() => flattenReviewTree(treeNodes, collapsedDirs), [treeNodes, collapsedDirs]);

  const selectedRowIndex = useMemo(
    () => (selectedFile ? rows.findIndex((r) => r.kind === 'file' && r.path === selectedFile) : -1),
    [rows, selectedFile],
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(measure);
      obs.observe(el);
      return () => obs.disconnect();
    }
    return undefined;
  }, []);

  const isVirtualised = rows.length > VIRTUALISE_THRESHOLD;
  const windowSlice = useMemo(() => {
    if (!isVirtualised) {
      return { startIndex: 0, endIndex: rows.length, topSpacerPx: 0, bottomSpacerPx: 0 };
    }
    return computeVirtualWindow({
      totalCount: rows.length,
      scrollTop,
      viewportHeight,
      rowHeight: ROW_HEIGHT_PX,
      overscan: 10,
    });
  }, [isVirtualised, rows.length, scrollTop, viewportHeight]);

  // Scroll the selected row into view only when the selection moves (j/k, n/p, a gate link): a
  // scroll by the user that takes it out of view is left alone. A selection inside a collapsed
  // folder waits for the folder to open (`selectedRowIndex` turns valid one render later).
  const revealPendingRef = useRef<string | null>(null);
  useEffect(() => {
    revealPendingRef.current = selectedFile;
  }, [selectedFile]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !selectedFile || revealPendingRef.current !== selectedFile || selectedRowIndex < 0) return;
    revealPendingRef.current = null;
    const { adjustedScrollTop } = computeVirtualWindow({
      totalCount: rows.length,
      scrollTop: el.scrollTop,
      viewportHeight: el.clientHeight > 0 ? el.clientHeight : viewportHeight,
      rowHeight: ROW_HEIGHT_PX,
      ensureIndex: selectedRowIndex,
    });
    if (adjustedScrollTop !== null) {
      el.scrollTop = adjustedScrollTop;
      setScrollTop(adjustedScrollTop);
    }
  }, [selectedFile, selectedRowIndex, rows.length, viewportHeight]);

  const visibleRows = useMemo(
    () => rows.slice(windowSlice.startIndex, windowSlice.endIndex),
    [rows, windowSlice.startIndex, windowSlice.endIndex],
  );

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const allCollapsed = allDirs.length > 0 && allDirs.every((d) => collapsedDirs.has(d));
  const toggleCollapseAll = () => {
    setCollapsedDirs(allCollapsed ? new Set() : new Set(allDirs));
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: ReviewFlatTreeRow, rowIndex: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, rowIndex + 1)];
      if (next) {
        setFocusedRowKey(next.key);
        if (next.kind === 'file') onSelectFile(next.path, true);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(0, rowIndex - 1)];
      if (prev) {
        setFocusedRowKey(prev.key);
        if (prev.kind === 'file') onSelectFile(prev.path, true);
      }
    } else if (e.key === 'ArrowLeft' && row.kind === 'dir' && !row.collapsed) {
      e.preventDefault();
      toggleDir(row.path);
    } else if (e.key === 'ArrowRight' && row.kind === 'dir' && row.collapsed) {
      e.preventDefault();
      toggleDir(row.path);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row.kind === 'dir') toggleDir(row.path);
      else onSelectFile(row.path, true);
    }
  };

  useEffect(() => {
    if (!focusedRowKey || !viewportRef.current) return;
    const node = [...viewportRef.current.querySelectorAll<HTMLElement>('[data-tree-key]')].find(
      (el) => el.dataset.treeKey === focusedRowKey,
    );
    node?.focus({ preventScroll: true });
  }, [focusedRowKey, visibleRows]);

  return (
    <aside className="review-file-list" aria-label="Changed files sidebar">
      <div className="review-file-list-header review-tree-head">
        <div className="review-tree-head-top">
          <span className="eyebrow review-tabular">
            Changed Files ({filteredFiles.length}
            {filteredFiles.length !== files.length ? `/${files.length}` : ''})
          </span>
          <div className="review-tree-head-badges">
            {commentIndex.totalOpen > 0 && (
              <span
                className="badge badge-soft mono review-tabular"
                title={`${commentIndex.totalOpen} unresolved comment(s)`}
              >
                {commentIndex.totalOpen} open
              </span>
            )}
            {commentIndex.totalBlocking > 0 && (
              <span
                className="badge comment-badge-blocking mono review-tabular"
                title={`${commentIndex.totalBlocking} blocking comment(s)`}
              >
                {commentIndex.totalBlocking}!
              </span>
            )}
            {allDirs.length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-ghost review-tree-fold-btn"
                onClick={toggleCollapseAll}
                title={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
              >
                {allCollapsed ? 'Expand' : 'Fold'}
              </button>
            )}
          </div>
        </div>

        {files.length > 0 && (
          <div className="review-tree-controls">
            <div className="review-tree-search-wrap">
              <Search className="icon review-tree-search-icon" aria-hidden />
              <input
                type="search"
                className="input mono review-tree-search"
                aria-label="Filter changed files"
                placeholder="Filter files…"
                value={filterQuery}
                onChange={(e) => onFilterQueryChange(e.target.value)}
              />
              {filterQuery && (
                <button
                  type="button"
                  className="icon-btn review-tree-clear-btn"
                  aria-label="Clear file filter"
                  onClick={() => onFilterQueryChange('')}
                >
                  <X className="icon" aria-hidden />
                </button>
              )}
            </div>

            <div
              className="segmented review-tree-modes"
              role="radiogroup"
              aria-label="Filter files by review state"
            >
              {(
                [
                  ['all', 'All'],
                  ['commented', `Comments (${commentIndex.commentedFileCount})`],
                  ['blocking', `Blocking (${commentIndex.totalBlocking})`],
                  ['unviewed', 'Unviewed'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={filterMode === mode}
                  className={filterMode === mode ? 'active review-tabular' : 'review-tabular'}
                  onClick={() => onFilterModeChange(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        ref={viewportRef}
        className="review-tree-viewport"
        role="tree"
        aria-label="Changed files"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {loading && !hasSummary ? (
          <div className="muted small review-tree-empty">Inspecting git worktree…</div>
        ) : !hasSummary || files.length === 0 ? (
          <div className="muted small review-tree-empty">No changes in `{scope}` scope.</div>
        ) : rows.length === 0 ? (
          <div className="muted small review-tree-empty">No changed files match the active filter.</div>
        ) : (
          <>
            {windowSlice.topSpacerPx > 0 && (
              <div style={{ height: `${windowSlice.topSpacerPx}px`, flexShrink: 0 }} aria-hidden />
            )}

            {visibleRows.map((row, localIdx) => {
              const absoluteIdx = windowSlice.startIndex + localIdx;
              const indentPx = 8 + row.depth * 14;

              if (row.kind === 'dir') {
                const isTabStop = focusedRowKey === row.key || (!selectedFile && absoluteIdx === 0);
                return (
                  <div
                    key={row.key}
                    data-tree-key={row.key}
                    role="treeitem"
                    tabIndex={isTabStop ? 0 : -1}
                    aria-expanded={!row.collapsed}
                    aria-level={row.ariaLevel}
                    aria-posinset={row.posInSet}
                    aria-setsize={row.setSize}
                    className="review-tree-dir-row"
                    style={{ paddingLeft: `${indentPx}px`, height: `${ROW_HEIGHT_PX}px` }}
                    onClick={() => toggleDir(row.path)}
                    onKeyDown={(e) => handleRowKeyDown(e, row, absoluteIdx)}
                  >
                    <span className="review-tree-dir-chevron" aria-hidden>
                      {row.collapsed ? <ChevronRight className="icon" /> : <ChevronDown className="icon" />}
                    </span>
                    <span className="review-tree-dir-icon" aria-hidden>
                      {row.collapsed ? <Folder className="icon" /> : <FolderOpen className="icon" />}
                    </span>
                    <span className="review-tree-dir-label mono" title={row.path}>
                      {row.label}
                    </span>
                    {row.openComments > 0 && (
                      <span
                        className="badge badge-soft mono review-tabular"
                        title={`${row.openComments} unresolved comment(s) in ${row.path}`}
                      >
                        {row.openComments}
                      </span>
                    )}
                    {row.blockingComments > 0 && (
                      <span
                        className="badge comment-badge-blocking mono review-tabular"
                        title={`${row.blockingComments} blocking in ${row.path}`}
                      >
                        {row.blockingComments}!
                      </span>
                    )}
                    <span className="muted mono review-tree-dir-count review-tabular">{row.fileCount}</span>
                  </div>
                );
              }

              const active = row.path === selectedFile;
              const kbdFocused = row.path === keyboardFocusedFile || focusedRowKey === row.key;
              const f = row.file;
              return (
                <div
                  key={row.key}
                  data-tree-key={row.key}
                  data-file-path={row.path}
                  data-focused={kbdFocused ? 'true' : undefined}
                  role="treeitem"
                  tabIndex={active || (!selectedFile && absoluteIdx === 0) ? 0 : -1}
                  aria-selected={active}
                  aria-level={row.ariaLevel}
                  aria-posinset={row.posInSet}
                  aria-setsize={row.setSize}
                  className={`review-file-item review-tree-file-row${active ? ' active' : ''}${kbdFocused ? ' review-tree-row-focused' : ''}`}
                  style={{ paddingLeft: `${indentPx}px`, height: `${ROW_HEIGHT_PX}px` }}
                  onClick={() => onSelectFile(row.path, false)}
                  onKeyDown={(e) => handleRowKeyDown(e, row, absoluteIdx)}
                >
                  <span className={`diff-status-badge status-${f.status}`}>
                    {f.status[0]?.toUpperCase() ?? 'M'}
                  </span>
                  <span className="review-file-path mono" title={row.path}>
                    {row.label}
                  </span>
                  {row.openComments > 0 && (
                    <span
                      className="badge badge-soft mono review-tabular"
                      data-testid={`file-comments-${row.path}`}
                      title={`${row.openComments} unresolved comment(s)`}
                    >
                      {row.openComments}
                    </span>
                  )}
                  {row.blockingComments > 0 && (
                    <span
                      className="badge comment-badge-blocking mono review-tabular"
                      data-testid={`file-blocking-${row.path}`}
                      title={`${row.blockingComments} blocking`}
                    >
                      {row.blockingComments}!
                    </span>
                  )}
                  <label
                    className={`review-viewed${row.viewed === 'changed' ? ' review-viewed-stale' : ''}`}
                    title={row.viewed === 'changed' ? 'Changed since you marked it viewed' : 'Mark as viewed'}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={row.viewed === 'viewed'}
                      onChange={(e) => onToggleViewed(f, e.target.checked)}
                    />
                    <span className="review-viewed-text">{row.viewed === 'changed' ? 'chg' : 'ok'}</span>
                  </label>
                  <span className="review-file-stats mono review-tabular">
                    <span style={{ color: 'var(--ok)' }}>+{f.additions}</span>{' '}
                    <span style={{ color: 'var(--danger)' }}>-{f.deletions}</span>
                  </span>
                  {scope !== 'branch' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost review-stage-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStageToggle(f, scope === 'staged');
                      }}
                      title={scope === 'staged' ? 'Unstage file' : 'Stage file'}
                    >
                      {scope === 'staged' ? '−' : '+'}
                    </button>
                  )}
                </div>
              );
            })}

            {windowSlice.bottomSpacerPx > 0 && (
              <div style={{ height: `${windowSlice.bottomSpacerPx}px`, flexShrink: 0 }} aria-hidden />
            )}
          </>
        )}
      </div>
    </aside>
  );
}

import type { DiffScope, ReviewComment, Run } from '@emberline/protocol';
import { useCallback, useMemo, useRef, useState } from 'react';
import { commentsOffDiff, requestTargets } from '../reviewComments';
import { buildMergeGateSummary } from '../reviewGate';
import { buildReviewTree, filterDiffFiles, orderedTreeFiles, type ReviewTreeFilterMode } from '../reviewTree';
import { CommentChip } from './review/CommentChip';
import { MergeGateBanner } from './review/MergeGateBanner';
import { RequestChangesDialog } from './review/RequestChangesDialog';
import { ReviewArtifactsPane } from './review/ReviewArtifactsPane';
import { ReviewCommitBar } from './review/ReviewCommitBar';
import { ReviewDiffPane } from './review/ReviewDiffPane';
import { ReviewFileTree } from './review/ReviewFileTree';
import { ReviewGitDrawers } from './review/ReviewGitDrawers';
import { ReviewHygienePanel } from './review/ReviewHygienePanel';
import { ReviewShortcutSheet } from './review/ReviewShortcutSheet';
import { ReviewToolbar } from './review/ReviewToolbar';
import { useReviewCommentsController } from './review/useReviewCommentsController';
import { useReviewDiffLoader } from './review/useReviewDiffLoader';
import { useReviewExtras } from './review/useReviewExtras';
import { formatAgentDisplayName } from './RunInspector';

interface Props {
  run: Run;
  onRunUpdated?: (run: Run) => void;
  shortcutSheetOpen?: boolean;
  onShortcutSheetOpenChange?: (open: boolean) => void;
}

export function ReviewView({
  run,
  onRunUpdated,
  shortcutSheetOpen: controlledSheetOpen,
  onShortcutSheetOpenChange,
}: Props) {
  const [subTab, setSubTab] = useState<'diff' | 'artifacts'>('diff');
  const [scope, setScope] = useState<DiffScope>('branch');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [keyboardFocusedFile, setKeyboardFocusedFile] = useState<string | null>(null);
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterMode, setFilterMode] = useState<ReviewTreeFilterMode>('all');
  const [internalSheetOpen, setInternalSheetOpen] = useState(false);
  const shortcutSheetOpen = controlledSheetOpen ?? internalSheetOpen;
  const setShortcutSheetOpen = useCallback(
    (next: boolean) => {
      setInternalSheetOpen(next);
      onShortcutSheetOpenChange?.(next);
    },
    [onShortcutSheetOpenChange],
  );

  const resetFocusRef = useRef<() => void>(() => undefined);
  const selectFile = useCallback((path: string, viaKeyboard = false) => {
    setSelectedFile(path);
    setKeyboardFocusedFile(viaKeyboard ? path : null);
    resetFocusRef.current();
  }, []);

  const diff = useReviewDiffLoader({
    runId: run.id,
    scope,
    selectedFile,
    setSelectedFile,
    setError,
  });

  const extras = useReviewExtras({
    run,
    scope,
    selectedFile,
    onRunUpdated,
    setError,
    setSummary: diff.setSummary,
    clearDiffCache: diff.clearDiffCache,
    loadSummary: diff.loadSummary,
    loadFile: diff.loadFile,
  });

  const visiblePathsRef = useRef<string[]>([]);
  const ctrl = useReviewCommentsController({
    run,
    scope,
    setScope,
    subTab,
    setSubTab,
    summary: diff.summary,
    fileDiffPath: diff.fileDiff?.path,
    selectedFile,
    setSelectedFile,
    setKeyboardFocusedFile,
    selectFile,
    visibleOrderedPaths: visiblePathsRef.current,
    setFilterQuery,
    setFilterMode,
    shortcutSheetOpen,
    setShortcutSheetOpen,
    setError,
    setGitNotice: extras.setGitNotice,
    onRunUpdated,
  });
  resetFocusRef.current = ctrl.resetFileFocus;

  const allOrderedPaths = useMemo(() => {
    if (!diff.summary) return null;
    if (!diff.summary.isGitRepo) return [];
    return orderedTreeFiles(
      buildReviewTree(diff.summary.files, ctrl.commentIndex.byFile, ctrl.viewedByPath),
    ).map((f) => f.path);
  }, [diff.summary, ctrl.commentIndex.byFile, ctrl.viewedByPath]);

  const visibleOrderedPaths = useMemo(() => {
    if (!diff.summary || !diff.summary.isGitRepo) return [];
    const filtered = filterDiffFiles(
      diff.summary.files,
      ctrl.commentIndex.byFile,
      ctrl.viewedByPath,
      filterQuery,
      filterMode,
    );
    return orderedTreeFiles(buildReviewTree(filtered, ctrl.commentIndex.byFile, ctrl.viewedByPath)).map(
      (f) => f.path,
    );
  }, [diff.summary, ctrl.commentIndex.byFile, ctrl.viewedByPath, filterQuery, filterMode]);
  visiblePathsRef.current = visibleOrderedPaths;

  const mergeGate = useMemo(
    () =>
      buildMergeGateSummary({
        review: ctrl.reviewData,
        run,
        orderedDiffPaths: scope === 'branch' ? allOrderedPaths : (allOrderedPaths ?? null),
        slopAudit: extras.slopAudit,
      }),
    [ctrl.reviewData, run, scope, allOrderedPaths, extras.slopAudit],
  );

  const chip = (c: ReviewComment) => (
    <CommentChip
      key={c.id}
      comment={c}
      focused={c.id === ctrl.focusedId}
      busy={ctrl.commentBusy}
      onFocus={ctrl.setFocusedId}
      onToggleBlocking={(id, nextPriority) => ctrl.patchComment(id, { priority: nextPriority })}
      onDelete={ctrl.handleDeleteComment}
      onResolve={(id) => ctrl.patchComment(id, { status: 'resolved' })}
      onVerify={(id) => ctrl.patchComment(id, { status: 'resolved' })}
      onNotDone={(id) => ctrl.patchComment(id, { status: 'open' })}
    />
  );

  const offDiff = useMemo(() => {
    if (!diff.summary) return [];
    if (!diff.summary.isGitRepo) return commentsOffDiff(ctrl.comments, []);
    return scope === 'branch'
      ? commentsOffDiff(
          ctrl.comments,
          diff.summary.files.map((f) => f.path),
        )
      : [];
  }, [ctrl.comments, diff.summary, scope]);

  const offDiffSection =
    offDiff.length > 0 ? (
      <section className="review-off-diff" aria-labelledby="review-off-diff-title">
        <h3 id="review-off-diff-title" className="eyebrow review-tabular">
          Comments on files no longer in the diff ({offDiff.length})
        </h3>
        {offDiff.map((c, i) => (
          <div key={c.id} className="review-off-diff-item">
            {(i === 0 || offDiff[i - 1]?.filePath !== c.filePath) && (
              <span className="mono review-off-diff-path" title={c.filePath}>
                {c.filePath}
              </span>
            )}
            {chip(c)}
          </div>
        ))}
      </section>
    ) : null;

  const fileComments = useMemo(
    () => ctrl.comments.filter((c) => c.filePath === selectedFile && c.status !== 'resolved'),
    [ctrl.comments, selectedFile],
  );
  const fileChips = useMemo(
    () =>
      ctrl.comments.filter((c) => c.filePath === selectedFile && (c.status !== 'resolved' || c.carriedTo)),
    [ctrl.comments, selectedFile],
  );
  const activeFileDiff = diff.fileDiff && diff.fileDiff.path === selectedFile ? diff.fileDiff : null;

  return (
    <div className="review-workspace">
      <MergeGateBanner
        gate={mergeGate}
        busy={ctrl.commentBusy}
        onJumpToComment={ctrl.jumpToComment}
        onVerifyCarried={ctrl.handleVerifyCarried}
        onOpenShortcuts={() => setShortcutSheetOpen(true)}
      />

      <ReviewToolbar
        run={run}
        subTab={subTab}
        onSubTabChange={setSubTab}
        scope={scope}
        onScopeChange={setScope}
        summary={diff.summary}
        artifactsCount={extras.artifacts.length}
        slopAudit={extras.slopAudit}
        crossCritic={extras.crossCritic}
        runningCritic={extras.runningCritic}
        onToggleHygieneDrawer={() => extras.setHygieneDrawerOpen((v) => !v)}
        onRunCrossCritic={() => void extras.handleRunCrossCritic()}
        previewStatus={extras.previewStatus}
        previewBusy={extras.previewBusy}
        previewDrawerOpen={extras.previewDrawerOpen}
        onTogglePreviewDrawer={() => extras.setPreviewDrawerOpen((v) => !v)}
        onStopPreview={() => void extras.handleStopPreview()}
        forgeStatus={extras.forgeStatus}
        prDrawerOpen={extras.prDrawerOpen}
        onTogglePrDrawer={() => extras.setPrDrawerOpen((v) => !v)}
        renderSideBySide={renderSideBySide}
        onToggleSideBySide={() => setRenderSideBySide((s) => !s)}
        loading={diff.loadingDiff || extras.loadingArtifacts}
        onOpenShortcuts={() => setShortcutSheetOpen(true)}
        onRefresh={() => {
          void diff.loadSummary(scope, true);
          extras.refreshExtras();
        }}
      />

      {extras.hygieneDrawerOpen && (
        <ReviewHygienePanel
          slopAudit={extras.slopAudit}
          crossCritic={extras.crossCritic}
          runningCritic={extras.runningCritic}
          cleaningSlop={extras.cleaningSlop}
          agentDisplayName={formatAgentDisplayName(run.agent)}
          onAutoCleanSlop={(p) => void extras.handleAutoCleanSlop(p)}
          onRunCrossCritic={() => void extras.handleRunCrossCritic()}
          onSelectFile={(f) => selectFile(f, false)}
          onClose={() => extras.setHygieneDrawerOpen(false)}
        />
      )}

      <ReviewGitDrawers
        previewStatus={extras.previewStatus}
        previewDrawerOpen={extras.previewDrawerOpen}
        previewCmd={extras.previewCmd}
        onPreviewCmdChange={extras.setPreviewCmd}
        previewPort={extras.previewPort}
        onPreviewPortChange={extras.setPreviewPort}
        previewBusy={extras.previewBusy}
        onStartPreview={(e) => void extras.handleStartPreview(e)}
        prDrawerOpen={extras.prDrawerOpen}
        prTitle={extras.prTitle}
        onPrTitleChange={extras.setPrTitle}
        prBody={extras.prBody}
        onPrBodyChange={extras.setPrBody}
        prDraft={extras.prDraft}
        onPrDraftChange={extras.setPrDraft}
        prCreating={extras.prCreating}
        forgeStatus={extras.forgeStatus}
        onCreatePr={(e) => void extras.handleCreatePr(e)}
      />

      {error && (
        <p className="form-error" role="alert" style={{ margin: '0.5rem 0.75rem' }}>
          {error}
        </p>
      )}
      {extras.gitNotice && (
        <div className="git-notice-banner">
          <span className="mono">{extras.gitNotice}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => extras.setGitNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {subTab === 'diff' && diff.summary && !diff.summary.isGitRepo ? (
        <>
          {offDiffSection}
          <div className="review-split-pane">
            <div className="muted small" style={{ padding: '1rem' }}>
              This workspace is not a git repository, so the agent&apos;s changes cannot be listed, reviewed,
              committed or merged. Run <code>git init</code> in the project&apos;s shell (or create the
              project with a repository URL) to enable review.
            </div>
          </div>
        </>
      ) : subTab === 'diff' ? (
        <>
          <ReviewCommitBar
            branch={run.branch ?? null}
            commitMessage={extras.commitMessage}
            onCommitMessageChange={extras.setCommitMessage}
            stageAllOnCommit={extras.stageAllOnCommit}
            onStageAllChange={extras.setStageAllOnCommit}
            gitBusy={extras.gitBusy}
            onCommit={(e) => void extras.handleCommit(e)}
            onPush={() => void extras.handlePush()}
            requestableCount={ctrl.requestable.length}
            onOpenRequestChanges={() => ctrl.setRequestOpen(true)}
          />
          {offDiffSection}
          <div className="review-split-pane">
            <ReviewFileTree
              files={diff.summary?.files ?? []}
              loading={diff.loadingDiff}
              hasSummary={diff.summary !== null}
              scope={scope}
              selectedFile={selectedFile}
              keyboardFocusedFile={keyboardFocusedFile}
              commentIndex={ctrl.commentIndex}
              viewedByPath={ctrl.viewedByPath}
              filterQuery={filterQuery}
              onFilterQueryChange={setFilterQuery}
              filterMode={filterMode}
              onFilterModeChange={setFilterMode}
              onSelectFile={selectFile}
              onToggleViewed={ctrl.handleToggleViewed}
              onStageToggle={(f, unstage) => void extras.handleStageToggle(f, unstage)}
            />
            <ReviewDiffPane
              selectedFile={selectedFile}
              activeFileDiff={activeFileDiff}
              loadingFile={diff.loadingFile}
              renderSideBySide={renderSideBySide}
              draft={ctrl.draft}
              onDraftChange={ctrl.setDraft}
              commentBusy={ctrl.commentBusy}
              onAddComment={ctrl.handleAddComment}
              fileComments={fileComments}
              fileChips={fileChips}
              renderChip={chip}
              onFocusComment={ctrl.setFocusedId}
              onActiveLineChange={ctrl.setActiveLine}
              revealTarget={ctrl.revealTarget}
            />
          </div>
        </>
      ) : (
        <ReviewArtifactsPane
          runId={run.id}
          stateChangedAt={run.stateChangedAt}
          artifacts={extras.artifacts}
          loadingArtifacts={extras.loadingArtifacts}
          previewArtifact={extras.previewArtifact}
          onSelectArtifact={extras.setPreviewArtifact}
        />
      )}

      {ctrl.requestOpen && (
        <RequestChangesDialog
          comments={ctrl.requestable}
          targets={requestTargets(run)}
          onSend={ctrl.handleRequestChanges}
          onClose={() => ctrl.setRequestOpen(false)}
        />
      )}

      <ReviewShortcutSheet open={shortcutSheetOpen} onClose={() => setShortcutSheetOpen(false)} />
    </div>
  );
}

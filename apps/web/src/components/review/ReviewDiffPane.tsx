import type { ReviewComment, RunFileDiff } from '@emberline/protocol';
import type { ReactNode } from 'react';
import { MonacoDiff } from '../MonacoDiff';
import { CommentComposer, type CommentDraft } from './CommentComposer';
import { detectLanguage } from './useReviewExtras';

interface Props {
  selectedFile: string | null;
  activeFileDiff: RunFileDiff | null;
  loadingFile: boolean;
  renderSideBySide: boolean;
  draft: { line: number; side: 'modified' | 'original' } | 'file' | null;
  onDraftChange: (next: { line: number; side: 'modified' | 'original' } | 'file' | null) => void;
  commentBusy: boolean;
  onAddComment: (input: CommentDraft) => void;
  fileComments: ReviewComment[];
  fileChips: ReviewComment[];
  renderChip: (c: ReviewComment) => ReactNode;
  onFocusComment: (id: string) => void;
  onActiveLineChange: (target: { line: number; side: 'modified' | 'original' } | null) => void;
  revealTarget: { line: number; side: 'modified' | 'original'; nonce: number } | null;
}

export function ReviewDiffPane({
  selectedFile,
  activeFileDiff,
  loadingFile,
  renderSideBySide,
  draft,
  onDraftChange,
  commentBusy,
  onAddComment,
  fileComments,
  fileChips,
  renderChip,
  onFocusComment,
  onActiveLineChange,
  revealTarget,
}: Props) {
  return (
    <div className="review-diff-pane">
      {!selectedFile ? (
        <div className="empty review-empty">
          Select a changed file to inspect its diff and attach inline review comments.
        </div>
      ) : (
        <>
          <div className="review-file-head">
            <span className="mono review-file-head-path" data-testid="active-diff-path" title={selectedFile}>
              {selectedFile}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onDraftChange('file')}
              disabled={draft === 'file'}
              title="Add file comment (c)"
            >
              Add file comment <kbd className="kbd">c</kbd>
            </button>
          </div>
          {draft && (
            <CommentComposer
              target={
                draft === 'file'
                  ? `${selectedFile} (whole file)`
                  : `${selectedFile}:${draft.line} (${draft.side})`
              }
              busy={commentBusy}
              onSubmit={onAddComment}
              onCancel={() => onDraftChange(null)}
            />
          )}
          {fileChips.length > 0 && <div className="diff-file-annotations">{fileChips.map(renderChip)}</div>}
          {loadingFile && !activeFileDiff ? (
            <div className="empty review-empty">Loading file diff…</div>
          ) : !activeFileDiff ? (
            <div className="empty review-empty">
              Select a changed file to inspect its diff and attach inline review comments.
            </div>
          ) : activeFileDiff.binary ? (
            <div className="empty review-empty">
              Binary file (`{activeFileDiff.path}`) — comment on the file above, or switch to the Artifacts
              tab to preview or download it.
            </div>
          ) : (
            <MonacoDiff
              filePath={activeFileDiff.path}
              language={detectLanguage(activeFileDiff.path)}
              original={activeFileDiff.original}
              modified={activeFileDiff.modified}
              patch={activeFileDiff.patch}
              renderSideBySide={renderSideBySide}
              comments={fileComments}
              draftLine={draft && draft !== 'file' ? draft : null}
              onLineClick={(line, side) => {
                onActiveLineChange({ line, side });
                onDraftChange({ line, side });
              }}
              onFocusComment={onFocusComment}
              onActiveLineChange={onActiveLineChange}
              revealTarget={revealTarget}
            />
          )}
        </>
      )}
    </div>
  );
}

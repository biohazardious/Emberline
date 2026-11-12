import type { ReviewComment, RunFileDiff } from '@emberline/protocol';
import { type ReactNode, useState } from 'react';
import { MonacoDiff } from '../MonacoDiff';
import { CommentComposer, type CommentDraft } from './CommentComposer';
import { detectLanguage } from './useReviewExtras';

const NO_COMMENTS: ReviewComment[] = [];
const noop = () => undefined;

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
  // One Monaco diff editor lives for the whole pane: a file switch swaps its models (pooled in
  // MonacoDiff) instead of rebuilding it. While the next diff loads, or while the selected file is
  // binary, the editor keeps the last text diff it showed, covered or hidden.
  const textDiff = selectedFile && activeFileDiff && !activeFileDiff.binary ? activeFileDiff : null;
  const [editorDiff, setEditorDiff] = useState<RunFileDiff | null>(textDiff);
  if (textDiff && textDiff !== editorDiff) setEditorDiff(textDiff);
  else if (!selectedFile && editorDiff) setEditorDiff(null);
  const showsSelected = editorDiff !== null && editorDiff === textDiff;

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
          {editorDiff && (
            <MonacoDiff
              filePath={editorDiff.path}
              language={detectLanguage(editorDiff.path)}
              original={editorDiff.original}
              modified={editorDiff.modified}
              patch={editorDiff.patch}
              renderSideBySide={renderSideBySide}
              comments={showsSelected ? fileComments : NO_COMMENTS}
              draftLine={showsSelected && draft && draft !== 'file' ? draft : null}
              onLineClick={
                showsSelected
                  ? (line, side) => {
                      onActiveLineChange({ line, side });
                      onDraftChange({ line, side });
                    }
                  : noop
              }
              onFocusComment={showsSelected ? onFocusComment : noop}
              onActiveLineChange={showsSelected ? onActiveLineChange : undefined}
              revealTarget={showsSelected ? revealTarget : null}
              pending={!showsSelected && loadingFile}
              hidden={!showsSelected && !loadingFile}
            />
          )}
          {activeFileDiff?.binary ? (
            <div className="empty review-empty">
              Binary file (`{activeFileDiff.path}`) — comment on the file above, or switch to the Artifacts
              tab to preview or download it.
            </div>
          ) : activeFileDiff ? null : loadingFile ? (
            !editorDiff && <div className="empty review-empty">Loading file diff…</div>
          ) : (
            <div className="empty review-empty">This file&apos;s diff could not be loaded.</div>
          )}
        </>
      )}
    </div>
  );
}

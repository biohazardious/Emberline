import type { FormEvent } from 'react';

interface Props {
  branch: string | null;
  commitMessage: string;
  onCommitMessageChange: (msg: string) => void;
  stageAllOnCommit: boolean;
  onStageAllChange: (checked: boolean) => void;
  gitBusy: boolean;
  onCommit: (e: FormEvent) => void;
  onPush: () => void;
  requestableCount: number;
  onOpenRequestChanges: () => void;
}

export function ReviewCommitBar({
  branch,
  commitMessage,
  onCommitMessageChange,
  stageAllOnCommit,
  onStageAllChange,
  gitBusy,
  onCommit,
  onPush,
  requestableCount,
  onOpenRequestChanges,
}: Props) {
  return (
    <div className="review-actions-bar">
      <form className="review-commit-form" onSubmit={onCommit}>
        <input
          type="text"
          className="input"
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          placeholder={`Commit message on ${branch || 'worktree branch'}…`}
          disabled={gitBusy}
        />
        <label className="review-checkbox-label">
          <input
            type="checkbox"
            checked={stageAllOnCommit}
            onChange={(e) => onStageAllChange(e.target.checked)}
          />
          Stage all (-A)
        </label>
        <button type="submit" className="btn btn-sm btn-primary" disabled={gitBusy || !commitMessage.trim()}>
          Commit
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={gitBusy}
          onClick={onPush}
          title={`Push ${branch ?? 'branch'} to origin`}
        >
          Push Branch
        </button>
      </form>

      <div className="review-annotations-dispatch">
        <button
          type="button"
          className="btn btn-sm btn-primary review-tabular"
          onClick={onOpenRequestChanges}
        >
          Request changes ({requestableCount})
        </button>
      </div>
    </div>
  );
}

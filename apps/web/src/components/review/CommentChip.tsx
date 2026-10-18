import type { ReviewComment } from '@emberline/protocol';
import { Link } from 'wouter';
import { commentActions, commentBadges, commentLocation } from '../../reviewComments';

interface Props {
  comment: ReviewComment;
  focused?: boolean;
  busy?: boolean;
  onDelete: (id: string) => void;
  onResolve: (id: string) => void;
  onVerify: (id: string) => void;
  onNotDone: (id: string) => void;
}

export function commentChipId(id: string): string {
  return `review-comment-${id}`;
}

export function CommentChip({ comment, focused, busy, onDelete, onResolve, onVerify, onNotDone }: Props) {
  const badges = commentBadges(comment);
  const actions = commentActions(comment);
  const shortCarried = comment.carriedTo ? comment.carriedTo.slice(0, 8) : null;
  return (
    <div
      id={commentChipId(comment.id)}
      tabIndex={-1}
      className={`comment-chip comment-chip-${comment.priority}${focused ? ' comment-chip-focused' : ''}${comment.status === 'sent' ? ' diff-annotation-sent' : ''}`}
    >
      <div className="comment-chip-head">
        <span className="mono comment-chip-loc">{commentLocation(comment)}</span>
        <span className="badge badge-soft">{badges.intent}</span>
        <span className={`badge comment-badge-${comment.priority}`}>{badges.priority}</span>
        {comment.status === 'sent' && (
          <span className="badge badge-soft" title="Sent to the agent; mark it resolved once handled">
            sent
          </span>
        )}
        {comment.status === 'addressed' && <span className="badge badge-soft">addressed</span>}
        {comment.outdated && <span className="badge badge-soft">outdated</span>}
      </div>
      <p className="comment-chip-body">{comment.body}</p>
      {comment.outdated && comment.anchorText && (
        <p className="muted small comment-chip-anchor">
          Was at line {comment.line}: <code>{comment.anchorText}</code>
        </p>
      )}
      {shortCarried && (
        <p className="muted small">
          Carried to run{' '}
          <Link href={`/runs/${comment.carriedTo}/review`} className="mono">
            {shortCarried}
          </Link>
        </p>
      )}
      {actions.length > 0 && (
        <div className="comment-chip-actions">
          {actions.includes('verify') && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onVerify(comment.id)}>
              Verify
            </button>
          )}
          {actions.includes('notDone') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onNotDone(comment.id)}>
              Not done
            </button>
          )}
          {actions.includes('resolve') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve(comment.id)}>
              Mark resolved
            </button>
          )}
          {actions.includes('delete') && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onDelete(comment.id)}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

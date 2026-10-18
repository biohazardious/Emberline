import type { ReviewCommentIntent, ReviewCommentPriority } from '@emberline/protocol';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { escapeDraft, INTENT_OPTIONS, PRIORITY_OPTIONS } from '../../reviewComments';

export interface CommentDraft {
  body: string;
  intent: ReviewCommentIntent;
  priority: ReviewCommentPriority;
}

interface Props {
  /** Where the comment attaches, e.g. `src/a.ts:12 (modified)` or `src/a.ts (whole file)`. */
  target: string;
  busy?: boolean;
  onSubmit: (draft: CommentDraft) => void;
  onCancel: () => void;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="comment-composer-field">
      <span className="muted small" id={`seg-${label}`}>
        {label}
      </span>
      <div className="segmented segmented-wrap" role="radiogroup" aria-labelledby={`seg-${label}`}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'active' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CommentComposer({ target, busy, onSubmit, onCancel }: Props) {
  const [body, setBody] = useState('');
  const [intent, setIntent] = useState<ReviewCommentIntent>('fix');
  const [priority, setPriority] = useState<ReviewCommentPriority>('important');
  // Escape on a written draft asks first instead of dropping it.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = body.trim().length > 0 && !busy;

  useEffect(() => areaRef.current?.focus(), []);

  const submit = () => {
    if (canSubmit) onSubmit({ body: body.trim(), intent, priority });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };
  const keepDraft = () => {
    setConfirmDiscard(false);
    areaRef.current?.focus();
  };
  // Anywhere in the composer: an empty one closes; a written draft asks, and Escape again keeps it.
  const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const action = escapeDraft(body, confirmDiscard);
    if (action === 'keep') keepDraft();
    else if (action === 'close') onCancel();
    else setConfirmDiscard(true);
  };

  return (
    <form
      className="comment-composer"
      aria-label={`Comment on ${target}`}
      onKeyDown={onFormKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="mono comment-composer-target">{target}</span>
      <textarea
        ref={areaRef}
        className="input comment-composer-body"
        rows={3}
        value={body}
        maxLength={10_000}
        aria-label="Comment"
        placeholder="Write review feedback for the agent… (Ctrl/Cmd+Enter to add)"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {confirmDiscard && (
        <div className="comment-composer-discard" role="alert">
          <span className="small">Discard draft?</span>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Discard
          </button>
          <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={keepDraft}>
            Keep
          </button>
        </div>
      )}
      <div className="comment-composer-controls">
        <Segmented label="Intent" value={intent} options={INTENT_OPTIONS} onChange={setIntent} />
        <Segmented label="Priority" value={priority} options={PRIORITY_OPTIONS} onChange={setPriority} />
        <div className="comment-composer-actions">
          <button type="submit" className="btn btn-sm btn-primary" disabled={!canSubmit}>
            Add comment
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

import type { ReviewComment } from '@emberline/protocol';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, errorMessage } from '../../api';
import { trapTab } from '../../focusTrap';
import { requestSummary } from '../../reviewComments';

type Target = 'same' | 'new';

interface Props {
  /** The comments this send would carry (open plus addressed). */
  comments: ReviewComment[];
  /** Where it can send (`new` only for a ticket run). */
  targets: Target[];
  /** Resolves when the send worked; a rejection keeps the dialog open with the message. */
  onSend: (note: string, target: Target) => Promise<void>;
  onClose: () => void;
}

export function RequestChangesDialog({ comments, targets, onSend, onClose }: Props) {
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<Target>('same');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canStartNew, setCanStartNew] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Focus starts in the note and stays in the dialog; it goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    noteRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else trapTab(dialogRef.current, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (chosen: Target) => {
    setBusy(true);
    setError(null);
    try {
      await onSend(note.trim(), chosen);
    } catch (e) {
      setError(errorMessage(e));
      setCanStartNew(chosen === 'same' && e instanceof ApiRequestError && e.data.canStartNew === true);
    } finally {
      setBusy(false);
    }
  };

  const empty = comments.length === 0 && !note.trim();

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={dialogRef}
        className="drawer request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="request-dialog-title" className="issue-dialog-title">
            Request changes
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <p className="small" data-testid="request-summary">
          {requestSummary(comments)}
        </p>
        <label className="request-dialog-field">
          <span className="muted small">Note for the agent (optional)</span>
          <textarea
            ref={noteRef}
            className="input"
            rows={4}
            maxLength={20_000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <fieldset className="request-dialog-targets">
          <legend className="muted small">Send to</legend>
          <label>
            <input type="radio" name="target" checked={target === 'same'} onChange={() => setTarget('same')} /> This run
          </label>
          {targets.includes('new') && (
            <label>
              <input type="radio" name="target" checked={target === 'new'} onChange={() => setTarget('new')} /> New run
              from main
            </label>
          )}
          {target === 'new' && (
            <p className="muted small">
              The new run starts from main, so the earlier attempt is not in its worktree. These comments are carried
              into its prompt and marked resolved here.
            </p>
          )}
        </fieldset>
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
            {canStartNew && (
              <>
                {' '}
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send('new')}>
                  Start a new run instead
                </button>
              </>
            )}
          </div>
        )}
        <div className="request-dialog-actions">
          <button type="button" className="btn btn-primary" disabled={busy || empty} onClick={() => void send(target)}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}

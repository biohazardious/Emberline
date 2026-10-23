import type { Run, RunQuestion } from '@emberline/protocol';
import { Paperclip, X } from 'lucide-react';
import { type DragEvent, type Ref, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { answerCapLine, canSend } from '../answerDialog';
import { trapTab } from '../focusTrap';
import { useAnswerDialog } from './useAnswerDialog';
import { MaterialList } from './wizard/MaterialList';
import type { WizardMaterial } from './wizard/materials';

export interface AnswerDialogViewProps {
  heading: { key: string | null; title: string };
  question: RunQuestion | null;
  /** The question is still being fetched. */
  loading?: boolean;
  text: string;
  files: WizardMaterial[];
  problems: string[];
  busy: boolean;
  suggesting: boolean;
  error: string | null;
  /** A suggestion arrived while the box had an answer: Replace / Keep. */
  confirmReplace?: boolean;
  /** Escape or a click outside with an answer or files: Close / Keep editing. */
  confirmClose?: boolean;
  onText: (v: string) => void;
  onOption: (i: number) => void;
  onSuggest: () => void;
  onReplace?: () => void;
  onKeepAnswer?: () => void;
  onFiles: (list: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  onSend: () => void;
  /** Cancel and the close button: closes; the text stays a draft. */
  onCancel: () => void;
  /** Escape and a click outside; asks first when something would be lost. Defaults to `onCancel`. */
  onDismiss?: () => void;
  onKeepEditing?: () => void;
  /** Missing when the run has no terminal. */
  onOpenTerminal?: () => void;
  textRef?: Ref<HTMLTextAreaElement>;
  dialogRef?: Ref<HTMLElement>;
}

/** The dialog from plain props, so it renders in tests without fetching. */
export function AnswerDialogView(p: AnswerDialogViewProps) {
  const q = p.question;
  const permission = q?.kind === 'permission';
  const dismiss = p.onDismiss ?? p.onCancel;
  return (
    <div className="drawer-backdrop" onClick={dismiss}>
      <aside
        ref={p.dialogRef}
        className="drawer answer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="answer-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="answer-dialog-title" className="issue-dialog-title">
            {p.heading.key && <span className="mono">{p.heading.key}</span>} {p.heading.title}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={p.onCancel}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <section className="answer-question" aria-label="What the agent asks">
          {q ? (
            <pre className="answer-question-text">{q.text || 'The agent did not say what it needs.'}</pre>
          ) : (
            p.loading && <p className="muted small">Loading the question…</p>
          )}
        </section>
        {q && q.options.length > 0 && !permission && (
          <div className="answer-options" role="group" aria-label="Options the agent offered">
            {q.options.map((o, i) => (
              <button
                key={o.label}
                type="button"
                className="btn btn-sm"
                title={o.detail ?? undefined}
                disabled={p.busy}
                onClick={() => p.onOption(i)}
              >
                {o.label}
              </button>
            ))}
            {q.picker && <span className="muted small">An option answers Claude's picker right away.</span>}
          </div>
        )}
        {permission ? (
          <p className="small">
            A permission prompt is answered in the agent's terminal.{' '}
            <button
              type="button"
              className="btn btn-sm"
              disabled={!p.onOpenTerminal}
              onClick={p.onOpenTerminal}
            >
              Open terminal
            </button>
          </p>
        ) : (
          <div className="answer-suggest">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!q?.suggest.available || p.suggesting || p.busy}
              onClick={p.onSuggest}
            >
              {p.suggesting ? 'Suggesting…' : 'Suggest an answer'}
            </button>
            {q && !q.suggest.available && q.suggest.reason && (
              <span className="muted small">{q.suggest.reason}</span>
            )}
          </div>
        )}
        <form
          className="answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSend();
          }}
        >
          <label className="answer-field">
            <span className="muted small">Your answer</span>
            <textarea
              ref={p.textRef}
              className="input answer-text"
              rows={8}
              maxLength={20_000}
              value={p.text}
              onChange={(e) => p.onText(e.target.value)}
            />
          </label>
          {p.confirmReplace && (
            <div className="comment-composer-discard" role="alert">
              <span className="small">Replace your answer?</span>
              <button type="button" className="btn btn-sm" onClick={p.onReplace}>
                Replace
              </button>
              <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={p.onKeepAnswer}>
                Keep
              </button>
            </div>
          )}
          <div
            className="answer-files"
            onDragOver={(e: DragEvent) => e.preventDefault()}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              p.onFiles(e.dataTransfer.files);
            }}
          >
            <div className="answer-files-head">
              <label className="btn btn-sm wizard-file">
                <Paperclip className="icon" aria-hidden /> Attach files
                <input
                  type="file"
                  className="wizard-file-input"
                  multiple
                  disabled={p.busy}
                  onChange={(e) => {
                    if (e.target.files) p.onFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="muted small">{answerCapLine(p.files)} · or drop files here</span>
            </div>
            <MaterialList materials={p.files} onRemove={p.busy ? undefined : p.onRemoveFile} />
            {p.problems.map((m) => (
              <p key={m} className="small banner banner-warn">
                {m}
              </p>
            ))}
          </div>
          {p.error && (
            <div className="banner banner-error" role="alert">
              {p.error}
            </div>
          )}
          {p.confirmClose && (
            <div className="comment-composer-discard" role="alert">
              <span className="small">
                Close without sending? Your answer stays as a draft
                {p.files.length > 0 ? '; the attached files are not kept.' : '.'}
              </span>
              <button type="button" className="btn btn-sm" onClick={p.onCancel}>
                Close
              </button>
              <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={p.onKeepEditing}>
                Keep editing
              </button>
            </div>
          )}
          <div className="request-dialog-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSend(p.text, p.files, p.busy) || permission}
            >
              {p.busy ? 'Sending…' : 'Send'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={p.onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

/** Answer what a waiting run asks: its question, the options it offered, a suggestion, files. */
export function AnswerDialog(props: {
  run: Run;
  heading: { key: string | null; title: string };
  initialText?: string;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { run, heading, onClose } = props;
  const state = useAnswerDialog(props);
  const [, navigate] = useLocation();
  const dialogRef = useRef<HTMLElement>(null);
  const dismissRef = useRef(state.onDismiss);
  dismissRef.current = state.onDismiss;
  const { textRef } = state;

  // Focus starts in the answer and stays in the dialog; it goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textRef.current?.focus();
    return () => opener?.focus();
  }, [textRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissRef.current();
      } else trapTab(dialogRef.current, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <AnswerDialogView
      {...state}
      heading={heading}
      dialogRef={dialogRef}
      onCancel={onClose}
      onOpenTerminal={
        run.terminalId
          ? () => {
              onClose();
              navigate(`/terminals/${run.terminalId}`);
            }
          : undefined
      }
    />
  );
}

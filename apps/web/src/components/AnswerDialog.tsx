import type { Run, RunQuestion } from '@emberline/protocol';
import { Paperclip, X } from 'lucide-react';
import { type DragEvent, type Ref, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import {
  answerCapLine,
  type AnswerProblem,
  canSend,
  handleDialogKey,
  pickerNote,
  QUESTION_SOURCE_LINES,
} from '../answerDialog';
import { timeAgo, useNow } from '../time';
import { useAnswerDialog } from './useAnswerDialog';
import { MaterialList } from './wizard/MaterialList';
import { droppedFiles, type MaterialCandidate, type WizardMaterial } from './wizard/materials';

export interface AnswerDialogViewProps {
  heading: { key: string | null; title: string };
  /** The run's agent, for the header. */
  agent?: string;
  /** How long the run has waited, e.g. "5m"; null when unknown. */
  waited?: string | null;
  question: RunQuestion | null;
  /** The question is still being fetched. */
  loading?: boolean;
  text: string;
  files: WizardMaterial[];
  problems: AnswerProblem[];
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
  /** Picked or dropped files; a dropped folder is marked so it is refused. */
  onFiles: (candidates: MaterialCandidate[]) => void;
  onRemoveFile: (id: string) => void;
  onSend: () => void;
  /** Cancel and the close button; the text stays a draft, attached files make it ask first. */
  onCancel: () => void;
  /** The confirmation's Close: closes without asking again. Defaults to `onCancel`. */
  onConfirmClose?: () => void;
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
  // Nothing can be sent to a permission prompt; it is answered in the terminal.
  const locked = permission || p.busy;
  const note = q ? pickerNote(q) : null;
  const suggestReason = q && !q.suggest.available ? q.suggest.reason : null;
  return (
    // A click on the backdrop stays here: inside the ticket drawer it would close the drawer too.
    <div
      className="answer-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        dismiss();
      }}
    >
      <section
        ref={p.dialogRef}
        className="answer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="answer-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="answer-dialog-head">
          <div className="answer-dialog-heading">
            <h2 id="answer-dialog-title" className="issue-dialog-title">
              {p.heading.key && <span className="mono">{p.heading.key}</span>} {p.heading.title}
            </h2>
            {(p.agent || p.waited) && (
              <span className="muted small">
                {p.agent && <span className="mono">{p.agent}</span>}
                {p.agent && p.waited && ' · '}
                {p.waited && `waiting for ${p.waited}`}
              </span>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={p.onCancel}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <section className="answer-question" aria-label="What the agent asks">
          {q ? (
            <>
              <pre className="answer-question-text">{q.text || 'The agent did not say what it needs.'}</pre>
              <p className="muted small answer-question-source">{QUESTION_SOURCE_LINES[q.source]}</p>
            </>
          ) : (
            p.loading && <p className="muted small">Loading the question…</p>
          )}
        </section>
        {q && q.options.length > 0 && !permission && (
          <div className="answer-options" role="group" aria-label="Options the agent offered">
            {/* The detail is shown, not a tooltip: touch screens have no hover, and it describes the chip. */}
            {q.options.map((o, i) => (
              <span key={`${i}-${o.label}`} className="answer-option">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-describedby={o.detail ? `answer-option-detail-${i}` : undefined}
                  disabled={p.busy}
                  onClick={() => p.onOption(i)}
                >
                  {o.label}
                </button>
                {o.detail && (
                  <span id={`answer-option-detail-${i}`} className="muted small">
                    {o.detail}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        {note && !permission && <p className="muted small">{note}</p>}
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
              aria-describedby={suggestReason ? 'answer-suggest-reason' : undefined}
              onClick={p.onSuggest}
            >
              {p.suggesting ? 'Suggesting…' : 'Suggest an answer'}
            </button>
            {suggestReason && (
              <span id="answer-suggest-reason" className="muted small">
                {suggestReason}
              </span>
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
              disabled={permission}
              onChange={(e) => p.onText(e.target.value)}
            />
          </label>
          {p.confirmReplace && (
            <div className="comment-composer-discard" role="alert">
              <span className="small">Replace your answer?</span>
              <button type="button" className="btn btn-sm" onClick={p.onReplace}>
                Replace
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={p.onKeepAnswer}>
                Keep
              </button>
            </div>
          )}
          <div
            className="answer-files"
            onDragOver={(e: DragEvent) => e.preventDefault()}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              if (!locked) p.onFiles(droppedFiles(e.dataTransfer));
            }}
          >
            <div className="answer-files-head">
              <label className="btn btn-sm wizard-file">
                <Paperclip className="icon" aria-hidden /> Attach files
                <input
                  type="file"
                  className="wizard-file-input"
                  multiple
                  disabled={locked}
                  onChange={(e) => {
                    if (e.target.files)
                      p.onFiles([...e.target.files].map((file) => ({ file, name: file.name })));
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="muted small">{answerCapLine(p.files)} · or drop files here</span>
            </div>
            <MaterialList materials={p.files} onRemove={locked ? undefined : p.onRemoveFile} />
            {/* Always there, so a screen reader hears each problem as it appears. */}
            <div role="status" aria-live="polite" className="answer-file-problems">
              {p.problems.map((m) => (
                <p key={m.id} className="small banner banner-warn">
                  {m.text}
                </p>
              ))}
            </div>
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
              <button type="button" className="btn btn-sm" onClick={p.onConfirmClose ?? p.onCancel}>
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
      </section>
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
  const { run, heading } = props;
  const { onClose, ...state } = useAnswerDialog(props);
  const [, navigate] = useLocation();
  const dialogRef = useRef<HTMLElement>(null);
  const dismissRef = useRef(state.onDismiss);
  dismissRef.current = state.onDismiss;
  const { textRef } = state;
  const now = useNow(30_000);
  const since = run.attention?.since;

  // Focus starts in the answer and stays in the dialog; it goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textRef.current?.focus();
    return () => opener?.focus();
  }, [textRef]);

  // Capture phase: the dialog sees Escape and Tab before the ticket drawer's own Escape listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleDialogKey(e, dialogRef.current, () => dismissRef.current());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // On the body, so the ticket drawer or the run dock never clips or covers it.
  return createPortal(
    <AnswerDialogView
      {...state}
      heading={heading}
      agent={run.agent}
      waited={since ? timeAgo(since, now).replace(/ ago$/, '') : null}
      dialogRef={dialogRef}
      onOpenTerminal={
        run.terminalId
          ? () => {
              onClose();
              navigate(`/terminals/${run.terminalId}`);
            }
          : undefined
      }
    />,
    document.body,
  );
}

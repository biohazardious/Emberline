import type { Run, RunRecovery, RecoverySuggestion } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { copyText } from '../clipboard';
import { AnswerDialog } from './AnswerDialog';
import {
  discardConfirm,
  initialAnswerText,
  recoverErrorText,
  recoveryApplies,
  recoveryHeading,
  visibleSuggestions,
} from '../holdRecovery';

interface Props {
  run: Run;
  /** Inbox: the caller opens the Answer dialog itself (with this start text); the row also drops the hold's label it already shows. */
  onAnswer?: (initialText: string) => void;
  /** Without these the suggestion is not offered; the ticket link takes their place. */
  onDiscard?: () => Promise<void> | void;
  onMerge?: () => Promise<void> | void;
}

/** Why a finished run is held and the ways out of it (`GET /api/runs/:id/recovery`). Key it by run id. */
export function HoldRecovery({ run, onAnswer, onDiscard, onMerge }: Props) {
  const client = useQueryClient();
  const applies = recoveryApplies(run);
  const query = useQuery({
    queryKey: ['run-recovery', run.id],
    queryFn: () => api<RunRecovery | null>(`/api/runs/${run.id}/recovery`),
    enabled: applies,
  });
  // The Answer dialog this block opens itself (undefined: closed); the Inbox opens its own through onAnswer.
  const [answer, setAnswer] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string>();

  const rec = query.data;
  if (!applies || !rec) return null;

  const refetch = () => void client.invalidateQueries({ queryKey: ['run-recovery', run.id] });
  const ticketHref = run.ticketId ? `/projects/${run.projectId}/board?ticket=${run.ticketId}` : null;
  const suggestions = visibleSuggestions(rec, { onDiscard, onMerge, ticket: !!ticketHref });
  const canDeliver = rec.delivery !== 'none';
  const linkOnly = !onDiscard && !onMerge && ticketHref && !suggestions.some((s) => s.onTicket);

  const guarded = async (action: () => Promise<void> | void) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const copy = async (key: string, value: string) => {
    if (await copyText(value)) {
      setCopied(key);
    } else {
      setError('Could not copy to the clipboard.');
    }
  };

  const primary = suggestions[0]?.id;
  const btn = (s: RecoverySuggestion) => `btn btn-sm${s.id === primary ? ' btn-primary' : ''}`;

  const promptButton = (s: RecoverySuggestion) => {
    const prompt = s.prompt ?? '';
    if (!canDeliver) {
      return (
        <button type="button" className={btn(s)} onClick={() => void copy(s.id, prompt)}>
          {copied === s.id ? 'Copied' : 'Copy'}: {s.label}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={btn(s)}
        disabled={busy}
        onClick={() => (onAnswer ? onAnswer(initialAnswerText(s)) : setAnswer(initialAnswerText(s)))}
      >
        {s.label}
      </button>
    );
  };

  const heading = recoveryHeading(rec, !!onAnswer);

  return (
    <section className="hold-recovery" aria-label="Held run">
      <div className="hold-recovery-head">
        {heading.label !== null && <strong>{heading.label}</strong>}
        <span className="muted small">{heading.why}</span>
      </div>
      {!canDeliver && <p className="muted small hold-recovery-none">{recoverErrorText('no_session', '')}</p>}
      <ul className="hold-recovery-list">
        {suggestions.map((s) => (
          <li key={s.id} className="hold-recovery-item">
            {s.kind === 'prompt' && promptButton(s)}
            {s.onTicket && (
              <Link href={ticketHref!} className={btn(s)}>
                {s.label}
              </Link>
            )}
            {s.kind === 'discard' &&
              !s.onTicket &&
              (confirming ? (
                <span className="hold-recovery-confirm">
                  <span className="small">{discardConfirm(s).question}</span>
                  <button
                    type="button"
                    className="btn btn-sm danger"
                    disabled={busy}
                    onClick={() => void guarded(onDiscard!)}
                  >
                    {discardConfirm(s).confirm}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" className={btn(s)} disabled={busy} onClick={() => setConfirming(true)}>
                  {s.label}
                </button>
              ))}
            {s.kind === 'merge' && !s.onTicket && (
              <button type="button" className={btn(s)} disabled={busy} onClick={() => void guarded(onMerge!)}>
                {s.label}
              </button>
            )}
            {s.kind === 'open_review' && (
              <Link href={`/runs/${run.id}/review`} className={btn(s)}>
                {s.label}
              </Link>
            )}
            {s.kind === 'manual' && (
              <div className="hold-recovery-manual">
                <span className="small">{s.label}</span>
                {s.files.length > 0 && (
                  <ul className="hold-recovery-files mono small">
                    {s.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
                {s.commands.map((c) => (
                  <div key={c} className="hold-recovery-command">
                    <code className="mono small">{c}</code>
                    <button type="button" className="btn btn-xs btn-ghost" onClick={() => void copy(c, c)}>
                      {copied === c ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {s.detail && <span className="muted small hold-recovery-detail">{s.detail}</span>}
          </li>
        ))}
      </ul>
      {linkOnly && (
        <Link href={ticketHref} className="btn btn-sm btn-ghost">
          Open ticket
        </Link>
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {answer !== undefined && (
        <AnswerDialog
          run={run}
          heading={{ key: null, title: run.title ?? 'Run' }}
          initialText={answer}
          onClose={() => setAnswer(undefined)}
          onSent={refetch}
        />
      )}
    </section>
  );
}

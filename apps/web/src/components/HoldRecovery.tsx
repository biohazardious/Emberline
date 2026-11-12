import type { Run, RunRecovery, RecoverySuggestion } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { refreshAfterAnswer } from '../answerDialog';
import { copyText } from '../clipboard';
import { AnswerDialog } from './AnswerDialog';
import {
  buildManualConflictRecovery,
  type ConflictHoldFallback,
  discardConfirm,
  initialAnswerText,
  recoverErrorText,
  recoveryApplies,
  recoveryHeading,
  visibleSuggestions,
  waitSuggestionHref,
} from '../holdRecovery';
import type { SyncResolvingNotice } from '../syncResolution';

interface Props {
  run: Run;
  /** The caller opens the Answer dialog itself (with this start text): the Inbox, and the run dock through `useHoldAnswer`. */
  onAnswer?: (initialText: string) => void;
  /** Leaves out the hold's label, for a row that shows it already (the Inbox). */
  hideLabel?: boolean;
  /** Without these the suggestion is not offered; the ticket link takes their place. */
  onDiscard?: () => Promise<void> | void;
  onMerge?: () => Promise<void> | void;
  /** Manual conflict fallback when a person's merge failed on an unheld run. */
  conflictFallback?: ConflictHoldFallback | null;
}

/** Info banner shown when a person's accept/merge escalates to the agent or a resolver run. */
export function SyncResolutionBanner({
  notice,
  onDismiss,
}: {
  notice: Pick<SyncResolvingNotice, 'text' | 'href' | 'linkLabel'>;
  onDismiss?: () => void;
}) {
  return (
    <div className="banner banner-info sync-resolution-banner" role="status">
      <span>{notice.text}</span>
      <Link href={notice.href} className="btn btn-sm">
        {notice.linkLabel}
      </Link>
      {onDismiss && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** The held run's recovery (`GET /api/runs/:id/recovery`), shared by the hold block and the Inbox's Answer. */
export function useRunRecovery(run: Run) {
  return useQuery({
    queryKey: ['run-recovery', run.id],
    queryFn: () => api<RunRecovery | null>(`/api/runs/${run.id}/recovery`),
    enabled: recoveryApplies(run),
  });
}

/**
 * The Answer dialog a hold block opens (`open` with its start text), for whoever outlives the block:
 * HoldRecovery itself, or a caller whose block can unmount while the dialog is open (the run dock's
 * tab panes). `dialog` goes outside whatever can unmount, so the person's files stay until they close it.
 */
export function useHoldAnswer(run: Run): { open: (initialText: string) => void; dialog: ReactNode } {
  const client = useQueryClient();
  // The open dialog's start text; undefined: closed.
  const [answer, setAnswer] = useState<string>();
  return {
    open: setAnswer,
    dialog: answer !== undefined && (
      <AnswerDialog
        run={run}
        heading={{ key: null, title: run.title ?? 'Run' }}
        initialText={answer}
        onClose={() => setAnswer(undefined)}
        onSent={() => refreshAfterAnswer(client, run.id)}
      />
    ),
  };
}

/** Why a finished run is held and the ways out of it (`GET /api/runs/:id/recovery`). Key it by run id. */
export function HoldRecovery({ onAnswer, conflictFallback, ...props }: Props) {
  const { run } = props;
  // Without onAnswer the block opens its own dialog. It sits beside the block, not in it: a refetch
  // that ends the hold (any run event) hides the block, and the dialog stays.
  const answer = useHoldAnswer(run);
  const query = useRunRecovery(run);
  const rec =
    (recoveryApplies(run) ? query.data : null) ??
    (conflictFallback && conflictFallback.conflicts.length > 0
      ? buildManualConflictRecovery(run, conflictFallback)
      : null);

  return (
    <>
      {rec && <HoldRecoveryBlock {...props} rec={rec} onAnswer={onAnswer ?? answer.open} />}
      {answer.dialog}
    </>
  );
}

function HoldRecoveryBlock({
  run,
  rec,
  onAnswer,
  hideLabel = false,
  onDiscard,
  onMerge,
}: Omit<Props, 'onAnswer' | 'conflictFallback'> & {
  rec: RunRecovery;
  onAnswer: (initialText: string) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string>();

  const cachedRuns = client.getQueryData<Run[]>(['runs']);
  const resolverRunId = run.handedOffTo ?? cachedRuns?.find((r) => r.predecessorRunId === run.id)?.id ?? null;

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
      <button type="button" className={btn(s)} disabled={busy} onClick={() => onAnswer(initialAnswerText(s))}>
        {s.label}
      </button>
    );
  };

  const heading = recoveryHeading(rec, hideLabel);

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
            {s.kind === 'manual' &&
              (() => {
                const waitHref = waitSuggestionHref(s, run, resolverRunId);
                if (waitHref) {
                  return (
                    <Link href={waitHref} className={btn(s)}>
                      {s.label}
                    </Link>
                  );
                }
                return (
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
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={() => void copy(c, c)}
                        >
                          {copied === c ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
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
    </section>
  );
}

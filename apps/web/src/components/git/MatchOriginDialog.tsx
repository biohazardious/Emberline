import type { GitBlockingRun } from '@emberline/protocol';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { ApiRequestError, errorMessage } from '../../api';
import { trapTab } from '../../focusTrap';

/** A blocking run as the page shows it; `status` is null from a core from before the field. */
export type BlockingRun = Omit<GitBlockingRun, 'status'> & { status: GitBlockingRun['status'] | null };

export interface Problem {
  text: string;
  runs: BlockingRun[];
  /** Match origin's refusal: whether the factory picks tickets up from Backlog (Backlog auto-pickup). */
  backlogPickup: boolean;
  /** Match origin's refusal: the pull's own ticket (Resolve with a ticket), closed instead of sent back. */
  pullTicketId: string | null;
}

/** A failed request as the strip shows it; `runs_live` also lists the runs that block the change. */
export function problemOf(error: unknown): Problem {
  const runs =
    error instanceof ApiRequestError && error.code === 'runs_live' && Array.isArray(error.data.runs)
      ? (error.data.runs as Partial<GitBlockingRun>[]).map(
          // A core from before the ticket fields (a page left open across an upgrade) sends id and title.
          (r): BlockingRun => ({
            id: String(r.id),
            ticketId: r.ticketId ?? null,
            ticketKey: r.ticketKey ?? null,
            title: r.title ?? null,
            status: r.status === 'waiting' || r.status === 'live' ? r.status : null,
          }),
        )
      : [];
  const backlogPickup = error instanceof ApiRequestError && error.data.backlogPickup === true;
  const pullTicketId =
    error instanceof ApiRequestError && typeof error.data.pullTicketId === 'string'
      ? error.data.pullTicketId
      : null;
  return { text: errorMessage(error), runs, backlogPickup, pullTicketId };
}

/**
 * The runs that block a change, each with its ticket's key as a link to the ticket on the board
 * (the run's title starts with that key) and whether it runs or waits to merge.
 */
export function BlockingRuns({ projectId, runs }: { projectId: string; runs: BlockingRun[] }) {
  return (
    <ul className="git-runs">
      {runs.map((r) => {
        const title = r.title ?? r.id;
        const rest =
          r.ticketKey && title.startsWith(`${r.ticketKey} `) ? title.slice(r.ticketKey.length) : ` ${title}`;
        return (
          <li key={r.id}>
            {r.ticketId && r.ticketKey ? (
              <>
                <Link href={`/projects/${projectId}/board?ticket=${r.ticketId}`}>{r.ticketKey}</Link>
                {rest}
              </>
            ) : (
              title
            )}
            {r.status && (
              <span className="muted"> ({r.status === 'live' ? 'running' : 'waiting to merge'})</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The error banner of a failed Git action, with the runs that block it when there are some. */
export function GitProblemBanner({ projectId, problem }: { projectId: string; problem: Problem }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{problem.text}</span>
      {problem.runs.length > 0 && <BlockingRuns projectId={projectId} runs={problem.runs} />}
    </div>
  );
}

/** What setting the blocking runs aside does to their branches and tickets, as the dialog says it. */
export function setAsideNoteText(blocked: Problem): string {
  const pull = blocked.runs.find((r) => r.ticketId !== null && r.ticketId === blocked.pullTicketId);
  const others = blocked.runs.some((r) => r.ticketId === null || r.ticketId !== blocked.pullTicketId);
  const back = blocked.backlogPickup
    ? "go back to Backlog, where Backlog auto-pickup may start them again, on origin's history"
    : 'go back to Backlog';
  const closed = pull
    ? `${pull.ticketKey ?? "The pull's ticket"} is closed: once the branch takes origin's history, nothing is left to merge.`
    : null;
  if (closed && !others) return `Its branch stays as it is. ${closed}`;
  if (closed) return `Their branches stay as they are. ${closed} The other tickets ${back}.`;
  return `Their branches stay as they are; their tickets ${back}.`;
}

/**
 * Match origin's confirmation: what happens to the branch, and where its current tip is kept. Focus
 * starts on Cancel; Escape closes it.
 */
export function MatchOriginDialog({
  projectId,
  branch,
  notOnOrigin,
  blocked,
  busy,
  onConfirm,
  onClose,
}: {
  projectId: string;
  branch: string;
  /** The branch's commits origin has in no form (only the backup keeps them); null when not known. */
  notOnOrigin: number | null;
  /** Match origin's refusal because of runs: the dialog lists them and offers to set them aside. */
  blocked: Problem | null;
  busy: boolean;
  /** With the ids of the runs the person sets aside, or none (plain Match origin). */
  onConfirm: (setAside: string[] | null) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Mount-only: a parent re-render must not move the focus. `onClose` is read through a ref.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else trapTab(dialogRef.current, e);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={dialogRef}
        className="drawer request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-match-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="git-match-title" className="issue-dialog-title">
            Match {branch} with origin?
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden="true" />
          </button>
        </header>
        <p className="small">
          <span className="mono">{branch}</span> takes origin&apos;s history: it is reset to origin&apos;s{' '}
          <span className="mono">{branch}</span>. Its current tip is kept first as{' '}
          <span className="mono">refs/emberline/backup/{branch}-&lt;date&gt;-&lt;time&gt;</span> and listed
          under Backups on the Branches tab, so no commit is lost.
        </p>
        {notOnOrigin !== null && notOnOrigin > 0 && (
          <p className="small">
            {notOnOrigin === 1
              ? `1 commit of ${branch} is not on origin; Match origin keeps it only in the backup.`
              : `${notOnOrigin} commits of ${branch} are not on origin; Match origin keeps them only in the backup.`}
          </p>
        )}
        {blocked && (
          <div className="banner banner-warn" role="status">
            <span>{blocked.text}</span>
            <BlockingRuns projectId={projectId} runs={blocked.runs} />
            <p className="small git-runs-note">{setAsideNoteText(blocked)}</p>
          </div>
        )}
        <div className="request-dialog-actions">
          {blocked ? (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => onConfirm(blocked.runs.map((r) => r.id))}
            >
              Set aside
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onConfirm(null)}>
              Match origin
            </button>
          )}
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}

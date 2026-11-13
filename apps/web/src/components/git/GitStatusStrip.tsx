import type { GitBranch, GitPageStatus } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch as BranchIcon, RefreshCw, Rocket, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiRequestError, errorMessage } from '../../api';
import { trapTab } from '../../focusTrap';
import { FILES_NAMED, remoteStateText, splitBranches, syncText, tagsDifferText } from '../../gitPage';
import { timeAgo } from '../../time';

type Action = 'branch' | 'autopull' | 'fetch' | 'pull' | 'match' | 'ticket';

export interface Problem {
  text: string;
  runs: { id: string; title: string }[];
}

/** A failed request as the strip shows it; `runs_live` also lists the runs that block the change. */
export function problemOf(error: unknown): Problem {
  const runs =
    error instanceof ApiRequestError && error.code === 'runs_live' && Array.isArray(error.data.runs)
      ? (error.data.runs as { id: string; title: string }[])
      : [];
  return { text: errorMessage(error), runs };
}

/** The error banner of a failed Git action, with the runs that block it when there are some. */
export function GitProblemBanner({ problem }: { problem: Problem }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{problem.text}</span>
      {problem.runs.length > 0 && (
        <ul className="git-runs">
          {problem.runs.map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Match origin's confirmation: what happens to the branch, and where its current tip is kept. Focus
 * starts on Cancel; Escape closes it.
 */
function MatchOriginDialog({
  branch,
  onConfirm,
  onClose,
}: {
  branch: string;
  onConfirm: () => void;
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
            <X className="icon" aria-hidden />
          </button>
        </header>
        <p className="small">
          <span className="mono">{branch}</span> takes origin&apos;s history: it is reset to origin&apos;s{' '}
          <span className="mono">{branch}</span>. Its current tip is kept first as{' '}
          <span className="mono">refs/emberline/backup/{branch}-&lt;date&gt;-&lt;time&gt;</span> and listed
          under Backups on the Branches tab, so no commit is lost.
        </p>
        <div className="request-dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Match origin
          </button>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}

/** The strip at the top of the Git page: where the factory works, how main and origin stand, and the actions. */
export function GitStatusStrip({
  projectId,
  status,
  onOpenRelease,
}: {
  projectId: string;
  status: GitPageStatus;
  onOpenRelease: () => void;
}) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/git`;
  const [busy, setBusy] = useState<Action | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [confirmMatch, setConfirmMatch] = useState(false);
  const [allFiles, setAllFiles] = useState(false);

  const branches = useQuery({
    queryKey: ['git', projectId, 'branches'],
    queryFn: () => api<GitBranch[]>(`${base}/branches`),
    enabled: status.isGitRepo,
  });

  if (!status.isGitRepo) {
    return <p className="muted">This project folder is not a git repository.</p>;
  }

  const refresh = () => client.invalidateQueries({ queryKey: ['git', projectId] });
  const run = async (action: Action, work: () => Promise<unknown>) => {
    setBusy(action);
    setProblem(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(null);
    }
  };

  // A branch only on origin is offered too: picking it checks it out here first.
  const local = splitBranches(branches.data ?? []).shown.filter((b) => b.kind !== 'backup');
  const names = local.some((b) => b.name === status.workingBranch)
    ? local.map((b) => b.name)
    : [status.workingBranch, ...local.map((b) => b.name)];
  const onOrigin = new Set(local.filter((b) => b.kind === 'origin').map((b) => b.name));
  const detached = status.checkedOut === null;
  const mismatch = !detached && status.workingMismatch;
  const banner = syncText(status.sync);
  // A status read from a core before this field (a page left open across an upgrade) has none.
  const tagsNote = tagsDifferText(status.tagsDifferFromOrigin ?? []);
  const matchBranch = status.sync.branch ?? status.workingBranch;
  // How that branch stands against origin's as last read: Match origin helps only when its history
  // no longer fits (a conflict merging origin's branch in is the case besides the two stops).
  const matchState =
    matchBranch === status.workingBranch
      ? status.working
      : matchBranch === status.defaultBranch
        ? status.main
        : 'unknown';
  const offerMatch =
    status.sync.state === 'rewritten' ||
    status.sync.state === 'diverged' ||
    (status.sync.state === 'conflict' && (matchState === 'diverged' || matchState === 'rewritten'));
  const anyBusy = busy !== null;

  return (
    <section className="panel git-strip" aria-label="Git status">
      <div className="git-strip-row">
        <label className="git-strip-item">
          <BranchIcon className="icon" aria-hidden />
          <span className="muted small">Working branch</span>
          <select
            className="input mono git-branch-select"
            value={status.workingBranch}
            disabled={anyBusy}
            onChange={(e) =>
              void run('branch', () => api(`${base}/working-branch`, 'POST', { branch: e.target.value }))
            }
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {onOrigin.has(n) ? `${n} (on origin)` : n}
              </option>
            ))}
          </select>
        </label>
        <span className="git-strip-item small">
          {status.mainBehindWorking > 0 ? (
            <span>
              <span className="mono">{status.defaultBranch}</span> is {status.mainBehindWorking}{' '}
              {status.mainBehindWorking === 1 ? 'commit' : 'commits'} behind{' '}
              <span className="mono">{status.workingBranch}</span>
            </span>
          ) : (
            <span className="muted">
              <span className="mono">{status.defaultBranch}</span> is not behind
            </span>
          )}
          {status.latestTag && <span className="badge mono">{status.latestTag}</span>}
        </span>
        {status.hasOrigin && (
          <span className="git-strip-item small">
            {remoteStateText(status.working, status.workingCounts?.ahead, status.workingCounts?.behind)}
            <span className="muted">
              {status.checkedAt ? `read ${timeAgo(status.checkedAt)}` : 'not read yet'}
            </span>
          </span>
        )}
        <label className="review-checkbox-label small">
          <input
            type="checkbox"
            role="switch"
            checked={status.autoPull}
            disabled={anyBusy}
            onChange={(e) => void run('autopull', () => api(base, 'PATCH', { autoPull: e.target.checked }))}
          />
          Auto-pull
        </label>
        <div className="git-strip-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={anyBusy || !status.hasOrigin}
            onClick={() => void run('fetch', () => api(`${base}/fetch`, 'POST'))}
          >
            <RefreshCw className={busy === 'fetch' ? 'icon icon-spin' : 'icon'} aria-hidden /> Refresh
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={anyBusy || !status.hasOrigin}
            onClick={() => void run('pull', () => api(`${base}/pull`, 'POST'))}
          >
            Pull
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpenRelease}>
            <Rocket className="icon" aria-hidden /> Promote &amp; release…
          </button>
        </div>
      </div>

      {!status.hasOrigin && (
        <p className="muted small">
          No origin yet. Connect one in{' '}
          <Link href={`/projects/${projectId}/settings`}>Project settings → Repository</Link>.
        </p>
      )}

      {tagsNote && <p className="muted small">{tagsNote}</p>}

      {detached && (
        <div className="banner banner-warn" role="status">
          <span>
            The main workspace is not on a branch. Factory merges wait until a branch is checked out.
          </span>
        </div>
      )}
      {mismatch && (
        <div className="banner banner-warn" role="status">
          <span>
            The main workspace is on {status.checkedOut}, not the working branch {status.workingBranch}.
            Factory merges wait until it is switched back.
          </span>
          <div className="git-banner-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={anyBusy}
              onClick={() =>
                void run('branch', () =>
                  api(`${base}/working-branch`, 'POST', { branch: status.workingBranch }),
                )
              }
            >
              Switch back to {status.workingBranch}
            </button>
          </div>
        </div>
      )}

      {banner !== null && (
        <div
          className={`banner ${status.sync.state === 'idle' || status.sync.state === 'pulled' ? 'banner-info' : 'banner-warn'}`}
          role="status"
        >
          <span>{banner}</span>
          {status.sync.state === 'conflict' && status.sync.files.length > FILES_NAMED && (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                aria-expanded={allFiles}
                onClick={() => setAllFiles((v) => !v)}
              >
                {allFiles ? 'Hide the files' : `Show all ${status.sync.files.length} files`}
              </button>
              {allFiles && (
                <ul className="git-conflict-files mono small">
                  {status.sync.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="git-banner-actions">
            {offerMatch && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={anyBusy}
                onClick={() => setConfirmMatch(true)}
              >
                Match origin…
              </button>
            )}
            {status.sync.state === 'conflict' && ticketId === null && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={anyBusy}
                onClick={() =>
                  void run('ticket', async () => {
                    const made = await api<{ ticketId: string }>(`${base}/pull/ticket`, 'POST');
                    setTicketId(made.ticketId);
                  })
                }
              >
                Resolve with a ticket
              </button>
            )}
            {status.sync.state === 'conflict' && ticketId !== null && (
              <Link href={`/projects/${projectId}/board?ticket=${ticketId}`}>Open the ticket</Link>
            )}
          </div>
        </div>
      )}

      {problem && <GitProblemBanner problem={problem} />}

      {confirmMatch && (
        <MatchOriginDialog
          branch={matchBranch}
          onClose={() => setConfirmMatch(false)}
          onConfirm={() => {
            setConfirmMatch(false);
            void run('match', () => api(`${base}/match-origin`, 'POST', { branch: matchBranch }));
          }}
        />
      )}
    </section>
  );
}

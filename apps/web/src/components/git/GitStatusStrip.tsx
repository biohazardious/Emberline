import type { GitBranch, GitPageStatus } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch as BranchIcon, RefreshCw, Rocket } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, ApiRequestError, errorMessage } from '../../api';
import { remoteStateText, splitBranches, syncText } from '../../gitPage';
import { timeAgo } from '../../time';

type Action = 'branch' | 'autopull' | 'fetch' | 'pull' | 'match' | 'ticket';

interface Problem {
  text: string;
  runs: { id: string; title: string }[];
}

/** A failed request as the strip shows it; `runs_live` also lists the runs that block the change. */
function problemOf(error: unknown): Problem {
  const runs =
    error instanceof ApiRequestError && error.code === 'runs_live' && Array.isArray(error.data.runs)
      ? (error.data.runs as { id: string; title: string }[])
      : [];
  return { text: errorMessage(error), runs };
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

  const local = splitBranches(branches.data ?? []).shown.filter((b) => b.kind !== 'backup');
  const names = local.some((b) => b.name === status.workingBranch)
    ? local.map((b) => b.name)
    : [status.workingBranch, ...local.map((b) => b.name)];
  const banner = syncText(status.sync);
  const matchBranch = status.sync.branch ?? status.workingBranch;
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
                {n}
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
            {remoteStateText(status.working)}
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

      {banner !== null && (
        <div
          className={`banner ${status.sync.state === 'idle' ? 'banner-info' : 'banner-warn'}`}
          role="status"
        >
          <span>{banner}</span>
          <div className="git-banner-actions">
            {(status.sync.state === 'rewritten' || status.sync.state === 'diverged') && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={anyBusy}
                onClick={() =>
                  void run('match', () => api(`${base}/match-origin`, 'POST', { branch: matchBranch }))
                }
              >
                Match origin
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

      {problem && (
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
      )}
    </section>
  );
}

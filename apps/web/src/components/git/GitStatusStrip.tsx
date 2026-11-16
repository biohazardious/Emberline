import type { GitBranch, GitPageStatus } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch as BranchIcon, RefreshCw, Rocket } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import {
  FILES_NAMED,
  remoteStateText,
  splitBranches,
  syncText,
  tagsDifferText,
  tagsLikeBranchesText,
} from '../../gitPage';
import { timeAgo } from '../../time';
import { HelpHint, MoreMenu, Switch } from '../ui';
import {
  BlockingRuns,
  type BlockingRun,
  GitProblemBanner,
  MatchOriginDialog,
  type Problem,
  problemOf,
  setAsideNoteText,
} from './MatchOriginDialog';

export { BlockingRuns, type BlockingRun, GitProblemBanner, type Problem, problemOf, setAsideNoteText };

type Action = 'branch' | 'autopull' | 'fetch' | 'pull' | 'match' | 'ticket';

/** The strip at the top of the Git page: working branch, sync status, auto-pull switch and contextual action. */
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
  const [matchBlocked, setMatchBlocked] = useState<Problem | null>(null);
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

  const closeMatch = () => {
    setConfirmMatch(false);
    setMatchBlocked(null);
  };
  // Runs in the way keep the dialog open, listing them, so the person can set them aside from there.
  const match = async (setAside: string[] | null) => {
    setBusy('match');
    setProblem(null);
    try {
      await api(`${base}/match-origin`, 'POST', { branch: matchBranch, ...(setAside ? { setAside } : {}) });
      closeMatch();
      await refresh();
    } catch (e) {
      const p = problemOf(e);
      if (p.runs.length > 0) setMatchBlocked(p);
      else {
        closeMatch();
        setProblem(p);
      }
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
  const tagsNote = tagsDifferText(status.tagsDifferFromOrigin ?? []);
  const tagsLikeBranchesNote = tagsLikeBranchesText(status.tagsNamedLikeBranches ?? []);
  const matchBranch = status.sync.branch ?? status.workingBranch;
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
  const hasBannerAction = offerMatch || status.sync.state === 'conflict';
  const anyBusy = busy !== null;

  return (
    <section className="panel git-strip" aria-label="Git status">
      <div className="git-strip-row">
        <label className="git-strip-item">
          <BranchIcon className="icon" aria-hidden="true" />
          <span className="sr-only">Working branch</span>
          <select
            className="input mono git-branch-select"
            aria-label="Working branch"
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
        {((status.workingBranch !== status.defaultBranch && status.mainBehindWorking > 0) ||
          status.latestTag) && (
          <span className="git-strip-item small">
            {status.workingBranch !== status.defaultBranch && status.mainBehindWorking > 0 && (
              <span>
                <span className="mono">{status.defaultBranch}</span> {status.mainBehindWorking}{' '}
                {status.mainBehindWorking === 1 ? 'commit' : 'commits'} behind
              </span>
            )}
            {status.latestTag && <span className="badge mono">{status.latestTag}</span>}
          </span>
        )}
        {status.hasOrigin && (
          <span className="git-strip-item small">
            {remoteStateText(status.working, status.workingCounts?.ahead, status.workingCounts?.behind)}
            {(status.checkFailed || status.checkedAt) && (
              <span className="muted">{status.checkFailed ? 'read failed' : timeAgo(status.checkedAt!)}</span>
            )}
          </span>
        )}
        <span className="git-strip-item">
          <Switch
            checked={status.autoPull}
            disabled={anyBusy}
            label="Auto-pull"
            onChange={(checked) => void run('autopull', () => api(base, 'PATCH', { autoPull: checked }))}
          />
          <HelpHint topic="auto-pull">
            Fetches and fast-forwards from origin every 2 minutes. When origin is rewritten or diverges, Match
            origin resets the branch to origin and saves the previous tip under Backups on the Branches tab.
            {status.checkFailed && ' Origin is shown as of the last successful read; the latest read failed.'}
          </HelpHint>
        </span>
        <div className="git-strip-actions">
          {!hasBannerAction && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={anyBusy || !status.hasOrigin}
              onClick={() => void run('pull', () => api(`${base}/pull`, 'POST'))}
            >
              Pull
            </button>
          )}
          <MoreMenu
            ariaLabel="More Git actions"
            items={[
              ...(hasBannerAction
                ? [
                    {
                      id: 'pull',
                      label: 'Pull',
                      disabled: anyBusy || !status.hasOrigin,
                      onSelect: () => void run('pull', () => api(`${base}/pull`, 'POST')),
                    },
                  ]
                : []),
              {
                id: 'fetch',
                label: 'Refresh',
                icon: (
                  <RefreshCw className={busy === 'fetch' ? 'icon icon-spin' : 'icon'} aria-hidden="true" />
                ),
                disabled: anyBusy || !status.hasOrigin,
                onSelect: () => void run('fetch', () => api(`${base}/fetch`, 'POST')),
              },
              {
                id: 'release',
                label: 'Cut release',
                icon: <Rocket className="icon" aria-hidden="true" />,
                onSelect: onOpenRelease,
              },
            ]}
          />
        </div>
      </div>

      {!status.hasOrigin && (
        <p className="muted small">
          No origin yet. Connect one in{' '}
          <Link href={`/projects/${projectId}/settings`}>Project settings → Repository</Link>.
        </p>
      )}

      {tagsNote && <p className="muted small">{tagsNote}</p>}
      {tagsLikeBranchesNote && <p className="muted small">{tagsLikeBranchesNote}</p>}
      {status.originRefsUnread && (
        <p className="muted small">
          Some of origin&apos;s branches or tags could not be read. Emberline tries them again in a while.
        </p>
      )}

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
              Switch back
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
                {allFiles ? 'Hide files' : `Show ${status.sync.files.length} files`}
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

      {problem && <GitProblemBanner projectId={projectId} problem={problem} />}

      {confirmMatch && (
        <MatchOriginDialog
          projectId={projectId}
          branch={matchBranch}
          blocked={matchBlocked}
          busy={busy === 'match'}
          notOnOrigin={
            (matchBranch === status.workingBranch
              ? status.notOnOrigin?.working
              : matchBranch === status.defaultBranch
                ? status.notOnOrigin?.main
                : null) ?? null
          }
          onClose={closeMatch}
          onConfirm={(setAside) => void match(setAside)}
        />
      )}
    </section>
  );
}

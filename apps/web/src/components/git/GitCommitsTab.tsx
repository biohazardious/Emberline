import type { GitCommitDetail, GitCommitsPage, GitFileDiff, GitPageStatus } from '@emberline/protocol';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import { timeAgo } from '../../time';
import { SectionState } from '../SectionState';
import { GitDiffView } from './GitDiffView';

/** A history the tab can show: `ref` is what core reads (null: the working branch, its default). */
export interface HistoryChoice {
  ref: string | null;
  label: string;
}

type StatusFields = Pick<GitPageStatus, 'workingBranch'> &
  Partial<Pick<GitPageStatus, 'defaultBranch' | 'hasOrigin' | 'working' | 'main' | 'backups'>>;

/** Whether origin's branch was read as there (a state that compares with it). */
const readOnOrigin = (state: GitPageStatus['working'] | undefined) =>
  state !== undefined && state !== 'unpublished' && state !== 'unknown';

/**
 * The histories the Commits tab offers: the working branch first, then main, origin's branches as
 * last read, and the backups Match origin kept. Full ref names, so a branch named like a tag is
 * never read as the tag.
 */
export function historyChoices(status: StatusFields): HistoryChoice[] {
  const { workingBranch: working, defaultBranch: main } = status;
  const choices: HistoryChoice[] = [{ ref: null, label: working }];
  if (main && main !== working) choices.push({ ref: `refs/heads/${main}`, label: main });
  if (status.hasOrigin && readOnOrigin(status.working))
    choices.push({ ref: `refs/remotes/origin/${working}`, label: `origin/${working}` });
  if (status.hasOrigin && main && main !== working && readOnOrigin(status.main))
    choices.push({ ref: `refs/remotes/origin/${main}`, label: `origin/${main}` });
  for (const b of status.backups ?? [])
    choices.push({ ref: `refs/emberline/backup/${b}`, label: `backup ${b}` });
  return choices;
}

/**
 * What the working branch's history leaves out of origin's, as a sentence for above the list; null
 * when origin has nothing the working branch lacks.
 */
export function originHint(
  status: StatusFields & Partial<Pick<GitPageStatus, 'workingCounts'>>,
): string | null {
  const working = status.workingBranch;
  const behind = status.workingCounts?.behind ?? 0;
  const commits = `${behind} ${behind === 1 ? 'commit' : 'commits'}`;
  switch (status.working) {
    case 'rewritten':
      return behind > 0
        ? `origin/${working} has a different history, with ${commits} ${working} here does not have.`
        : `origin/${working} has a different history.`;
    case 'behind':
    case 'diverged':
      return behind > 0 ? `origin/${working} has ${commits} ${working} here does not have yet.` : null;
    default:
      return null;
  }
}

export function GitCommitsTab({ projectId, status }: { projectId: string; status: GitPageStatus }) {
  const base = `/api/projects/${projectId}/git/commits`;
  const choices = historyChoices(status);
  // The history picked belongs to the working branch it was picked on, and only while it is offered.
  const [shown, setShown] = useState<{ branch: string; ref: string } | null>(null);
  const ref =
    shown?.branch === status.workingBranch && choices.some((c) => c.ref === shown.ref) ? shown.ref : null;
  const originRef = `refs/remotes/origin/${status.workingBranch}`;
  const hint = ref === null && choices.some((c) => c.ref === originRef) ? originHint(status) : null;
  // The pick belongs to the history it was made in: another one starts at its newest commit.
  const [pick, setPick] = useState<{ branch: string; ref: string | null; sha: string } | null>(null);
  const picked = pick?.branch === status.workingBranch && pick.ref === ref ? pick.sha : null;
  const list = useInfiniteQuery({
    queryKey: ['git', projectId, 'commits', status.workingBranch, ref],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (ref !== null) query.set('ref', ref);
      if (pageParam !== null) query.set('cursor', String(pageParam));
      const qs = query.toString();
      return api<GitCommitsPage>(qs ? `${base}?${qs}` : base);
    },
    getNextPageParam: (last) => last.nextCursor,
    // A refetch would re-read every loaded page by offset; Load more and the status refresh are enough.
    refetchOnWindowFocus: false,
  });
  // Offset cursors can repeat a commit when new ones land between two pages.
  const commits = [
    ...new Map((list.data?.pages ?? []).flatMap((p) => p.commits).map((c) => [c.sha, c])).values(),
  ];
  const sha = picked ?? commits[0]?.sha ?? null;
  const show = (next: string | null) =>
    setShown(next === null ? null : { branch: status.workingBranch, ref: next });

  const picker =
    choices.length > 1 || hint !== null ? (
      <div className="git-history-bar">
        {choices.length > 1 && (
          <label className="git-strip-item small">
            <span className="muted">History of</span>
            <select
              className="input mono git-branch-select"
              value={ref ?? ''}
              onChange={(e) => show(e.target.value === '' ? null : e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.ref ?? ''} value={c.ref ?? ''}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {hint !== null && (
          <span className="small">
            {hint}{' '}
            <button type="button" className="link-btn" onClick={() => show(originRef)}>
              Show origin/{status.workingBranch}
            </button>
          </span>
        )}
      </div>
    ) : null;

  const detail = useQuery({
    queryKey: ['git', projectId, 'commit', sha],
    queryFn: () => api<GitCommitDetail>(`${base}/${sha}`),
    enabled: sha !== null,
    // A commit never changes.
    staleTime: Infinity,
  });
  const loadFile = useCallback(
    (path: string) => api<GitFileDiff>(`${base}/${sha}/file?path=${encodeURIComponent(path)}`),
    [base, sha],
  );

  if (list.data === undefined)
    return (
      <>
        {picker}
        <SectionState
          loading={list.isPending}
          error={list.error ?? undefined}
          onRetry={() => void list.refetch()}
          loadingText="Reading the history…"
          errorPrefix="Could not load the commits"
        />
      </>
    );
  if (commits.length === 0)
    return (
      <>
        {picker}
        <p className="muted">No commits yet.</p>
      </>
    );

  return (
    <>
      {picker}
      <div className="git-commits">
        <div className="git-commit-list">
          <ul>
            {commits.map((c) => (
              <li
                key={c.sha}
                className={`commit-row${c.byFactory ? ' commit-row--factory' : ''}${c.sha === sha ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="commit-row-main"
                  aria-current={c.sha === sha ? 'true' : undefined}
                  onClick={() => setPick({ branch: status.workingBranch, ref, sha: c.sha })}
                >
                  <span className="commit-subject">{c.subject}</span>
                  <span className="commit-meta">
                    {c.authorName} · {timeAgo(c.authoredAt)} · <code>{c.shortSha}</code>
                  </span>
                </button>
                <span className="commit-chips">
                  {c.ticketKey !== null && c.ticketId !== null && (
                    <Link className="chip" href={`/projects/${projectId}/board?ticket=${c.ticketId}`}>
                      {c.ticketKey}
                    </Link>
                  )}
                  {c.byFactory && <span className="chip">factory</span>}
                  {c.fromOrigin && <span className="chip">from origin</span>}
                  {c.labels.map((l) => (
                    <span key={`${l.kind}:${l.name}`} className={`chip chip-${l.kind}`}>
                      {l.name}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <button
              type="button"
              className="btn"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more
            </button>
          )}
        </div>
        <div className="git-commit-detail">
          {detail.data === undefined ? (
            <SectionState
              loading={detail.isPending}
              error={detail.error ?? undefined}
              onRetry={() => void detail.refetch()}
              loadingText="Reading the commit…"
              errorPrefix="Could not load the commit"
            />
          ) : (
            <>
              <pre className="git-commit-message">{detail.data.message}</pre>
              <GitDiffView files={detail.data.files} loadFile={loadFile} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

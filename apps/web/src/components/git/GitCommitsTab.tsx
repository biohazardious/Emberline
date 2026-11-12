import type { GitCommitDetail, GitCommitsPage, GitFileDiff, GitPageStatus } from '@emberline/protocol';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import { timeAgo } from '../../time';
import { SectionState } from '../SectionState';
import { GitDiffView } from './GitDiffView';

export function GitCommitsTab({ projectId, status }: { projectId: string; status: GitPageStatus }) {
  const base = `/api/projects/${projectId}/git/commits`;
  const [picked, setPicked] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['git', projectId, 'commits', status.workingBranch],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api<GitCommitsPage>(pageParam === null ? base : `${base}?cursor=${pageParam}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const commits = list.data?.pages.flatMap((p) => p.commits) ?? [];
  const sha = picked ?? commits[0]?.sha ?? null;

  const detail = useQuery({
    queryKey: ['git', projectId, 'commit', sha],
    queryFn: () => api<GitCommitDetail>(`${base}/${sha}`),
    enabled: sha !== null,
  });
  const loadFile = useCallback(
    (path: string) => api<GitFileDiff>(`${base}/${sha}/file?path=${encodeURIComponent(path)}`),
    [base, sha],
  );

  if (list.data === undefined)
    return (
      <SectionState
        loading={list.isPending}
        error={list.error ?? undefined}
        onRetry={() => void list.refetch()}
        loadingText="Reading the history…"
        errorPrefix="Could not load the commits"
      />
    );
  if (commits.length === 0) return <p className="muted">No commits yet.</p>;

  return (
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
                onClick={() => setPicked(c.sha)}
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
  );
}

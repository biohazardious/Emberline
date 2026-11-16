import type {
  ForgeIssueListItem,
  ForgeIssueListResponse,
  ImportIssuesResponse,
  Ticket,
} from '@emberline/protocol';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '../../api';
import {
  buildImportBody,
  describeImportResult,
  issueHref,
  issueListQuery,
  MAX_IMPORT,
  toggleIssue,
  visibleIssueKeys,
} from '../../issueImport';
import { timeAgo } from '../../time';

export type StateFilter = 'open' | 'closed' | 'all';

export function IssueImportTab({
  projectId,
  onImported,
}: {
  projectId: string;
  onImported?: (tickets: Ticket[]) => void;
}) {
  const client = useQueryClient();
  const [draftSearch, setDraftSearch] = useState('');
  const [draftLabels, setDraftLabels] = useState('');
  const [filters, setFilters] = useState<{ state: StateFilter; labels: string; search: string }>({
    state: 'open',
    labels: '',
    search: '',
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ForgeIssueListItem[]>([]);
  const [status, setStatus] = useState<'backlog' | 'ready'>('backlog');
  const [result, setResult] = useState<ImportIssuesResponse>();

  const listUrl = `/api/projects/${projectId}/issues?${issueListQuery({ ...filters, page })}`;
  const list = useQuery({
    queryKey: ['issues', projectId, listUrl],
    queryFn: () => api<ForgeIssueListResponse>(listUrl),
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const run = useMutation({
    mutationFn: () =>
      api<ImportIssuesResponse>(
        `/api/projects/${projectId}/issues/import`,
        'POST',
        buildImportBody(selected, status),
      ),
    onSuccess: (res) => {
      setResult(res);
      setSelected([]);
      void client.invalidateQueries({ queryKey: ['issues', projectId] });
      if (res.created.length) onImported?.(res.created);
    },
  });

  const items = list.data?.items ?? [];
  const selectable = visibleIssueKeys(items);
  const allOnPageSelected =
    selectable.length > 0 && selectable.every((id) => selected.some((s) => s.externalId === id));
  const toggleAll = () =>
    setSelected((cur) => {
      if (allOnPageSelected) return cur.filter((s) => !selectable.includes(s.externalId));
      let next = cur;
      for (const item of items)
        if (!next.some((s) => s.externalId === item.externalId)) next = toggleIssue(next, item);
      return next;
    });

  const applyFilters = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setFilters((f) => ({ ...f, search: draftSearch, labels: draftLabels }));
  };

  return (
    <div className="issue-tab">
      <form className="issue-filters" onSubmit={applyFilters} role="search">
        <input
          className="input"
          aria-label="Search issues"
          placeholder="Search title and text…"
          maxLength={200}
          value={draftSearch}
          onChange={(e) => setDraftSearch(e.target.value)}
        />
        <input
          className="input"
          aria-label="Filter by labels"
          placeholder="Labels (comma separated)"
          maxLength={500}
          value={draftLabels}
          onChange={(e) => setDraftLabels(e.target.value)}
        />
        <select
          className="input"
          aria-label="Issue state"
          value={filters.state}
          onChange={(e) => {
            setPage(1);
            setFilters((f) => ({ ...f, state: e.target.value as StateFilter }));
          }}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <button type="submit" className="btn btn-sm">
          Search
        </button>
      </form>

      {list.error && (
        <div className="banner banner-error" role="alert">
          {errorMessage(list.error)}
        </div>
      )}

      {list.isPending ? (
        <div className="empty" aria-busy="true">
          Loading issues…
        </div>
      ) : (
        !list.error && (
          <>
            <div className="issue-list-head">
              <label className="issue-check">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  disabled={selectable.length === 0}
                  onChange={toggleAll}
                />
                <span>Select page</span>
              </label>
              <span className="muted small">
                {selected.length} selected (max {MAX_IMPORT})
              </span>
            </div>
            {items.length === 0 ? (
              <div className="empty">
                <p>No issues match.</p>
              </div>
            ) : (
              <ul className="issue-list" aria-busy={list.isFetching}>
                {items.map((item) => {
                  const checked = selected.some((s) => s.externalId === item.externalId);
                  const atLimit = !checked && selected.length >= MAX_IMPORT;
                  return (
                    <li
                      key={item.externalId}
                      className={`issue-row${item.linkedTicketKey ? ' issue-linked' : ''}`}
                    >
                      <label className="issue-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!!item.linkedTicketKey || atLimit}
                          onChange={() => setSelected((cur) => toggleIssue(cur, item))}
                          aria-label={`Select #${item.number} ${item.title}`}
                        />
                      </label>
                      <div className="issue-main">
                        {issueHref(item.url) ? (
                          <a
                            href={issueHref(item.url)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="issue-title"
                          >
                            <span className="mono">#{item.number}</span> {item.title}
                          </a>
                        ) : (
                          <span className="issue-title">
                            <span className="mono">#{item.number}</span> {item.title}
                          </span>
                        )}
                        <div className="issue-meta">
                          {item.state === 'closed' && <span className="badge badge-soft">closed</span>}
                          {item.labels.map((l) => (
                            <span key={l} className="badge badge-soft issue-label">
                              {l}
                            </span>
                          ))}
                          <span className="muted small">
                            {item.author ?? 'unknown'} · {timeAgo(item.updatedAt)}
                          </span>
                        </div>
                      </div>
                      {item.linkedTicketKey && <span className="badge mono">{item.linkedTicketKey}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="issue-pager">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span className="muted small">Page {page}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={list.data?.nextPage == null || list.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )
      )}

      {run.error && (
        <div className="banner banner-error" role="alert">
          {errorMessage(run.error)}
        </div>
      )}
      {run.isPending && (
        <p className="muted small" role="status">
          Importing {selected.length} {selected.length === 1 ? 'issue' : 'issues'}…
        </p>
      )}
      {result && !run.isPending && (
        <div className="banner" role="status">
          <p>{describeImportResult(result)}</p>
          {result.created.length > 0 && (
            <p className="mono small">{result.created.map((t) => t.key).join(', ')}</p>
          )}
          {result.skipped.length > 0 && (
            <ul className="small">
              {result.skipped.map((s) => (
                <li key={s.externalId}>
                  {s.externalId}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <footer className="drawer-foot">
        <div className="segmented" role="radiogroup" aria-label="Import as">
          {(['backlog', 'ready'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              className={status === s ? 'active' : ''}
              onClick={() => setStatus(s)}
            >
              {s === 'backlog' ? 'Backlog' : 'Ready'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={selected.length === 0 || run.isPending}
          onClick={() => {
            setResult(undefined);
            run.mutate();
          }}
        >
          {run.isPending ? 'Importing…' : `Import${selected.length ? ` ${selected.length}` : ''}`}
        </button>
      </footer>
    </div>
  );
}

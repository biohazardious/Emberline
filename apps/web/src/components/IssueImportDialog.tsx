import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ForgeIssueListItem,
  ForgeIssueListResponse,
  ImportIssuesResponse,
  IssueSyncResponse,
  Ticket,
} from '@emberline/protocol';
import { X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import {
  buildImportBody,
  describeImportResult,
  issueListQuery,
  MAX_IMPORT,
  parseTrustedAuthors,
  syncSettingsProblem,
  toggleIssue,
  visibleIssueKeys,
} from '../issueImport';
import { timeAgo } from '../time';

type Tab = 'import' | 'sync';
type StateFilter = 'open' | 'closed' | 'all';

export function IssueImportDialog({
  projectId,
  projectName,
  onClose,
  onImported,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  /** Called with the tickets an import created, so the board shows them at once. */
  onImported?: (tickets: Ticket[]) => void;
}) {
  const [tab, setTab] = useState<Tab>('import');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide issue-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">{projectName} · Forge issues</p>
            <h2 id="issue-dialog-title" className="issue-dialog-title">
              Import issues
            </h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <div className="segmented" role="tablist" aria-label="Issue import">
          {(['import', 'sync'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'import' ? 'Import' : 'Sync'}
            </button>
          ))}
        </div>
        {tab === 'import' ? (
          <ImportTab projectId={projectId} onImported={onImported} />
        ) : (
          <SyncTab projectId={projectId} />
        )}
      </aside>
    </div>
  );
}

function ImportTab({ projectId, onImported }: { projectId: string; onImported?: (tickets: Ticket[]) => void }) {
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
    mutationFn: () => api<ImportIssuesResponse>(`/api/projects/${projectId}/issues/import`, 'POST', buildImportBody(selected, status)),
    onSuccess: (res) => {
      setResult(res);
      setSelected([]);
      void client.invalidateQueries({ queryKey: ['issues', projectId] });
      if (res.created.length) onImported?.(res.created);
    },
  });

  const items = list.data?.items ?? [];
  const selectable = visibleIssueKeys(items);
  const allOnPageSelected = selectable.length > 0 && selectable.every((id) => selected.some((s) => s.externalId === id));
  const toggleAll = () =>
    setSelected((cur) => {
      if (allOnPageSelected) return cur.filter((s) => !selectable.includes(s.externalId));
      let next = cur;
      for (const item of items) if (!next.some((s) => s.externalId === item.externalId)) next = toggleIssue(next, item);
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
                <input type="checkbox" checked={allOnPageSelected} disabled={selectable.length === 0} onChange={toggleAll} />
                <span>Select all on this page</span>
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
                    <li key={item.externalId} className={`issue-row${item.linkedTicketKey ? ' issue-linked' : ''}`}>
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
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="issue-title">
                          <span className="mono">#{item.number}</span> {item.title}
                        </a>
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
                      {item.linkedTicketKey && (
                        <span className="badge mono" title="Already imported as this ticket">
                          {item.linkedTicketKey}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="issue-pager">
              <button type="button" className="btn btn-sm btn-ghost" disabled={page <= 1 || list.isFetching} onClick={() => setPage((p) => p - 1)}>
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
          Importing {selected.length} {selected.length === 1 ? 'issue' : 'issues'}… this can take a while, as the forge is asked once per issue.
        </p>
      )}
      {result && !run.isPending && (
        <div className="banner" role="status">
          <p>{describeImportResult(result)}</p>
          {result.created.length > 0 && <p className="mono small">{result.created.map((t) => t.key).join(', ')}</p>}
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
              Import as {s === 'backlog' ? 'Backlog' : 'Ready'}
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

function SyncTab({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const url = `/api/projects/${projectId}/issue-sync`;
  const query = useQuery({ queryKey: ['issue-sync', projectId], queryFn: () => api<IssueSyncResponse>(url), retry: false });
  const [form, setForm] = useState<{
    enabled: boolean;
    label: string;
    status: 'backlog' | 'ready';
    trusted: string;
    closeOnDone: boolean;
    commentOnProgress: boolean;
  }>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const s = query.data;
    if (s && !form) {
      setForm({
        enabled: s.enabled,
        label: s.label,
        status: s.status,
        trusted: s.trustedAuthors.join('\n'),
        closeOnDone: s.closeOnDone,
        commentOnProgress: s.commentOnProgress,
      });
    }
  }, [query.data, form]);

  const save = useMutation({
    mutationFn: (f: NonNullable<typeof form>) =>
      api<IssueSyncResponse>(url, 'PATCH', {
        enabled: f.enabled,
        label: f.label.trim(),
        status: f.status,
        closeOnDone: f.closeOnDone,
        commentOnProgress: f.commentOnProgress,
        trustedAuthors: parseTrustedAuthors(f.trusted),
      }),
    onSuccess: (res) => {
      client.setQueryData(['issue-sync', projectId], res);
      setNotice('Saved.');
    },
  });
  const syncNow = useMutation({
    mutationFn: () => api<unknown>(`${url}/run`, 'POST'),
    onSuccess: () => setNotice('Sync finished.'),
    onSettled: () => void client.invalidateQueries({ queryKey: ['issue-sync', projectId] }),
  });

  if (query.error) {
    return (
      <div className="banner banner-error" role="alert">
        {errorMessage(query.error)}
      </div>
    );
  }
  if (!form || !query.data) {
    return (
      <div className="empty" aria-busy="true">
        Loading sync settings…
      </div>
    );
  }
  const problem = syncSettingsProblem(form);
  const st = query.data.syncStatus;
  const set = (patch: Partial<typeof form>) => {
    setNotice(undefined);
    setForm({ ...form, ...patch });
  };

  return (
    <form
      className="issue-tab issue-sync"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) save.mutate(form);
      }}
    >
      <p className="muted small">
        Every 10 minutes label sync looks at the most recently updated issues with the label, up to 200 (100 on Gitea's default limits). Use the Import tab for older ones.
      </p>
      <label className="issue-check">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>Sync issues with a label automatically</span>
      </label>
      <label className="field">
        <span className="drawer-label">Label (required when enabled)</span>
        <input className="input" value={form.label} maxLength={100} onChange={(e) => set({ label: e.target.value })} />
      </label>
      <label className="field">
        <span className="drawer-label">New issues land in</span>
        <select className="input" value={form.status} onChange={(e) => set({ status: e.target.value as 'backlog' | 'ready' })}>
          <option value="backlog">Backlog</option>
          <option value="ready">Ready</option>
        </select>
        <span className="muted small">Issues from authors not in Trusted authors always land in Backlog.</span>
      </label>
      <label className="field">
        <span className="drawer-label">Trusted authors (comma or one per line)</span>
        <textarea className="input" rows={3} value={form.trusted} onChange={(e) => set({ trusted: e.target.value })} />
      </label>
      <label className="issue-check">
        <input type="checkbox" checked={form.closeOnDone} onChange={(e) => set({ closeOnDone: e.target.checked })} />
        <span>Close the issue when its ticket is Done</span>
      </label>
      <label className="issue-check">
        <input type="checkbox" checked={form.commentOnProgress} onChange={(e) => set({ commentOnProgress: e.target.checked })} />
        <span>Comment on the issue when a PR is opened or the work is merged</span>
      </label>

      <dl className="issue-status">
        <dt>Last sync</dt>
        <dd>{st.lastSyncAt ? timeAgo(st.lastSyncAt) : 'not since the last restart'}</dd>
        {st.pausedUntil && (
          <>
            <dt>Paused until</dt>
            <dd>{new Date(st.pausedUntil).toLocaleTimeString()} (forge rate limit)</dd>
          </>
        )}
      </dl>
      {st.lastError && (
        <div className="banner banner-error" role="alert">
          Last sync failed: {st.lastError}
        </div>
      )}
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      {save.error && (
        <div className="banner banner-error" role="alert">
          {errorMessage(save.error)}
        </div>
      )}
      {syncNow.error && (
        <div className="banner banner-error" role="alert">
          {errorMessage(syncNow.error)}
        </div>
      )}
      {notice && (
        <p className="small" role="status">
          {notice}
        </p>
      )}
      <footer className="drawer-foot">
        <button
          type="button"
          className="btn btn-sm"
          disabled={syncNow.isPending || !query.data.enabled}
          title={query.data.enabled ? 'Look for labelled issues now' : 'Save with sync enabled first'}
          onClick={() => {
            setNotice(undefined);
            syncNow.mutate();
          }}
        >
          {syncNow.isPending ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending || !!problem}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </form>
  );
}

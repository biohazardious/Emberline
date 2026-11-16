import type { IssueSyncResponse, IssueSyncStatus } from '@emberline/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { describeSyncNow, parseTrustedAuthors, syncSettingsProblem } from '../../issueImport';
import { timeAgo } from '../../time';
import { HelpHint } from '../ui/HelpHint';

export function IssueSyncTab({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const url = `/api/projects/${projectId}/issue-sync`;
  const query = useQuery({
    queryKey: ['issue-sync', projectId],
    queryFn: () => api<IssueSyncResponse>(url),
    retry: false,
  });
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
    mutationFn: () => api<IssueSyncStatus>(`${url}/run`, 'POST'),
    onSuccess: (status) => {
      client.setQueryData<IssueSyncResponse>(['issue-sync', projectId], (old) =>
        old ? { ...old, syncStatus: status } : old,
      );
      const result = describeSyncNow(status);
      setNotice(result.error ? undefined : result.text);
    },
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
      <div className="issue-sync-help-row">
        <p className="muted issue-sync-help-text">Syncs labelled issues every 10 minutes.</p>
        <HelpHint topic="issue sync">
          Checks up to 200 recently updated labelled issues (or 100 on Gitea). Use the Import tab for older
          issues.
        </HelpHint>
      </div>
      <label className="issue-check">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>Sync labelled issues automatically</span>
      </label>
      <label className="field">
        <span className="drawer-label">Label</span>
        <input
          className="input"
          value={form.label}
          maxLength={100}
          onChange={(e) => set({ label: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="drawer-label">Target column</span>
        <select
          className="input"
          value={form.status}
          onChange={(e) => set({ status: e.target.value as 'backlog' | 'ready' })}
        >
          <option value="backlog">Backlog</option>
          <option value="ready">Ready</option>
        </select>
        <span className="muted small">Untrusted authors always land in Backlog.</span>
      </label>
      <label className="field">
        <span className="drawer-label">Trusted authors</span>
        <textarea
          className="input"
          rows={3}
          placeholder="One username per line or comma-separated"
          value={form.trusted}
          onChange={(e) => set({ trusted: e.target.value })}
        />
      </label>
      <label className="issue-check">
        <input
          type="checkbox"
          checked={form.closeOnDone}
          onChange={(e) => set({ closeOnDone: e.target.checked })}
        />
        <span>Close issue when ticket is Done</span>
      </label>
      <label className="issue-check">
        <input
          type="checkbox"
          checked={form.commentOnProgress}
          onChange={(e) => set({ commentOnProgress: e.target.checked })}
        />
        <span>Comment on issue when work merges</span>
      </label>

      <dl className="issue-status">
        <dt>Last sync</dt>
        <dd>{st.lastSyncAt ? timeAgo(st.lastSyncAt) : 'not since restart'}</dd>
        {st.pausedUntil && (
          <>
            <dt>Paused until</dt>
            <dd>{new Date(st.pausedUntil).toLocaleTimeString()} (rate limit)</dd>
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

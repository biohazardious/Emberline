import type {
  ToolchainActionResponse,
  UpdateItem,
  UpdateItemState,
  UpdatesResponse,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';

const STATE_LABELS: Record<UpdateItemState, string> = {
  up_to_date: 'Up to date',
  update_available: 'Update available',
  not_installed: 'Not installed',
  pinned: 'Pinned',
  bundled: 'Bundled',
  unknown: 'Unknown',
  error: 'Check failed',
};

const STATE_COLORS: Partial<Record<UpdateItemState, string>> = {
  up_to_date: 'var(--ok)',
  update_available: 'var(--warn)',
  error: 'var(--bad)',
};

const KIND_TITLES: Record<UpdateItem['kind'], string> = {
  emberline: 'Emberline',
  cli: 'Agent CLIs',
  mcp: 'MCP servers (npx)',
  bundled: 'Bundled with Emberline',
};

/**
 * Update tracking for Emberline, the agent CLIs and npx-run MCP servers. Emberline is only reported
 * with upgrade instructions: core cannot replace its own containers.
 */
export function UpdatesPanel() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const query = useApi<UpdatesResponse>('/api/updates', 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const data = query.data;

  const apply = (next: UpdatesResponse): void => {
    queryClient.setQueryData(['api', '/api/updates'], next);
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const checkNow = () =>
    act('check', async () => apply(await api<UpdatesResponse>('/api/updates/check', 'POST')));

  const setAutoCheck = (autoCheck: boolean) =>
    act('config', async () =>
      apply(await api<UpdatesResponse>('/api/updates/config', 'PATCH', { autoCheck })),
    );

  const saveToken = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    void act('token', async () => {
      apply(await api<UpdatesResponse>('/api/updates/config', 'PATCH', { githubToken: token.trim() }));
      setToken('');
      setNotice('GitHub token saved.');
    });
  };

  const clearToken = () =>
    act('token', async () => {
      apply(await api<UpdatesResponse>('/api/updates/config', 'PATCH', { githubToken: null }));
      setNotice('GitHub token removed.');
    });

  const updateCli = (item: UpdateItem) =>
    act(item.id, async () => {
      if (!item.provider) return;
      const res = await api<ToolchainActionResponse>(`/api/toolchain/${item.provider}/action`, 'POST', {
        action: 'update',
        spawnTerminal: true,
      });
      if (res.terminal) {
        setLocation(`/terminals/${res.terminal.id}`);
        return;
      }
      apply(await api<UpdatesResponse>('/api/updates/check', 'POST'));
      setNotice(`${item.name} updated${res.tool.version ? ` (${res.tool.version})` : ''}.`);
    });

  const refreshMcp = (item: UpdateItem) =>
    act(item.id, async () => {
      if (!item.mcpId) return;
      apply(await api<UpdatesResponse>(`/api/updates/mcp/${encodeURIComponent(item.mcpId)}/refresh`, 'POST'));
      setNotice(`${item.name}: the cached copy was removed; its next start downloads the latest version.`);
    });

  const status = data?.status;
  const groups = (['emberline', 'cli', 'mcp', 'bundled'] as const)
    .map((kind) => ({ kind, items: status?.items.filter((i) => i.kind === kind) ?? [] }))
    .filter((g) => g.items.length > 0);

  return (
    <section className="panel" aria-labelledby="updates-title">
      <header className="panel-head">
        <div>
          <h2 id="updates-title">Updates</h2>
          <p className="muted">
            Checks GitHub for Emberline releases, and npm / PyPI for the agent CLIs and the MCP servers run
            through npx.{' '}
            {status?.checkedAt
              ? `Last checked ${new Date(status.checkedAt).toLocaleString()}.`
              : 'Not checked yet.'}
          </p>
        </div>
        <div className="actions">
          {status && status.available > 0 && (
            <span className="badge badge-warn">{status.available} available</span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== null}
            onClick={() => void checkNow()}
          >
            {busy === 'check' ? (
              <LoaderCircle className="icon icon-spin" aria-hidden />
            ) : (
              <RefreshCw className="icon" aria-hidden />
            )}{' '}
            Check now
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-ok">{notice}</div>}

      <div className="form" style={{ marginBottom: '1rem' }}>
        <div className="form-row">
          <label className="review-checkbox-label">
            <input
              type="checkbox"
              checked={data?.config.autoCheck ?? true}
              disabled={!data || busy !== null}
              onChange={(e) => void setAutoCheck(e.target.checked)}
            />
            Check automatically every 12 hours
          </label>
        </div>
        <form className="form-row" onSubmit={saveToken}>
          <input
            type="password"
            autoComplete="new-password"
            className="input"
            aria-label="GitHub token"
            placeholder={
              data?.config.tokenConfigured
                ? 'GitHub token set (leave blank to keep)'
                : 'Optional GitHub token (needed while the repository is private)'
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ maxWidth: '380px' }}
          />
          <button type="submit" className="btn btn-sm" disabled={busy !== null || !token.trim()}>
            Save token
          </button>
          {data?.config.tokenConfigured && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy !== null}
              onClick={() => void clearToken()}
            >
              Remove token
            </button>
          )}
        </form>
        <p className="muted small" style={{ margin: 0 }}>
          The token is only sent to api.github.com. A fine-grained token with read access to the
          repository&apos;s contents is enough.
        </p>
      </div>

      {status?.release && (
        <div className="panel update-release">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <strong>
              Emberline {status.release.version} is available (running {status.currentVersion})
            </strong>
            <a className="btn btn-xs btn-ghost" href={status.release.url} target="_blank" rel="noreferrer">
              <ExternalLink className="icon" aria-hidden /> Release page
            </a>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Upgrade on the Docker host. Core restarts; the runner restarts too when its image or settings
            change, which stops running agents, so upgrade when they are idle.
          </p>
          <pre className="update-commands mono">
            {`# published images: download this release's deploy/compose.yaml first (then redo your own edits to it)\ncp compose.yaml compose.yaml.bak\ncurl -fsSLO https://raw.githubusercontent.com/biohazardious/Emberline/v${status.release.version}/deploy/compose.yaml\ndocker compose pull && docker compose up -d\n\n# from a git checkout\ngit pull && make up`}
          </pre>
          {status.release.notes.trim() && (
            <details>
              <summary className="small">Release notes</summary>
              <pre className="update-notes">{status.release.notes.trim()}</pre>
            </details>
          )}
        </div>
      )}

      {!status?.checkedAt && !query.loading && (
        <p className="muted small">
          Press “Check now” to compare the installed versions with the latest releases.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.kind} className="update-group">
          <span className="eyebrow">{KIND_TITLES[group.kind]}</span>
          <div className="update-list">
            {group.items.map((item) => (
              <div key={item.id} className="update-row">
                <div className="update-name">
                  <strong>{item.name}</strong>
                  {item.note && <span className="muted small">{item.note}</span>}
                </div>
                <span className="mono small update-versions">
                  {item.installed ?? '—'}
                  {item.latest && item.latest !== item.installed ? ` → ${item.latest}` : ''}
                </span>
                <span className="badge" style={{ color: STATE_COLORS[item.state] ?? 'var(--muted)' }}>
                  {STATE_LABELS[item.state]}
                </span>
                <div className="update-action">
                  {item.kind === 'cli' &&
                    item.provider &&
                    (item.state === 'update_available' || item.state === 'unknown') && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        disabled={busy !== null}
                        onClick={() => void updateCli(item)}
                      >
                        {busy === item.id ? (
                          <LoaderCircle className="icon icon-spin" aria-hidden />
                        ) : (
                          <RotateCw className="icon" aria-hidden />
                        )}{' '}
                        Update
                      </button>
                    )}
                  {item.kind === 'mcp' && item.state === 'update_available' && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      disabled={busy !== null}
                      title="Removes the cached copy; the next start downloads the latest version"
                      onClick={() => void refreshMcp(item)}
                    >
                      {busy === item.id ? (
                        <LoaderCircle className="icon icon-spin" aria-hidden />
                      ) : (
                        <RotateCw className="icon" aria-hidden />
                      )}{' '}
                      Refresh
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

import type { CreateProjectResponse, Project, SystemStatus, TerminalInfo } from '@emberline/protocol';
import { type FormEvent, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { usePoll } from '../hooks/usePoll';

const KIND_LABEL: Record<TerminalInfo['kind'], string> = {
  shell: 'shell',
  claude: 'claude',
  clone: 'git clone',
  agent: 'agent',
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function Dashboard({ system }: { system: SystemStatus | undefined }) {
  const [, navigate] = useLocation();
  const terminals = usePoll(() => api<TerminalInfo[]>('/api/terminals'), 3_000);
  const projects = usePoll(() => api<Project[]>('/api/projects'), 10_000);
  const [actionError, setActionError] = useState<string>();
  const runnerDown = system?.ptyd !== 'connected';

  const openTerminal = async (kind: 'shell' | 'claude', projectId?: string) => {
    setActionError(undefined);
    try {
      const terminal = await api<TerminalInfo>('/api/terminals', 'POST', { kind, projectId });
      navigate(`/terminals/${terminal.id}`);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const removeTerminal = async (id: string) => {
    try {
      await api(`/api/terminals/${id}`, 'DELETE');
      await terminals.refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;

  return (
    <div className="dashboard">
      {runnerDown && (
        <div className="banner banner-warn" role="status">
          Runner (ptyd) is {system?.ptyd ?? 'unknown'} — terminals are unavailable until it reconnects.
        </div>
      )}
      {actionError && (
        <div className="banner banner-error" role="alert">
          {actionError}
        </div>
      )}

      <section className="panel" aria-labelledby="terminals-title">
        <header className="panel-head">
          <div>
            <h2 id="terminals-title">Terminals</h2>
            <p className="muted">Sessions live in the runner and survive reloads and core restarts.</p>
          </div>
          <div className="actions">
            <button id="new-shell" className="btn" disabled={runnerDown} onClick={() => void openTerminal('shell')}>
              New shell
            </button>
            <button
              id="new-claude"
              className="btn btn-primary"
              disabled={runnerDown}
              onClick={() => void openTerminal('claude')}
              title="Starts Claude Code; on first run it walks you through logging in with your subscription"
            >
              Claude
            </button>
          </div>
        </header>

        {terminals.data?.length === 0 && (
          <div className="empty">
            <p>No terminals yet.</p>
            <p className="muted">
              First time here? Open <strong>Claude</strong> and log in with your own subscription.
            </p>
          </div>
        )}
        <ul className="list">
          {terminals.data?.map((t) => (
            <li key={t.id} className="row">
              <Link href={`/terminals/${t.id}`} className="row-main">
                <span className={`dot dot-${t.status}`} aria-label={t.status} />
                <span className="row-title">{t.title}</span>
                <span className="badge">{KIND_LABEL[t.kind]}</span>
                {t.projectId && <span className="badge badge-soft">{projectName(t.projectId) ?? 'project'}</span>}
                <span className="row-meta">
                  {t.status === 'exited' ? `exited${t.exitCode !== null ? ` (${t.exitCode})` : ''} · ` : ''}
                  {timeAgo(t.createdAt)}
                </span>
              </Link>
              <button
                className="icon-btn"
                aria-label={`Close ${t.title}`}
                title={t.status === 'running' ? 'Kill and remove' : 'Remove'}
                onClick={() => void removeTerminal(t.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="projects-title">
        <header className="panel-head">
          <div>
            <h2 id="projects-title">Projects</h2>
            <p className="muted">Repositories in the shared workspaces volume.</p>
          </div>
        </header>
        <ul className="list">
          {projects.data?.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <span className="row-title">{p.name}</span>
                <span className="row-meta mono">{p.repoUrl ?? p.path}</span>
              </div>
              <div className="actions">
                <button className="btn btn-sm" disabled={runnerDown} onClick={() => void openTerminal('shell', p.id)}>
                  Shell
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={runnerDown}
                  onClick={() => void openTerminal('claude', p.id)}
                >
                  Claude
                </button>
              </div>
            </li>
          ))}
        </ul>
        <NewProjectForm
          disabled={runnerDown}
          onCreated={async (res) => {
            await projects.refresh();
            if (res.terminalId) navigate(`/terminals/${res.terminalId}`);
          }}
        />
      </section>
    </div>
  );
}

function NewProjectForm({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (res: CreateProjectResponse) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', { name, repoUrl });
      setName('');
      setRepoUrl('');
      await onCreated(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <input
        id="project-name"
        className="input"
        placeholder="Project name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        id="project-repo"
        className="input grow"
        placeholder="Repository URL (optional) — https://… or git@…"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
      />
      <button id="project-create" className="btn btn-primary" disabled={busy || (disabled && !!repoUrl)}>
        {busy ? 'Adding…' : repoUrl ? 'Clone' : 'Add'}
      </button>
      {error && <p className="form-error full">{error}</p>}
    </form>
  );
}

import type {
  CreateProjectResponse,
  PermissionMode,
  Project,
  Run,
  SystemStatus,
  TerminalInfo,
} from '@emberline/protocol';
import { type FormEvent, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { RunStatePill } from '../components/RunStatePill';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';

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
  const { runs } = useRuns();
  const [actionError, setActionError] = useState<string>();
  const [runFormFor, setRunFormFor] = useState<string>();
  const runnerDown = system?.ptyd !== 'connected';
  const plainTerminals = terminals.data?.filter((t) => t.kind !== 'agent');

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

  const runAction = async (id: string, action: 'stop' | 'remove') => {
    setActionError(undefined);
    try {
      if (action === 'stop') await api(`/api/runs/${id}/stop`, 'POST');
      else await api(`/api/runs/${id}`, 'DELETE');
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

      <section className="panel" aria-labelledby="runs-title">
        <header className="panel-head">
          <div>
            <h2 id="runs-title">Runs</h2>
            <p className="muted">Claude sessions on their own branch and worktree. State comes live from hooks.</p>
          </div>
        </header>
        {runs?.length === 0 && (
          <div className="empty">
            <p>No runs yet.</p>
            <p className="muted">
              Pick a project below and press <strong>Start run</strong>.
            </p>
          </div>
        )}
        <ul className="list">
          {runs?.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              projectName={projectName(run.projectId)}
              onStop={() => void runAction(run.id, 'stop')}
              onRemove={() => void runAction(run.id, 'remove')}
            />
          ))}
        </ul>
      </section>
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

        {plainTerminals?.length === 0 && (
          <div className="empty">
            <p>No terminals yet.</p>
            <p className="muted">
              First time here? Open <strong>Claude</strong> and log in with your own subscription.
            </p>
          </div>
        )}
        <ul className="list">
          {plainTerminals?.map((t) => (
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
            <li key={p.id} className="row row-wrap">
              <div className="row-main">
                <span className="row-title">{p.name}</span>
                <span className="row-meta mono">{p.repoUrl ?? p.path}</span>
              </div>
              <div className="actions">
                <button className="btn btn-sm" disabled={runnerDown} onClick={() => void openTerminal('shell', p.id)}>
                  Shell
                </button>
                <button
                  id={`start-run-${p.slug}`}
                  className="btn btn-sm btn-primary"
                  disabled={runnerDown}
                  aria-expanded={runFormFor === p.id}
                  onClick={() => setRunFormFor(runFormFor === p.id ? undefined : p.id)}
                >
                  Start run
                </button>
              </div>
              {runFormFor === p.id && (
                <StartRunForm
                  project={p}
                  onCancel={() => setRunFormFor(undefined)}
                  onStarted={(run) => {
                    setRunFormFor(undefined);
                    if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
                  }}
                />
              )}
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

function RunRow({
  run,
  projectName,
  onStop,
  onRemove,
}: {
  run: Run;
  projectName: string | undefined;
  onStop: () => void;
  onRemove: () => void;
}) {
  const body = (
    <>
      <RunStatePill state={run.state} />
      <span className="row-title">{projectName ?? 'project'}</span>
      {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
      <span className="row-prompt">{run.prompt || <em className="muted">interactive</em>}</span>
      <span className="row-meta">
        {run.lastEvent ? `${run.lastEvent} · ` : ''}
        {timeAgo(run.stateChangedAt)}
      </span>
    </>
  );
  return (
    <li className={`row run-row run-row-${run.state}`}>
      {run.terminalId ? (
        <Link href={`/terminals/${run.terminalId}`} className="row-main">
          {body}
        </Link>
      ) : (
        <div className="row-main">{body}</div>
      )}
      {!run.endedAt && (
        <button className="btn btn-sm btn-ghost" onClick={onStop} title="Terminate the agent process">
          Stop
        </button>
      )}
      <button
        className="icon-btn"
        aria-label="Remove run"
        title="Remove run (the worktree and branch are kept)"
        onClick={onRemove}
      >
        ×
      </button>
    </li>
  );
}

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Claude asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits auto-approved; commands still ask' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only planning, no changes' },
  { value: 'bypassPermissions', label: 'Unattended', hint: 'No prompts at all, only inside the isolated runner' },
];

function StartRunForm({
  project,
  onStarted,
  onCancel,
}: {
  project: Project;
  onStarted: (run: Run) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onStarted(await api<Run>('/api/runs', 'POST', { projectId: project.id, prompt, permissionMode: mode }));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <form className="run-form" onSubmit={(e) => void submit(e)}>
      <textarea
        id="run-prompt"
        className="input"
        rows={3}
        autoFocus
        placeholder={`What should Claude do in ${project.name}? (optional, leave empty for an interactive session)`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <div className="run-form-foot">
        <div className="segmented" role="radiogroup" aria-label="Permission mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={mode === m.value ? 'active' : ''}
              title={m.hint}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button id="run-start" className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
      <p className="muted small">{MODES.find((m) => m.value === mode)?.hint}. Runs on a new branch in its own worktree.</p>
      {error && <p className="form-error">{error}</p>}
    </form>
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

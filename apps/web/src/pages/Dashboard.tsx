import type {
  AgentId,
  AgentPersona,
  CreateProjectResponse,
  PermissionMode,
  Project,
  Run,
  SystemStatus,
  TerminalInfo,
} from '@emberline/protocol';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { BlueprintModal } from '../components/BlueprintModal';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { modeHint, PermissionModePicker } from '../components/PermissionModePicker';
import { PersonaBadge, PersonaPicker, TaskTemplateBar } from '../components/PersonaBadge';
import { ProjectAdvisorPanel } from '../components/ProjectAdvisorPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { RunStatePill } from '../components/RunStatePill';
import { ScheduledJobsPanel } from '../components/ScheduledJobsPanel';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';
import { timeAgo } from '../time';

const KIND_LABEL: Record<TerminalInfo['kind'], string> = {
  shell: 'shell',
  claude: 'claude',
  clone: 'git clone',
  agent: 'agent',
};

export function Dashboard({
  system,
  activeProjectId,
  onSelectProject,
  onOpenWizard,
  onInspectRun,
}: {
  system: SystemStatus | undefined;
  activeProjectId?: string | null;
  onSelectProject?: (id: string | null) => void;
  onOpenWizard?: () => void;
  onInspectRun?: (runId: string) => void;
}) {
  const [, navigate] = useLocation();
  const terminals = usePoll(() => api<TerminalInfo[]>('/api/terminals'), 3_000);
  const projects = usePoll(() => api<Project[]>('/api/projects'), 10_000);
  const { runs } = useRuns();
  const [actionError, setActionError] = useState<string>();
  const [runFormFor, setRunFormFor] = useState<string>();
  const [runFormPersona, setRunFormPersona] = useState<AgentPersona>('coder');
  const [runFormPrompt, setRunFormPrompt] = useState<string>('');
  const [blueprintFor, setBlueprintFor] = useState<Project>();

  const runnerDown = system?.ptyd !== 'connected';
  const activeProject = useMemo(
    () => (activeProjectId ? projects.data?.find((p) => p.id === activeProjectId) : undefined) ?? projects.data?.[0],
    [activeProjectId, projects.data],
  );

  const visibleProjects = useMemo(
    () => (activeProject ? [activeProject] : (projects.data ?? [])),
    [activeProject, projects.data],
  );

  const plainTerminals = useMemo(() => {
    const list = terminals.data?.filter((t) => t.kind !== 'agent') ?? [];
    if (activeProject) {
      return list.filter((t) => !t.projectId || t.projectId === activeProject.id);
    }
    return list;
  }, [terminals.data, activeProject]);

  const visibleRuns = useMemo(() => {
    const list = runs ?? [];
    if (activeProject) {
      return list.filter((r) => r.projectId === activeProject.id);
    }
    return list;
  }, [runs, activeProject]);

  const stats = useMemo(() => {
    const all = visibleRuns;
    return {
      working: all.filter((r) => r.state === 'starting' || r.state === 'working').length,
      attention: all.filter((r) => r.state === 'waiting_input').length,
      queuedOrPaused: all.filter((r) => r.state === 'queued' || r.state === 'rate_limited').length,
      completed: all.filter((r) => r.state === 'done').length,
    };
  }, [visibleRuns]);

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

  const runAction = async (id: string, action: 'stop' | 'remove' | 'resume' | 'prune') => {
    setActionError(undefined);
    try {
      if (action === 'stop') await api(`/api/runs/${id}/stop`, 'POST');
      else if (action === 'resume') await api(`/api/runs/${id}/resume`, 'POST', {});
      else if (action === 'prune') await api(`/api/runs/${id}/worktree/prune`, 'POST', {});
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

      <div className="stat-strip" aria-label="Fleet telemetry">
        <div className="stat-card">
          <span className="stat-label">Active Agents</span>
          <strong className="stat-value mono">{stats.working}</strong>
        </div>
        <div className={`stat-card${stats.attention > 0 ? ' stat-card-warn' : ''}`}>
          <span className="stat-label">Needs Your Input</span>
          <strong className="stat-value mono">{stats.attention}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Queued / Paused</span>
          <strong className="stat-value mono">{stats.queuedOrPaused}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Completed Runs</span>
          <strong className="stat-value mono">{stats.completed}</strong>
        </div>
      </div>

      {activeProject && (
        <ProjectAdvisorPanel
          key={activeProject.id}
          project={activeProject}
          runnerDown={runnerDown}
          onOpenBlueprint={() => setBlueprintFor(activeProject)}
          onStartPersonaRun={(persona, defaultPrompt) => {
            setRunFormPersona(persona);
            setRunFormPrompt(defaultPrompt ?? '');
            setRunFormFor(activeProject.id);
          }}
          onRunStarted={(run) => {
            if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
            else onInspectRun?.(run.id);
          }}
        />
      )}

      <QuotaPanel />
      <NotificationsPanel />
      <ScheduledJobsPanel projects={visibleProjects} />

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="projects-title">
          <header className="panel-head">
            <div>
              <h2 id="projects-title">{activeProject ? 'Workspace Controls' : 'Projects'}</h2>
              <p className="muted">
                {activeProject
                  ? `Repository path and quick actions for ${activeProject.name}.`
                  : 'Create your first project to start the AI Coding Factory.'}
              </p>
            </div>
            {onOpenWizard && (
              <div className="actions">
                <button
                  id="open-project-wizard"
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={onOpenWizard}
                >
                  + AI Factory Wizard
                </button>
              </div>
            )}
          </header>
          <ul className="list">
            {visibleProjects.map((p) => (
              <li key={p.id} className="row row-wrap">
                <div className="row-main">
                  <span className="row-title">{p.name}</span>
                  {p.appType && p.appType !== 'custom' && (
                    <span className="badge badge-soft">{p.appType.replace('_', ' ')}</span>
                  )}
                  <span className="row-meta mono">{p.repoUrl ?? p.path}</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setBlueprintFor(p)}
                    title="Open PROJECT.md Blueprint"
                  >
                    PROJECT.md
                  </button>
                  <Link id={`board-${p.slug}`} href={`/projects/${p.id}/board`} className="btn btn-sm">
                    Board
                  </Link>
                  <button className="btn btn-sm" disabled={runnerDown} onClick={() => void openTerminal('shell', p.id)}>
                    Shell
                  </button>
                  <button
                    id={`start-run-${p.slug}`}
                    className="btn btn-sm btn-primary"
                    disabled={runnerDown}
                    aria-expanded={runFormFor === p.id}
                    onClick={() => {
                      setRunFormPersona('coder');
                      setRunFormPrompt('');
                      setRunFormFor(runFormFor === p.id ? undefined : p.id);
                    }}
                  >
                    Start run
                  </button>
                </div>
                {runFormFor === p.id && (
                  <StartRunForm
                    key={`${p.id}-${runFormPersona}-${runFormPrompt.slice(0, 16)}`}
                    project={p}
                    initialPersona={runFormPersona}
                    initialPrompt={runFormPrompt}
                    onCancel={() => setRunFormFor(undefined)}
                    onStarted={(run) => {
                      setRunFormFor(undefined);
                      if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
                      else onInspectRun?.(run.id);
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
              onSelectProject?.(res.project.id);
              if (res.terminalId) navigate(`/terminals/${res.terminalId}`);
            }}
          />
        </section>

        <section className="panel" aria-labelledby="terminals-title">
          <header className="panel-head">
            <div>
              <h2 id="terminals-title">Terminals</h2>
              <p className="muted">Sessions live in the runner and survive reloads and core restarts.</p>
            </div>
            <div className="actions">
              <button
                id="new-shell"
                className="btn btn-sm"
                disabled={runnerDown}
                onClick={() => void openTerminal('shell', activeProject?.id)}
              >
                New shell
              </button>
              <button
                id="new-claude"
                className="btn btn-sm btn-primary"
                disabled={runnerDown}
                onClick={() => void openTerminal('claude', activeProject?.id)}
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
                  <span className="row-meta mono">
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
      </div>

      <section className="panel" aria-labelledby="runs-title">
        <header className="panel-head">
          <div>
            <h2 id="runs-title">Runs</h2>
            <p className="muted">Claude sessions on their own branch and worktree. State comes live from hooks.</p>
          </div>
          <div className="actions">
            <Link href="/fleet" className="btn btn-sm">
              Open Fleet Multiplexer →
            </Link>
          </div>
        </header>
        {visibleRuns.length === 0 && (
          <div className="empty">
            <p>No runs yet.</p>
            <p className="muted">
              Pick a project above and press <strong>Start run</strong>, or dispatch a ticket from its{' '}
              <strong>Board</strong>.
            </p>
          </div>
        )}
        <ul className="list">
          {visibleRuns.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              projectName={projectName(run.projectId)}
              onInspect={onInspectRun ? () => onInspectRun(run.id) : undefined}
              onStop={() => void runAction(run.id, 'stop')}
              onResume={() => void runAction(run.id, 'resume')}
              onPrune={() => void runAction(run.id, 'prune')}
              onRemove={() => void runAction(run.id, 'remove')}
            />
          ))}
        </ul>
      </section>

      {blueprintFor && (
        <BlueprintModal
          project={blueprintFor}
          open={Boolean(blueprintFor)}
          onClose={() => setBlueprintFor(undefined)}
          onRunStarted={(run) => {
            if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
            else onInspectRun?.(run.id);
          }}
        />
      )}
    </div>
  );
}

function RunRow({
  run,
  projectName,
  onInspect,
  onStop,
  onResume,
  onPrune,
  onRemove,
}: {
  run: Run;
  projectName: string | undefined;
  onInspect: (() => void) | undefined;
  onStop: () => void;
  onResume: () => void;
  onPrune: () => void;
  onRemove: () => void;
}) {
  const ticketKey = run.title?.split(' ')[0];
  const canPrune =
    Boolean(run.endedAt) &&
    run.worktreePath.includes('/.worktrees/') &&
    run.lastEvent !== 'worktree_pruned';
  const body = (
    <>
      <RunStatePill state={run.state} />
      <PersonaBadge persona={run.persona} />
      <span className="row-title">{run.title ?? projectName ?? 'project'}</span>
      {run.title && projectName && <span className="badge">{projectName}</span>}
      {!run.title && run.ticketId && <span className="badge">{ticketKey ?? 'ticket'}</span>}
      {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
      <span className="row-prompt">{run.prompt || <em className="muted">interactive</em>}</span>
      <span className="row-meta mono">
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
        <div className="row-main" onClick={onInspect} style={onInspect ? { cursor: 'pointer' } : undefined}>
          {body}
        </div>
      )}
      {run.worktreePath && (
        <Link
          href={`/runs/${run.id}/review`}
          className="btn btn-sm btn-ghost"
          title="Inspect git diff, add line comments, commit or push branch"
        >
          Review
        </Link>
      )}
      {onInspect && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onInspect}
          title="Dock live terminal and hook event timeline"
        >
          Inspect
        </button>
      )}
      {(run.state === 'rate_limited' || run.resumable) && (
        <button
          className="btn btn-sm"
          onClick={onResume}
          title={
            run.state === 'rate_limited'
              ? 'Try now instead of waiting for the reset'
              : 'Continue this Claude session (claude --resume)'
          }
        >
          Resume
        </button>
      )}
      {canPrune && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onPrune}
          title="Delete linked git worktree directory on disk to reclaim space (keeps branch & run record)"
        >
          Prune worktree
        </button>
      )}
      {!run.endedAt && (
        <button
          className="btn btn-sm btn-ghost"
          onClick={onStop}
          title={run.state === 'queued' ? 'Remove from the queue' : 'Terminate the agent process'}
        >
          {run.state === 'queued' ? 'Cancel' : 'Stop'}
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

function StartRunForm({
  project,
  initialPersona = 'coder',
  initialPrompt = '',
  onStarted,
  onCancel,
}: {
  project: Project;
  initialPersona?: AgentPersona;
  initialPrompt?: string;
  onStarted: (run: Run) => void;
  onCancel: () => void;
}) {
  const [agent, setAgent] = useState<AgentId>('claude');
  const [persona, setPersona] = useState<AgentPersona>(initialPersona);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onStarted(
        await api<Run>('/api/runs', 'POST', {
          projectId: project.id,
          agent,
          persona,
          prompt,
          permissionMode: mode,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <form className="run-form" onSubmit={(e) => void submit(e)}>
      <TaskTemplateBar
        onSelect={(tpl) => {
          setPersona(tpl.persona);
          setMode(tpl.permissionMode);
          setPrompt(tpl.promptTemplate);
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="muted small mono">Specialist Persona:</span>
        <PersonaPicker value={persona} onChange={setPersona} />
      </div>
      <textarea
        id="run-prompt"
        className="input"
        rows={3}
        autoFocus
        placeholder={`What should ${agent === 'codex' ? 'Codex' : agent === 'aider' ? 'Aider' : 'Claude'} do in ${project.name}? (optional, leave empty for an interactive session)`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <div className="run-form-foot" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <div className="segmented" role="radiogroup" aria-label="CLI Agent">
          {(['claude', 'codex', 'aider'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={agent === a}
              className={agent === a ? 'active' : ''}
              onClick={() => setAgent(a)}
            >
              {a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'Aider'}
            </button>
          ))}
        </div>
        <PermissionModePicker value={mode} onChange={setMode} />
        <div className="actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button id="run-start" className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
      <p className="muted small">{modeHint(mode)}. Runs on a new branch in its own worktree.</p>
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

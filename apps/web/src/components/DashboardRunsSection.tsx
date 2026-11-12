import type { AgentId, AgentModelId, AgentPersona, PermissionMode, Project, Run } from '@emberline/protocol';
import { X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { MODEL_LABELS } from '../pages/RoadmapPage';
import {
  countDashboardRunCategories,
  DASHBOARD_CATEGORY_LABELS,
  DASHBOARD_RUN_CATEGORIES,
  type DashboardRunCategory,
  filterDashboardRuns,
} from '../runFilter';
import { timeAgo } from '../time';
import { SearchInput } from './BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from './ErrorBoundary';
import { modeHint, PermissionModePicker } from './PermissionModePicker';
import { PersonaBadge, PersonaPicker, TaskTemplateBar } from './PersonaBadge';
import { RunStatePill } from './RunStatePill';

export function DashboardRunsSection({
  runs,
  runsLoading,
  runsError,
  onRetryRuns,
  category,
  onCategoryChange,
  query,
  onQueryChange,
  projectName,
  onInspectRun,
  onRunAction,
}: {
  runs: readonly Run[];
  runsLoading: boolean;
  runsError: unknown;
  onRetryRuns: () => Promise<void>;
  category: DashboardRunCategory;
  onCategoryChange: (next: DashboardRunCategory) => void;
  query: string;
  onQueryChange: (next: string) => void;
  projectName: (projectId: string | null) => string | undefined;
  onInspectRun: ((runId: string) => void) | undefined;
  onRunAction: (id: string, action: 'stop' | 'remove' | 'resume' | 'prune') => void;
}) {
  const counts = useMemo(() => countDashboardRunCategories(runs), [runs]);
  const filteredRuns = useMemo(
    () => filterDashboardRuns(runs, { category, query }, projectName),
    [runs, category, query, projectName],
  );
  const filterActive = category !== 'all' || query.trim() !== '';

  return (
    <section className="panel" aria-labelledby="runs-title">
      <header className="panel-head">
        <div>
          <h2 id="runs-title">
            Runs{' '}
            <span className="mono muted">
              ({filterActive ? `${filteredRuns.length}/${runs.length}` : runs.length})
            </span>
          </h2>
          <p className="muted">
            Agent sessions on their own branch and worktree. State comes live from hooks.
          </p>
        </div>
        <div className="actions">
          <Link href="/fleet" className="btn btn-sm">
            Open Fleet Multiplexer →
          </Link>
        </div>
      </header>

      {(runs.length > 0 || filterActive) && (
        <div className="run-filter-bar" role="search" aria-label="Filter runs">
          <SearchInput
            id="dashboard-run-search"
            className="run-search"
            ariaLabel="Search runs"
            placeholder="Filter by ticket, prompt, branch, provider…"
            value={query}
            onChange={onQueryChange}
          />
          <div className="board-filter-group" role="group" aria-label="Filter runs by status">
            {DASHBOARD_RUN_CATEGORIES.map((cat) => {
              const count = counts[cat];
              if (cat !== 'all' && cat !== 'live' && count === 0 && category !== cat) return null;
              const pressed = category === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`chip-btn${pressed ? ' active' : ''}`}
                  aria-pressed={pressed}
                  onClick={() => onCategoryChange(pressed && cat !== 'all' ? 'all' : cat)}
                >
                  {DASHBOARD_CATEGORY_LABELS[cat]}
                  <span className="board-filter-count mono">{count}</span>
                </button>
              );
            })}
          </div>
          {filterActive && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => {
                onCategoryChange('all');
                onQueryChange('');
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {Boolean(runsError) && runs.length === 0 && (
        <ViewErrorBanner compact label="Could not load runs" error={runsError} onRetry={onRetryRuns} />
      )}
      {runsLoading && runs.length === 0 && !runsError ? (
        <ViewLoadingState compact label="Loading agent runs…" />
      ) : filteredRuns.length === 0 ? (
        <div className="empty">
          <p>{filterActive ? 'No runs match the active filter.' : 'No runs yet.'}</p>
          {filterActive ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onCategoryChange('all');
                onQueryChange('');
              }}
            >
              Show all runs
            </button>
          ) : (
            <p className="muted">
              Pick a project above and press <strong>Start run</strong>, or dispatch a ticket from its{' '}
              <strong>Board</strong>.
            </p>
          )}
        </div>
      ) : (
        <ul className="list">
          {filteredRuns.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              projectName={projectName(run.projectId)}
              onInspect={onInspectRun ? () => onInspectRun(run.id) : undefined}
              onStop={() => onRunAction(run.id, 'stop')}
              onResume={() => onRunAction(run.id, 'resume')}
              onPrune={() => onRunAction(run.id, 'prune')}
              onRemove={() => onRunAction(run.id, 'remove')}
            />
          ))}
        </ul>
      )}
    </section>
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
    Boolean(run.endedAt) && run.worktreePath.includes('/.worktrees/') && run.lastEvent !== 'worktree_pruned';
  const body = (
    <>
      <RunStatePill
        state={run.state}
        cancelled={run.cancelled}
        autoRetry={run.autoRetry}
        handedOffTo={run.handedOffTo}
      />
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
              ? run.autoRetry
                ? 'Retry now instead of waiting'
                : 'Try now instead of waiting for the reset'
              : `Continue this ${run.agent ?? 'agent'} session`
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
        <X className="icon" aria-hidden />
      </button>
    </li>
  );
}

export function StartRunForm({
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
  const [model, setModel] = useState<AgentModelId>('auto');
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
          model,
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
        placeholder={`What should ${agent === 'antigravity' ? 'Antigravity' : agent === 'copilot' ? 'Copilot' : agent === 'codex' ? 'Codex' : agent === 'aider' ? 'Aider' : 'Claude'} do in ${project.name}? (optional, leave empty for an interactive session)`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <div className="run-form-foot" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <div className="segmented" role="radiogroup" aria-label="CLI Agent">
          {(['claude', 'antigravity', 'copilot', 'codex', 'aider'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={agent === a}
              className={agent === a ? 'active' : ''}
              onClick={() => {
                setAgent(a);
                if (a === 'antigravity' && model === 'auto') setModel('argon');
              }}
            >
              {a === 'claude'
                ? 'Claude'
                : a === 'antigravity'
                  ? 'Antigravity'
                  : a === 'copilot'
                    ? 'Copilot'
                    : a === 'codex'
                      ? 'Codex'
                      : 'Aider'}
            </button>
          ))}
        </div>
        <select
          className="input mono"
          style={{ fontSize: '0.78rem', padding: '4px 8px' }}
          value={model}
          onChange={(e) => setModel(e.target.value as AgentModelId)}
          title="Model Tier (Fable / Opus / Sonnet / Argon / Auto)"
        >
          {(Object.keys(MODEL_LABELS) as AgentModelId[]).map((m) => (
            <option key={m} value={m}>
              {MODEL_LABELS[m]}
            </option>
          ))}
        </select>
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

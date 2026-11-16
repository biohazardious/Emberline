import type { AgentPersona, Project, ProjectRecommendation, Run, Ticket } from '@emberline/protocol';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';
import { PERSONA_LIST, PersonaBadge } from './PersonaBadge';
import '../pages/dashboard-ux.css';

/**
 * The stack badges beside the project's name: language, frontend, backend and database, each once.
 * A layer left to the agent (stored by older cores as a sentence) is not a stack yet.
 */
export function stackBadgesOf(stack: Project['techStack'] | undefined): string[] {
  const values = [stack?.language, stack?.frontend, stack?.backend, stack?.database];
  return [
    ...new Set(
      values.filter(
        (v): v is string => typeof v === 'string' && v !== '' && !v.startsWith('Decided by the agent'),
      ),
    ),
  ];
}

export function ProjectAdvisorPanel({
  project,
  runnerDown,
  onOpenBlueprint,
  onStartPersonaRun,
  onRunStarted,
}: {
  project: Project;
  runnerDown?: boolean;
  onOpenBlueprint: () => void;
  onStartPersonaRun: (persona: AgentPersona, defaultPrompt?: string) => void;
  onRunStarted?: (run: Run) => void;
}) {
  const [, navigate] = useLocation();
  const recs = useApi<ProjectRecommendation[]>(`/api/projects/${project.id}/recommendations`, 8_000);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  const executeRecommendation = async (rec: ProjectRecommendation) => {
    setError(undefined);
    if (rec.actionType === 'open_blueprint') {
      onOpenBlueprint();
      return;
    }
    if (rec.actionType === 'open_board') {
      navigate(`/projects/${project.id}/board`);
      return;
    }
    if (rec.actionType === 'open_review' && rec.runId) {
      navigate(`/runs/${rec.runId}/review`);
      return;
    }
    if (rec.actionType === 'seed_tickets') {
      setBusyId(rec.id);
      try {
        await api<Ticket[]>(`/api/projects/${project.id}/seed-tickets`, 'POST', {});
        await recs.refresh();
        navigate(`/projects/${project.id}/board`);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusyId(undefined);
      }
      return;
    }
    if (rec.actionType === 'start_run') {
      if (runnerDown) {
        onStartPersonaRun(rec.persona, rec.prompt);
        return;
      }
      setBusyId(rec.id);
      try {
        const run = await api<Run>('/api/runs', 'POST', {
          projectId: project.id,
          persona: rec.persona,
          permissionMode: 'auto',
          prompt: rec.prompt ?? '',
        });
        await recs.refresh();
        onRunStarted?.(run);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusyId(undefined);
      }
    }
  };

  const stackBadges = stackBadgesOf(project.techStack);
  const recommendations = recs.data ?? [];

  return (
    <section className="panel advisor-panel" aria-labelledby="advisor-title">
      <header className="advisor-head">
        <div className="advisor-title-group">
          <h2 id="advisor-title" className="advisor-title">
            Next steps
          </h2>
          <span className="badge mono">{project.appType.replace('_', ' ')}</span>
          {stackBadges.map((item) => (
            <span key={item} className="badge badge-soft">
              {item}
            </span>
          ))}
        </div>
        <div className="actions">
          <button id="open-blueprint-btn" type="button" className="btn btn-sm" onClick={onOpenBlueprint}>
            Open PROJECT.md
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigate(`/projects/${project.id}/board`)}
          >
            Open board
          </button>
        </div>
      </header>

      <div className="advisor-personas-bar">
        {PERSONA_LIST.map((p) => (
          <button
            key={p.id}
            type="button"
            className="chip-btn advisor-persona-chip"
            onClick={() => onStartPersonaRun(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {recommendations.length > 0 && (
        <ul className="advisor-list">
          {recommendations.map((rec) => (
            <li key={rec.id} className={`advisor-row${rec.priority === 'high' ? ' advisor-row-high' : ''}`}>
              <div className="advisor-row-main">
                <PersonaBadge persona={rec.persona} />
                <span className="advisor-row-title">{rec.title}</span>
                <span className="advisor-row-desc">{rec.description}</span>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === rec.id}
                onClick={() => void executeRecommendation(rec)}
              >
                {busyId === rec.id ? 'Starting…' : rec.actionLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import type {
  AgentPersona,
  Project,
  ProjectRecommendation,
  Run,
  Ticket,
} from '@emberline/protocol';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { usePoll } from '../hooks/usePoll';
import { PERSONA_LIST, PersonaBadge } from './PersonaBadge';

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
  const recs = usePoll(
    () => api<ProjectRecommendation[]>(`/api/projects/${project.id}/recommendations`),
    8_000,
  );
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
          permissionMode: 'acceptEdits',
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

  const stackBadges = [
    project.techStack?.language,
    project.techStack?.frontend,
    project.techStack?.backend,
    project.techStack?.database,
  ].filter(Boolean);

  return (
    <section className="panel" aria-labelledby="advisor-title">
      <header className="panel-head" style={{ flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <p className="eyebrow">AI Coding Factory · Active Workspace</p>
          <h2 id="advisor-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>{project.name}</span>
            <span className="badge mono">{project.appType.replace('_', ' ')}</span>
            {stackBadges.map((item) => (
              <span key={item} className="badge badge-soft">
                {item}
              </span>
            ))}
          </h2>
          <p className="muted">
            {project.description || `Guided recommendations and specialist agent personas for ${project.name}.`}
          </p>
        </div>
        <div className="actions">
          <button
            id="open-blueprint-btn"
            type="button"
            className="btn btn-sm"
            onClick={onOpenBlueprint}
            title="View or edit PROJECT.md Blueprint"
          >
            PROJECT.md Blueprint
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => navigate(`/projects/${project.id}/board`)}
          >
            Open Kanban Board →
          </button>
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          paddingBottom: '10px',
          borderBottom: '1px solid var(--border)',
          marginBottom: '10px',
        }}
      >
        <span className="muted small mono" style={{ marginRight: '4px' }}>
          Dispatch Specialist:
        </span>
        {PERSONA_LIST.map((p) => (
          <button
            key={p.id}
            type="button"
            className="chip-btn"
            title={p.hint}
            onClick={() => onStartPersonaRun(p.id)}
          >
            <span className="mono muted" style={{ marginRight: '4px' }}>
              [{p.shortLabel}]
            </span>
            {p.label}
          </button>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '10px',
        }}
      >
        {(recs.data ?? []).map((rec) => (
          <div
            key={rec.id}
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '10px',
              borderColor: rec.priority === 'high' ? 'rgba(245, 158, 11, 0.35)' : undefined,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '6px' }}>
                <PersonaBadge persona={rec.persona} showFull />
                <span className="badge badge-soft mono">{rec.priority} priority</span>
              </div>
              <strong style={{ display: 'block', fontSize: '0.92rem', marginBottom: '4px' }}>
                {rec.title}
              </strong>
              <p className="muted small" style={{ margin: 0 }}>
                {rec.description}
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busyId === rec.id}
                onClick={() => void executeRecommendation(rec)}
              >
                {busyId === rec.id ? 'Working…' : rec.actionLabel}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

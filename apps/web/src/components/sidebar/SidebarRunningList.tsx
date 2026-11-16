import type { Project, Run } from '@emberline/protocol';
import { PersonaBadge } from '../PersonaBadge';
import { RunStatePill } from '../RunStatePill';

export function SidebarRunningList({
  activeRuns,
  projectById,
  inspectRunId,
  onToggleInspectRun,
}: {
  activeRuns: Run[];
  projectById: ReadonlyMap<string, Project>;
  inspectRunId: string | undefined;
  onToggleInspectRun: (id: string) => void;
}) {
  return (
    <div className="sidebar-section sidebar-section-grow" role="region" aria-label="Running">
      <div className="sidebar-section-head">
        <span className="sidebar-group-label">Running</span>
        <span className="sidebar-count mono">{activeRuns.length}</span>
      </div>
      <ul className="sidebar-list">
        {activeRuns.map((r) => {
          const title = r.title ?? projectById.get(r.projectId)?.name ?? 'Run';
          const isInspected = inspectRunId === r.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                className={`nav-item nav-run${isInspected ? ' active' : ''}`}
                aria-pressed={isInspected}
                onClick={() => onToggleInspectRun(r.id)}
                title={title}
              >
                <span className={`dot run-${r.state}`} />
                <span className="nav-label">{title}</span>
                {r.persona && r.persona !== 'coder' && <PersonaBadge persona={r.persona} />}
                <RunStatePill
                  state={r.state}
                  cancelled={r.cancelled}
                  autoRetry={r.autoRetry}
                  handedOffTo={r.handedOffTo}
                />
              </button>
            </li>
          );
        })}
        {activeRuns.length === 0 && <li className="sidebar-empty muted">All agents idle</li>}
      </ul>
    </div>
  );
}

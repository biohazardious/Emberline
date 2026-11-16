import type { DockerOverview, DockerOwnerKind, Project } from '@emberline/protocol';
import { Container } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AllProjectsToggle, MoreInOtherProjects } from '../components/AllProjectsToggle';
import { SearchInput } from '../components/BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { DockerAlert } from '../components/docker/DockerAlert';
import { DockerEngineBar } from '../components/docker/DockerEngineBar';
import { DockerProjectRow } from '../components/docker/DockerProjectRow';
import '../components/docker/docker-ux.css';
import { HelpHint, PageHeader } from '../components/ui';
import { dockerEngineOffState } from '../dockerEngine';
import {
  type DockerDone,
  dockerEmptyText,
  dockerProjectLabel,
  doneStillCurrent,
  groupDockerProjects,
  ownerSummary,
} from '../dockerPage';
import { useAllProjects } from '../hooks/useAllProjects';
import { useApi } from '../hooks/useApi';
import { inScope, outOfScope } from '../projectScope';

const GROUP_HEADING: Record<DockerOwnerKind, string> = {
  agent: 'Agents',
  preview: 'Previews',
  main: 'Main checks',
  orphan: 'Leftovers',
};

const GROUP_DETAILS: Record<DockerOwnerKind, string> = {
  agent:
    'Isolated compose stacks started inside a run worktree. Stopping keeps volumes; removing deletes containers, volumes and images.',
  preview:
    'Compose preview environments started from Review or the main workspace. Ports inside the preview range are linked on the row.',
  main: 'Compose services started while running checks on a project main workspace.',
  orphan:
    'Stacks whose run or worktree was already pruned. Automatic cleanup removes up to 10 leftover stacks per pass.',
};

export function DockerPage({
  activeProjectId,
  projects,
}: {
  activeProjectId: string | null;
  projects?: Project[];
}) {
  const { data, error: loadError, loading, refresh } = useApi<DockerOverview>('/api/docker', 10_000);
  const [all, setAll] = useAllProjects('docker');
  const [query, setQuery] = useState('');
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects]);
  const [done, setDone] = useState<DockerDone | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);

  const clearDone = useCallback(() => setDone(null), []);
  // Set after the refetch, so the line shows (and takes focus) once the list no longer has the project.
  const onDone = useCallback(
    async (next: DockerDone) => {
      await refresh();
      setDone(next);
    },
    [refresh],
  );
  // The card that had focus is gone after a Stop or Remove: focus moves to the line saying what happened.
  useEffect(() => {
    if (done) statusLine.current?.focus();
  }, [done]);
  // Once that project is listed again (something started it anew), the line no longer holds.
  useEffect(() => {
    if (done && data && !doneStillCurrent(done, data.projects)) setDone(null);
  }, [data, done]);

  const shown = useMemo(
    () => (data ? inScope(data.projects, (p) => p.projectId, { activeProjectId, all }) : []),
    [data, activeProjectId, all],
  );
  const hidden = data ? outOfScope(data.projects, (p) => p.projectId, { activeProjectId, all }) : 0;
  const filteredProjects = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return shown;
    return shown.filter((p) => {
      const owner = ownerSummary(p.owner);
      const haystack = [
        p.name,
        p.status,
        owner.prefix,
        owner.text ?? '',
        owner.detail ?? '',
        dockerProjectLabel(p.projectId, names) ?? '',
        ...p.containers.map((c) => `${c.name} ${c.service} ${c.image} ${c.state}`),
      ]
        .join(' ')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [shown, query, names]);
  const groups = groupDockerProjects(filteredProjects);
  const scoped = Boolean(activeProjectId) && !all;
  const enabled = data?.engine.enabled ?? false;

  return (
    <div className="board-page docker-ux-page">
      <PageHeader
        title="Docker"
        icon={<Container className="icon" aria-hidden="true" />}
        actions={activeProjectId ? <AllProjectsToggle on={all} onChange={setAll} /> : undefined}
      />

      {loadError !== undefined && (
        <ViewErrorBanner label="Could not load Docker status" error={loadError} onRetry={refresh} />
      )}
      {loading && !data && !loadError && <ViewLoadingState label="Loading Docker engine status…" />}

      {data && !enabled && (
        <div className="docker-ux-empty">
          <Container className="icon" aria-hidden="true" />
          <p>
            <strong>{dockerEngineOffState(data.engine).title}</strong>
          </p>
          <p className="muted small">{dockerEngineOffState(data.engine).text}</p>
        </div>
      )}

      {data && enabled && (
        <>
          <DockerEngineBar data={data} onStart={clearDone} onCleaned={refresh} scoped={scoped} />

          {done && doneStillCurrent(done, data.projects) && (
            <p ref={statusLine} className="docker-ux-done" role="status" tabIndex={-1}>
              {done.text}
            </p>
          )}
          {data.projectsError && (
            <DockerAlert error={`Projects could not be listed: ${data.projectsError}`} />
          )}
          {data.containersError && (
            <DockerAlert error={`Containers could not be listed: ${data.containersError}`} />
          )}

          <MoreInOtherProjects count={hidden} onShow={() => setAll(true)} />

          {(shown.length > 1 || query.trim() !== '') && (
            <div className="board-filter" role="search" aria-label="Filter Docker compose projects">
              <SearchInput
                id="docker-search"
                className="board-search"
                ariaLabel="Filter compose projects"
                placeholder="Filter by stack, service, image, or ticket…"
                value={query}
                onChange={setQuery}
              />
              {query.trim() !== '' && (
                <div className="board-filter-status">
                  <span className="muted small mono">
                    {filteredProjects.length} of {shown.length}
                  </span>
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => setQuery('')}>
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          {groups.length === 0 && query.trim() !== '' && shown.length > 0 && (
            <div className="empty">
              <p>No compose projects match your filter.</p>
              <button type="button" className="btn btn-sm" onClick={() => setQuery('')}>
                Clear filter
              </button>
            </div>
          )}

          {groups.length === 0 && query.trim() === '' && dockerEmptyText(data, scoped) && (
            <p className="muted">{dockerEmptyText(data, scoped)}</p>
          )}

          {groups.map((group) => {
            const heading = GROUP_HEADING[group.kind];
            return (
              <section key={group.kind} className="docker-ux-group" aria-label={group.label}>
                <div className="docker-ux-group-bar">
                  <h2 className="docker-ux-group-title">
                    {heading} <span className="muted mono">{group.projects.length}</span>
                  </h2>
                  <p className="docker-ux-group-hint">{group.hint}</p>
                  <HelpHint topic={heading}>{GROUP_DETAILS[group.kind]}</HelpHint>
                </div>
                <ul className="docker-ux-projects">
                  {group.projects.map((p) => (
                    <DockerProjectRow
                      key={p.name}
                      project={p}
                      projectLabel={scoped ? undefined : dockerProjectLabel(p.projectId, names)}
                      onStart={clearDone}
                      onDone={onDone}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

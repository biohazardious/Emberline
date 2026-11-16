import type { GarbageCollectRunsResponse, Project, Run } from '@emberline/protocol';
import { X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { fleetSection, isRunCompleted, needsElsewhere, type SeenMap } from '../attention';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { FleetPane } from '../components/FleetPane';
import { FleetEmptyState } from '../components/fleet/FleetEmptyState';
import {
  type FleetFilter,
  FleetToolbar,
  type FleetViewMode,
  type GridLayout,
} from '../components/fleet/FleetToolbar';
import { QuotaPanel } from '../components/QuotaPanel';
import { keptWorktreesSummary } from '../gcSummary';
import { useRuns } from '../hooks/liveData';
import { useAllProjects } from '../hooks/useAllProjects';
import { useApi } from '../hooks/useApi';
import { fleetBulkTitles, inScope, moreInOtherProjects } from '../projectScope';
import { runMatchesQuery } from '../runFilter';
import { toastError, toastInfo } from '../toast';
import '../components/fleet/fleet-ux.css';

const DISMISSED_KEY = 'emberline.fleet.dismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

type ActiveSectionKey = 'needs' | 'running';

const ACTIVE_SECTION_LABELS: Record<ActiveSectionKey, string> = {
  needs: 'Needs you',
  running: 'Running',
};

export function FleetPage({
  activeProjectId,
  seen,
  onInspectRun,
}: {
  activeProjectId?: string | null;
  /** Dismissed attention occurrences (shared with the Inbox). */
  seen: SeenMap;
  onInspectRun: (runId: string) => void;
}) {
  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns();
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const [filter, setFilter] = useState<FleetFilter>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [layout, setLayout] = useState<GridLayout>('grid');
  const [view, setView] = useState<FleetViewMode>('live');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkPrompt, setBulkPrompt] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [gcBusy, setGcBusy] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sectionOf = useCallback(
    (r: Run) => fleetSection(r, { now, seen, hidden: dismissed }),
    [now, seen, dismissed],
  );
  const dismiss = (id: string) =>
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200)));
      } catch {
        // Storage unavailable: the pane is hidden for this visit only.
      }
      return next;
    });

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  const [all, setAll] = useAllProjects('fleet');
  const scopedRuns = useMemo(
    () => inScope(runs ?? [], (r) => r.projectId, { activeProjectId: activeProjectId ?? null, all }),
    [runs, activeProjectId, all],
  );
  const bulkTitles = fleetBulkTitles({ activeProjectId: activeProjectId ?? null, all });
  const elsewhere = useMemo(
    () => (all ? 0 : needsElsewhere(runs ?? [], seen, activeProjectId)),
    [runs, seen, activeProjectId, all],
  );

  const counts = useMemo(() => {
    const completed = scopedRuns.filter((r) => isRunCompleted(r)).length;
    const active = scopedRuns.filter((r) => sectionOf(r) !== null).length;
    return {
      active,
      queued: scopedRuns.filter((r) => r.state === 'queued' && !isRunCompleted(r)).length,
      completed,
      total: scopedRuns.length,
    };
  }, [scopedRuns, sectionOf]);

  const visibleRuns = useMemo(() => {
    let base: Run[];
    switch (filter) {
      case 'active':
        base = scopedRuns.filter((r) => sectionOf(r) !== null);
        break;
      case 'queued':
        base = scopedRuns.filter((r) => r.state === 'queued' && !isRunCompleted(r));
        break;
      case 'completed':
        base = scopedRuns.filter((r) => isRunCompleted(r));
        break;
      case 'all':
        base = scopedRuns;
        break;
    }
    if (!searchQuery.trim()) return base;
    return base.filter((r) => runMatchesQuery(r, searchQuery, projectById.get(r.projectId)?.name ?? ''));
  }, [scopedRuns, filter, sectionOf, searchQuery, projectById]);

  const sections = useMemo(() => {
    const needsList: Run[] = [];
    const runningList: Run[] = [];
    for (const run of visibleRuns) {
      const s = sectionOf(run);
      if (!s) continue;
      if (s === 'needs') needsList.push(run);
      else runningList.push(run);
    }
    const out: { section: ActiveSectionKey; runs: Run[] }[] = [];
    if (needsList.length > 0) out.push({ section: 'needs', runs: needsList });
    if (runningList.length > 0) out.push({ section: 'running', runs: runningList });
    return out;
  }, [visibleRuns, sectionOf]);

  const selectableIds = new Set(
    visibleRuns.filter((r) => !isRunCompleted(r) && r.state !== 'queued').map((r) => r.id),
  );
  const selectedIds = [...selected].filter((id) => selectableIds.has(id));
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sendBulkPrompt = async (e: FormEvent) => {
    e.preventDefault();
    const text = bulkPrompt.trim();
    if (!text || selectedIds.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      selectedIds.map((id) => api(`/api/runs/${id}/prompt`, 'POST', { text })),
    );
    setBulkBusy(false);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      toastError(
        `Prompt failed for ${failed.length} of ${results.length} run(s): ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`,
      );
    } else {
      toastInfo(`Prompt sent to ${results.length} run(s).`);
      setBulkPrompt('');
      setSelected(new Set());
    }
  };

  const handleGarbageCollect = async (keepRecent = 0) => {
    setGcBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api<GarbageCollectRunsResponse>('/api/runs/gc', 'POST', {
        projectId: all ? undefined : (activeProjectId ?? undefined),
        keepRecent,
        includeFailed: true,
        pruneWorktrees: true,
      });
      setNotice(
        `Garbage collection complete: removed ${res.removedRuns} finished session${res.removedRuns === 1 ? '' : 's'}, closed ${res.closedSessions} lingering terminal${res.closedSessions === 1 ? '' : 's'}, and pruned ${res.prunedWorktrees} git worktree${res.prunedWorktrees === 1 ? '' : 's'}.`,
      );
      const kept = keptWorktreesSummary(res);
      if (kept) setNotice((prev) => `${prev ?? ''} ${kept}`.trim());
      if (filter === 'completed' && res.removedRuns > 0 && keepRecent === 0) {
        setFilter('active');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGcBusy(false);
    }
  };

  const handleStopAllActive = async () => {
    const activeList = scopedRuns.filter((r) => !isRunCompleted(r));
    if (activeList.length === 0) return;
    setStoppingAll(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await Promise.allSettled(activeList.map((r) => api(`/api/runs/${r.id}/stop`, 'POST')));
      setNotice(`Stopped ${activeList.length} active session${activeList.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStoppingAll(false);
    }
  };

  return (
    <div className="fleet-page">
      <FleetToolbar
        counts={counts}
        filter={filter}
        onChangeFilter={setFilter}
        layout={layout}
        onChangeLayout={setLayout}
        view={view}
        onChangeView={setView}
        searchQuery={searchQuery}
        onChangeSearchQuery={setSearchQuery}
        showSearch={scopedRuns.length > 0 || searchQuery.trim() !== ''}
        activeProjectId={activeProjectId}
        all={all}
        onChangeAll={setAll}
        bulkTitles={bulkTitles}
        gcBusy={gcBusy}
        stoppingAll={stoppingAll}
        onGarbageCollect={(keepRecent = 0) => void handleGarbageCollect(keepRecent)}
        onStopAllActive={() => void handleStopAllActive()}
        selectedCount={selectedIds.length}
        bulkPrompt={bulkPrompt}
        onChangeBulkPrompt={setBulkPrompt}
        bulkBusy={bulkBusy}
        onSubmitBulkPrompt={(e) => void sendBulkPrompt(e)}
        onClearSelection={() => setSelected(new Set())}
      />

      <QuotaPanel compact />

      {notice && (
        <div className="banner fleet-notice-banner">
          <span>{notice}</span>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            aria-label="Close"
            onClick={() => setNotice(undefined)}
          >
            <X className="icon" aria-hidden />
          </button>
        </div>
      )}

      {Boolean(runsError && !runs) && (
        <ViewErrorBanner label="Could not load fleet runs" error={runsError} onRetry={refreshRuns} />
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {filter === 'active' && elsewhere > 0 && !sections.some((s) => s.section === 'needs') && (
        <h2 className="fleet-section-head fleet-needs-elsewhere">
          {ACTIVE_SECTION_LABELS.needs} ·{' '}
          <button type="button" className="link-btn fleet-section-more" onClick={() => setAll(true)}>
            {moreInOtherProjects(elsewhere)}
          </button>
        </h2>
      )}

      {runsLoading && !runs && !runsError ? (
        <ViewLoadingState label="Loading fleet sessions…" />
      ) : visibleRuns.length === 0 ? (
        <FleetEmptyState
          searchQuery={searchQuery}
          filter={filter}
          completedCount={counts.completed}
          gcBusy={gcBusy}
          onClearSearch={() => setSearchQuery('')}
          onViewHistory={() => setFilter('completed')}
          onGarbageCollect={() => void handleGarbageCollect(0)}
        />
      ) : (
        <div className="fleet-sections">
          {(filter === 'active' ? sections : [{ section: null, runs: visibleRuns }]).map(
            ({ section, runs: list }) => (
              <section
                key={section ?? 'all'}
                className="fleet-section"
                aria-label={section ? ACTIVE_SECTION_LABELS[section] : undefined}
              >
                {section && (
                  <h2 className="fleet-section-head">
                    {ACTIVE_SECTION_LABELS[section]} <span className="muted mono">{list.length}</span>
                    {section === 'needs' && elsewhere > 0 && (
                      <button
                        type="button"
                        className="link-btn fleet-section-more"
                        onClick={() => setAll(true)}
                      >
                        {moreInOtherProjects(elsewhere)}
                      </button>
                    )}
                  </h2>
                )}
                <div className={`fleet-grid fleet-grid-${layout}`}>
                  {list.map((run) => (
                    <FleetPane
                      key={run.id}
                      run={run}
                      view={view}
                      selectable={selectableIds.has(run.id)}
                      selected={selected.has(run.id)}
                      onToggleSelected={() => toggleSelected(run.id)}
                      project={projectById.get(run.projectId)}
                      onInspect={() => onInspectRun(run.id)}
                      onError={setError}
                      onDismiss={
                        filter === 'active' && section !== 'needs' && isRunCompleted(run)
                          ? () => dismiss(run.id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </section>
            ),
          )}
        </div>
      )}
    </div>
  );
}

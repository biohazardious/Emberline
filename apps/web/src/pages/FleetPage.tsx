import type { GarbageCollectRunsResponse, Project, Run } from '@emberline/protocol';
import { Circle, Eraser, Package, Square, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import {
  FLEET_SECTION_LABELS,
  FLEET_SECTION_ORDER,
  type FleetSection,
  fleetSection,
  isRunCompleted,
  needsElsewhere,
  type SeenMap,
} from '../attention';
import { AllProjectsToggle } from '../components/AllProjectsToggle';
import { SearchInput } from '../components/BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { FleetPane } from '../components/FleetPane';
import { QuotaPanel } from '../components/QuotaPanel';
import { keptWorktreesSummary } from '../gcSummary';
import { useRuns } from '../hooks/liveData';
import { useAllProjects } from '../hooks/useAllProjects';
import { useApi } from '../hooks/useApi';
import { fleetBulkTitles, inScope, moreInOtherProjects } from '../projectScope';
import { runMatchesQuery } from '../runFilter';
import { toastError, toastInfo } from '../toast';

type FleetFilter = 'active' | 'queued' | 'completed' | 'all';
type GridLayout = 'grid' | 'cols' | 'single';

const DISMISSED_KEY = 'emberline.fleet.dismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

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
  const [view, setView] = useState<'live' | 'thumbnails'>('live');
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
    const bySection = new Map<FleetSection, Run[]>();
    for (const run of visibleRuns) {
      const section = sectionOf(run);
      if (section) bySection.set(section, [...(bySection.get(section) ?? []), run]);
    }
    return FLEET_SECTION_ORDER.flatMap((section) => {
      const list = bySection.get(section);
      return list ? [{ section, runs: list }] : [];
    });
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
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Fleet Multiplexer</h1>
          <span className="muted small">
            Supervise live agent sessions · Auto-GC closes finished terminals &amp; retains recent history
          </span>
        </div>
        <div className="workspace-bar-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          {(scopedRuns.length > 0 || searchQuery.trim() !== '') && (
            <SearchInput
              id="fleet-search"
              className="fleet-search"
              ariaLabel="Filter fleet panes"
              placeholder="Filter panes by ticket, branch, provider…"
              value={searchQuery}
              onChange={setSearchQuery}
            />
          )}

          {counts.active > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={stoppingAll}
              onClick={() => void handleStopAllActive()}
              title={bulkTitles.stopAll}
            >
              {stoppingAll ? (
                'Stopping…'
              ) : (
                <>
                  <Square className="icon" aria-hidden /> Stop All Active ({counts.active})
                </>
              )}
            </button>
          )}

          {counts.completed > 0 && (
            <button
              id="fleet-gc-btn"
              type="button"
              className="btn btn-sm"
              disabled={gcBusy}
              onClick={() => void handleGarbageCollect(0)}
              style={{
                borderColor: 'color-mix(in hsl, var(--ember-1) 45%, var(--border))',
              }}
              title={bulkTitles.cleanUp}
            >
              {gcBusy ? (
                <>
                  <Eraser className="icon" aria-hidden /> Cleaning…
                </>
              ) : (
                <>
                  <Eraser className="icon" aria-hidden /> Clean Up Finished ({counts.completed})
                </>
              )}
            </button>
          )}

          {activeProjectId && <AllProjectsToggle on={all} onChange={setAll} />}

          <div className="segmented segmented-scroll" role="tablist" aria-label="Fleet filter">
            <button
              id="fleet-filter-active"
              type="button"
              role="tab"
              aria-selected={filter === 'active'}
              className={filter === 'active' ? 'active' : ''}
              onClick={() => setFilter('active')}
              title="Only live running, waiting, or queued sessions"
            >
              <Circle className="icon" aria-hidden fill="currentColor" style={{ color: 'var(--ok)' }} /> Live
              ({counts.active})
            </button>
            <button
              id="fleet-filter-queued"
              type="button"
              role="tab"
              aria-selected={filter === 'queued'}
              className={filter === 'queued' ? 'active' : ''}
              onClick={() => setFilter('queued')}
            >
              Queued ({counts.queued})
            </button>
            <button
              id="fleet-filter-completed"
              type="button"
              role="tab"
              aria-selected={filter === 'completed'}
              className={filter === 'completed' ? 'active' : ''}
              onClick={() => setFilter('completed')}
              title="Archived completed & failed runs"
            >
              <Package className="icon" aria-hidden /> History ({counts.completed})
            </button>
            <button
              id="fleet-filter-all"
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
            >
              All ({counts.total})
            </button>
          </div>

          <div className="segmented hide-sm" role="radiogroup" aria-label="Grid layout">
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'grid'}
              className={layout === 'grid' ? 'active' : ''}
              onClick={() => setLayout('grid')}
              title="2×2 grid"
            >
              2×2
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'cols'}
              className={layout === 'cols' ? 'active' : ''}
              onClick={() => setLayout('cols')}
              title="Side-by-side columns"
            >
              2×1
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'single'}
              className={layout === 'single' ? 'active' : ''}
              onClick={() => setLayout('single')}
              title="Single stacked column"
            >
              1×1
            </button>
          </div>

          <div className="segmented hide-sm" role="radiogroup" aria-label="Pane content">
            <button
              type="button"
              role="radio"
              aria-checked={view === 'live'}
              className={view === 'live' ? 'active' : ''}
              onClick={() => setView('live')}
              title="Live terminals for panes in view, text thumbnails elsewhere"
            >
              Live
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'thumbnails'}
              className={view === 'thumbnails' ? 'active' : ''}
              onClick={() => setView('thumbnails')}
              title="Text thumbnails only: cheapest view for many agents"
            >
              Thumbnails
            </button>
          </div>
        </div>
      </header>

      {selectedIds.length > 0 && (
        <form className="fleet-bulk-bar" onSubmit={(e) => void sendBulkPrompt(e)}>
          <span className="mono">{selectedIds.length} selected</span>
          <input
            type="text"
            className="input"
            value={bulkPrompt}
            onChange={(e) => setBulkPrompt(e.target.value)}
            placeholder="Prompt to send to every selected agent…"
            aria-label="Prompt for the selected agents"
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={bulkBusy || !bulkPrompt.trim()}>
            {bulkBusy ? 'Sending…' : 'Send to selected'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </form>
      )}

      <QuotaPanel compact />

      {notice && (
        <div
          className="banner"
          style={{
            background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--ok) 40%, transparent)',
            color: 'var(--ok)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
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
          {FLEET_SECTION_LABELS.needs} ·{' '}
          <button type="button" className="link-btn fleet-section-more" onClick={() => setAll(true)}>
            {moreInOtherProjects(elsewhere)}
          </button>
        </h2>
      )}

      {runsLoading && !runs && !runsError ? (
        <ViewLoadingState label="Loading fleet sessions…" />
      ) : visibleRuns.length === 0 ? (
        <div className="empty fleet-empty">
          <p>
            {searchQuery.trim() !== ''
              ? 'No agent sessions match your search.'
              : filter === 'active' && counts.completed > 0
                ? `No live agent sessions running right now (${counts.completed} finished session${counts.completed === 1 ? '' : 's'} archived in History).`
                : 'No agent sessions match the selected filter.'}
          </p>
          <p
            className="muted small"
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'center',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {searchQuery.trim() !== '' ? (
              <button type="button" className="btn btn-sm" onClick={() => setSearchQuery('')}>
                Clear search
              </button>
            ) : (
              <>
                <span>
                  Start a ticket from a project board or launch a run from the{' '}
                  <Link href="/">Factory Overview</Link>.
                </span>
                {filter === 'active' && counts.completed > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setFilter('completed')}
                    >
                      <Package className="icon" aria-hidden /> View History ({counts.completed})
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={gcBusy}
                      onClick={() => void handleGarbageCollect(0)}
                    >
                      <Eraser className="icon" aria-hidden /> Clean Up Finished ({counts.completed})
                    </button>
                  </>
                )}
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="fleet-sections">
          {(filter === 'active' ? sections : [{ section: null, runs: visibleRuns }]).map(
            ({ section, runs: list }) => (
              <section
                key={section ?? 'all'}
                className="fleet-section"
                aria-label={section ? FLEET_SECTION_LABELS[section] : undefined}
              >
                {section && (
                  <h2 className="fleet-section-head">
                    {FLEET_SECTION_LABELS[section]} <span className="muted mono">{list.length}</span>
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

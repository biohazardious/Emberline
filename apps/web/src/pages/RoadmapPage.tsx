import type {
  AgentId,
  FactorySettings,
  Project,
  ProjectRoadmapState,
  RoadmapCategory,
} from '@emberline/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { BrainstormingColumn } from '../components/roadmap/BrainstormingColumn';
import { MilestonesColumn } from '../components/roadmap/MilestonesColumn';
import { RoadmapHeaderPanel } from '../components/roadmap/RoadmapHeaderPanel';
import { useRoadmapActions } from '../components/roadmap/useRoadmapActions';
import { useRuns } from '../hooks/liveData';
import { useApi } from '../hooks/useApi';
import {
  countRoadmapCategories,
  countRoadmapStatuses,
  EMPTY_ROADMAP_FILTER,
  filterRoadmap,
  isRoadmapFilterActive,
  parseRoadmapFilter,
  type RoadmapFilter,
} from '../roadmapFilter';

export {
  AGENT_LABELS,
  AgentModelBadge,
  MODEL_LABELS,
  RouteBadgeSelect,
} from '../components/roadmap/RoadmapBadges';

export function RoadmapStudioPanel({ projectId }: { projectId: string }) {
  const [, navigate] = useLocation();
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const roadmapPoll = useApi<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap`, 6_000);
  const factorySettingsPoll = useApi<FactorySettings>('/api/factory/settings', 20_000);
  const enabledProviders: AgentId[] = useMemo(
    () =>
      factorySettingsPoll.data?.enabledProviders?.length
        ? factorySettingsPoll.data.enabledProviders
        : ['claude'],
    [factorySettingsPoll.data],
  );
  const { runs } = useRuns();
  const [localRoadmap, setLocalRoadmap] = useState<ProjectRoadmapState | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<RoadmapCategory | 'all'>('all');
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [brainstormFocus, setBrainstormFocus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingBrainstormRunId, setPendingBrainstormRunId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (roadmapPoll.data) setLocalRoadmap(roadmapPoll.data);
  }, [roadmapPoll.data]);

  const activeBrainstormRun = useMemo(() => {
    const list = runs ?? [];
    return list.find(
      (r) =>
        r.projectId === projectId &&
        !r.endedAt &&
        r.state !== 'done' &&
        r.state !== 'failed' &&
        (r.id === pendingBrainstormRunId ||
          Boolean(r.title?.includes('[Brainstorm]')) ||
          Boolean(r.title?.includes('[Roadmap]')) ||
          Boolean(r.title?.includes('Brainstorm & Roadmap'))),
    );
  }, [runs, projectId, pendingBrainstormRunId]);

  useEffect(() => {
    if (!pendingBrainstormRunId) return;
    const matched = (runs ?? []).find((r) => r.id === pendingBrainstormRunId);
    if (matched && (matched.endedAt || matched.state === 'done' || matched.state === 'failed')) {
      setPendingBrainstormRunId(null);
      void roadmapPoll.refresh();
    }
  }, [runs, pendingBrainstormRunId, roadmapPoll]);

  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddTarget, setQuickAddTarget] = useState<string>('auto');
  const [inlineMsInputs, setInlineMsInputs] = useState<Record<string, string>>({});

  const project = useMemo(() => projects.data?.find((p) => p.id === projectId), [projects.data, projectId]);
  const roadmap = localRoadmap ?? roadmapPoll.data;

  const filterKey = `emberline.roadmap.filter.${projectId}`;
  const [itemFilter, setItemFilter] = useState<RoadmapFilter>(() => {
    try {
      return parseRoadmapFilter(localStorage.getItem(filterKey));
    } catch {
      return EMPTY_ROADMAP_FILTER;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(filterKey, JSON.stringify(itemFilter));
    } catch {
      // Storage unavailable: filter lasts for this visit only.
    }
  }, [filterKey, itemFilter]);

  const filteredRoadmap = useMemo(
    () => filterRoadmap(roadmap?.milestones ?? [], itemFilter),
    [roadmap?.milestones, itemFilter],
  );
  const statusCounts = useMemo(() => countRoadmapStatuses(roadmap?.milestones ?? []), [roadmap?.milestones]);
  const categoryCounts = useMemo(
    () => countRoadmapCategories(roadmap?.milestones ?? []),
    [roadmap?.milestones],
  );
  const filterActive = isRoadmapFilterActive(itemFilter);

  const filteredSuggestions = useMemo(() => {
    const list = roadmap?.suggestions ?? [];
    return categoryFilter === 'all' ? list : list.filter((s) => s.category === categoryFilter);
  }, [roadmap?.suggestions, categoryFilter]);

  const toggleSuggestion = (id: string) => {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleItem = (id: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleSelectAllSuggestions = () => {
    const visibleIds = filteredSuggestions.map((s) => s.id);
    if (visibleIds.length === 0) return;
    const allSelected = visibleIds.every((id) => selectedSuggestions.has(id));
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const isAgentBrainstorming = Boolean(activeBrainstormRun || pendingBrainstormRunId);

  const actions = useRoadmapActions({
    projectId,
    projectName: project?.name,
    roadmap,
    filteredSuggestions,
    selectedSuggestions,
    setSelectedSuggestions,
    selectedItems,
    setSelectedItems,
    brainstormFocus,
    quickAddText,
    setQuickAddText,
    quickAddTarget,
    setQuickAddTarget,
    inlineMsInputs,
    setInlineMsInputs,
    busy,
    setBusy,
    isAgentBrainstorming,
    setPendingBrainstormRunId,
    setLocalRoadmap,
    setBanner,
    setError,
  });

  if (!roadmap) {
    if (roadmapPoll.error) {
      return (
        <ViewErrorBanner
          label="Could not load Interactive Roadmap"
          error={roadmapPoll.error}
          onRetry={roadmapPoll.refresh}
        />
      );
    }
    return (
      <section className="panel" aria-busy="true">
        <ViewLoadingState label="Loading Interactive Roadmap & AI Brainstorming Studio…" compact />
      </section>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RoadmapHeaderPanel
        projectName={project?.name}
        roadmap={roadmap}
        busy={busy}
        isAgentBrainstorming={isAgentBrainstorming}
        onAutoGenerate={(mode) => void actions.handleAutoGenerateRoadmap(mode)}
        onOpenBoard={() => navigate(`/projects/${projectId}/board`)}
        quickAddTarget={quickAddTarget}
        onQuickAddTargetChange={setQuickAddTarget}
        quickAddText={quickAddText}
        onQuickAddTextChange={setQuickAddText}
        onSmartQuickAdd={(e) => void actions.handleSmartQuickAdd(e)}
        selectedSuggestionsCount={selectedSuggestions.size}
        selectedItemsCount={selectedItems.size}
        onClearSelection={() => {
          setSelectedSuggestions(new Set());
          setSelectedItems(new Set());
        }}
        onDispatchSelected={(autoStart) => void actions.handleDispatchSelected(autoStart)}
        banner={banner}
        error={error}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))',
          gap: 14,
          alignItems: 'start',
        }}
      >
        <BrainstormingColumn
          projectName={project?.name}
          filteredSuggestions={filteredSuggestions}
          selectedSuggestions={selectedSuggestions}
          onToggleSuggestion={toggleSuggestion}
          onToggleSelectAllSuggestions={handleToggleSelectAllSuggestions}
          onClearAllSuggestions={actions.handleClearAllSuggestions}
          onBuildAllSuggestions={() => void actions.handleBuildAllSuggestions()}
          brainstormFocus={brainstormFocus}
          onBrainstormFocusChange={setBrainstormFocus}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          onBrainstorm={(mode) => void actions.handleBrainstorm(mode)}
          busy={busy}
          isAgentBrainstorming={isAgentBrainstorming}
          activeBrainstormRun={activeBrainstormRun}
          enabledProviders={enabledProviders}
          onChangeRoute={(id, agent, model) => void actions.handleChangeRoute(id, agent, model)}
          onQuickPromoteSuggestion={(sug, autoStart) =>
            void actions.handleQuickPromoteSuggestion(sug, autoStart)
          }
          onDismissSuggestion={actions.handleDismissSuggestion}
        />

        <MilestonesColumn
          projectId={projectId}
          totalMilestoneCount={roadmap.milestones.length}
          filteredRoadmap={filteredRoadmap}
          itemFilter={itemFilter}
          onItemFilterChange={setItemFilter}
          filterActive={filterActive}
          statusCounts={statusCounts}
          categoryCounts={categoryCounts}
          selectedItems={selectedItems}
          onToggleItem={toggleItem}
          onToggleItemDone={actions.handleToggleItemDone}
          onDeleteItem={actions.handleDeleteItem}
          onDispatchSingleItem={actions.handleDispatchSingleItem}
          onDispatchMilestone={actions.handleDispatchMilestone}
          onDeleteMilestone={actions.handleDeleteMilestone}
          inlineMsInputs={inlineMsInputs}
          onInlineMsInputChange={(msId, text) => setInlineMsInputs((prev) => ({ ...prev, [msId]: text }))}
          onInlineMilestoneAdd={(msId, msCode) => void actions.handleInlineMilestoneAdd(msId, msCode)}
          enabledProviders={enabledProviders}
          onChangeRoute={(id, agent, model) => void actions.handleChangeRoute(id, agent, model)}
          busy={busy}
        />
      </div>
    </div>
  );
}

export function RoadmapPage({ projectId }: { projectId: string }) {
  return (
    <div className="dashboard">
      <RoadmapStudioPanel projectId={projectId} />
    </div>
  );
}

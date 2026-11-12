import type { AgentId, RoadmapCategory } from '@emberline/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { BrainstormingColumn } from '../components/roadmap/BrainstormingColumn';
import { MilestonesColumn } from '../components/roadmap/MilestonesColumn';
import { RoadmapHeaderPanel } from '../components/roadmap/RoadmapHeaderPanel';
import { useRuns } from '../hooks/liveData';
import { useFactorySettings } from '../hooks/useFactorySettings';
import { useProject } from '../hooks/useProjects';
import { useProjectRoadmap } from '../hooks/useRoadmap';
import { useRoadmapActions } from '../hooks/useRoadmapActions';
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
  const { project } = useProject(projectId, 15_000);
  const roadmapQuery = useProjectRoadmap(projectId);
  const roadmap = roadmapQuery.data;
  const settings = useFactorySettings(20_000).data;
  const enabledProviders: AgentId[] = useMemo(
    () => (settings?.enabledProviders?.length ? settings.enabledProviders : ['claude']),
    [settings],
  );
  const { runs } = useRuns();

  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(() => new Set());
  const [selectedItems, setSelectedItems] = useState<Set<string>>(() => new Set());
  const [brainstormFocus, setBrainstormFocus] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<RoadmapCategory | 'all'>('all');
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddTarget, setQuickAddTarget] = useState<string>('auto');
  const [inlineMsInputs, setInlineMsInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingBrainstormRunId, setPendingBrainstormRunId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      void roadmapQuery.refresh();
    }
  }, [runs, pendingBrainstormRunId, roadmapQuery]);

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
    setRoadmap: roadmapQuery.setData,
    setBanner,
    setError,
  });

  if (!roadmap) {
    return (
      <RoadmapHeaderPanel
        projectName={project?.name}
        roadmap={undefined}
        loading={roadmapQuery.loading}
        loadError={roadmapQuery.error}
        onRetry={roadmapQuery.refresh}
        busy={busy}
        isAgentBrainstorming={isAgentBrainstorming}
        onAutoGenerate={(mode) => void actions.handleAutoGenerateRoadmap(mode)}
        onOpenBoard={() => navigate(`/projects/${projectId}/board`)}
        quickAddTarget={quickAddTarget}
        onQuickAddTargetChange={setQuickAddTarget}
        quickAddText={quickAddText}
        onQuickAddTextChange={setQuickAddText}
        onSmartQuickAdd={(e) => void actions.handleSmartQuickAdd(e)}
        selectedSuggestionsCount={0}
        selectedItemsCount={0}
        onClearSelection={() => undefined}
        onDispatchSelected={() => undefined}
        banner={banner}
        error={error}
      />
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

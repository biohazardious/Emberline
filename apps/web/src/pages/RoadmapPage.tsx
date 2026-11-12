import type { AgentId, AgentModelId, ProjectRoadmapState } from '@emberline/protocol';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { BrainstormingSection } from '../components/roadmap/BrainstormingSection';
import { MilestonesSection } from '../components/roadmap/MilestonesSection';
import { RoadmapHeaderSection } from '../components/roadmap/RoadmapHeaderSection';
import type { RoadmapStudioCtx } from '../components/roadmap/roadmapMeta';
import { useRuns } from '../hooks/liveData';
import { useFactorySettings } from '../hooks/useFactorySettings';
import { useProject } from '../hooks/useProjects';
import { useProjectRoadmap } from '../hooks/useRoadmap';

export { MODEL_LABELS, RouteBadgeSelect } from '../components/roadmap/roadmapMeta';

export function RoadmapStudioPanel({ projectId }: { projectId: string }) {
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
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingBrainstormRunId, setPendingBrainstormRunId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${projectId}/roadmap`;

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

  const toggleInSet = (setter: (fn: (prev: Set<string>) => Set<string>) => void, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runTask = async (busyKey: string | null, fn: () => Promise<void>, clearBanner = true) => {
    if (busyKey !== null) setBusy(busyKey);
    setError(null);
    if (clearBanner) setBanner(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (busyKey !== null) setBusy(null);
    }
  };

  const handleChangeRoute = async (id: string, preferredAgent: AgentId, preferredModel: AgentModelId) => {
    roadmapQuery.setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        suggestions: prev.suggestions.map((s) =>
          s.id === id ? { ...s, preferredAgent, preferredModel } : s,
        ),
        milestones: prev.milestones.map((m) => ({
          ...m,
          items: m.items.map((it) => (it.id === id ? { ...it, preferredAgent, preferredModel } : it)),
        })),
      };
    });
    await runTask(
      null,
      async () => {
        roadmapQuery.setData(
          await api<ProjectRoadmapState>(`${base}/items/${id}`, 'PATCH', {
            preferredAgent,
            preferredModel,
          }),
        );
      },
      false,
    );
  };

  const ctx: RoadmapStudioCtx = {
    pid: projectId,
    base,
    proj: project,
    rm: roadmap,
    load: roadmapQuery.loading,
    errObj: roadmapQuery.error,
    retry: roadmapQuery.refresh,
    provs: enabledProviders,
    busy,
    working: Boolean(activeBrainstormRun || pendingBrainstormRunId),
    setRm: roadmapQuery.setData,
    onRun: setPendingBrainstormRunId,
    route: (id, agent, model) => void handleChangeRoute(id, agent, model),
    banner,
    setBanner,
    err: error,
    task: runTask,
  };

  if (!roadmap) {
    return (
      <RoadmapHeaderSection
        ctx={ctx}
        focus={brainstormFocus}
        sugIds={[]}
        itemIds={[]}
        clear={() => undefined}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RoadmapHeaderSection
        ctx={ctx}
        focus={brainstormFocus}
        sugIds={Array.from(selectedSuggestions)}
        itemIds={Array.from(selectedItems)}
        clear={() => {
          setSelectedSuggestions(new Set());
          setSelectedItems(new Set());
        }}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))',
          gap: 14,
          alignItems: 'start',
        }}
      >
        <BrainstormingSection
          ctx={ctx}
          run={activeBrainstormRun}
          focus={brainstormFocus}
          setFocus={setBrainstormFocus}
          sel={selectedSuggestions}
          toggle={(id) => toggleInSet(setSelectedSuggestions, id)}
          setSel={setSelectedSuggestions}
        />

        <MilestonesSection ctx={ctx} sel={selectedItems} toggle={(id) => toggleInSet(setSelectedItems, id)} />
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

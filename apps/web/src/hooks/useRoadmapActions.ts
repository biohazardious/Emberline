import type {
  AgentId,
  AgentModelId,
  AutoGenerateRoadmapResponse,
  BrainstormResponse,
  BrainstormSuggestion,
  DispatchRoadmapItemsResponse,
  ProjectRoadmapState,
  RoadmapItem,
} from '@emberline/protocol';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { api, errorMessage } from '../api';

export interface UseRoadmapActionsParams {
  projectId: string;
  projectName?: string;
  roadmap: ProjectRoadmapState | undefined;
  filteredSuggestions: BrainstormSuggestion[];
  selectedSuggestions: Set<string>;
  setSelectedSuggestions: Dispatch<SetStateAction<Set<string>>>;
  selectedItems: Set<string>;
  setSelectedItems: Dispatch<SetStateAction<Set<string>>>;
  brainstormFocus: string;
  quickAddText: string;
  setQuickAddText: Dispatch<SetStateAction<string>>;
  quickAddTarget: string;
  setQuickAddTarget: Dispatch<SetStateAction<string>>;
  inlineMsInputs: Record<string, string>;
  setInlineMsInputs: Dispatch<SetStateAction<Record<string, string>>>;
  busy: string | null;
  setBusy: Dispatch<SetStateAction<string | null>>;
  isAgentBrainstorming: boolean;
  setPendingBrainstormRunId: Dispatch<SetStateAction<string | null>>;
  setRoadmap: (
    updater:
      ProjectRoadmapState | ((prev: ProjectRoadmapState | undefined) => ProjectRoadmapState | undefined),
  ) => void;
  setBanner: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useRoadmapActions({
  projectId,
  projectName,
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
  setRoadmap,
  setBanner,
  setError,
}: UseRoadmapActionsParams) {
  const handleBrainstorm = async (mode: 'instant' | 'agent') => {
    if (busy !== null || (mode === 'agent' && isAgentBrainstorming)) return;
    setBusy(mode === 'agent' ? 'brainstorm-agent' : 'brainstorm-instant');
    setError(null);
    setBanner(null);
    try {
      const startedAt = Date.now();
      const res = await api<BrainstormResponse>(`/api/projects/${projectId}/roadmap/brainstorm`, 'POST', {
        focus: brainstormFocus.trim(),
        mode,
        leadPersona: 'product_owner',
      });
      const elapsed = Date.now() - startedAt;
      if (elapsed < 550) await new Promise((r) => setTimeout(r, 550 - elapsed));
      setRoadmap(res.roadmap);
      if (mode === 'agent' && res.agentRun) {
        setPendingBrainstormRunId(res.agentRun.id);
        setBanner(
          `Deep Brainstorming Agent (${res.agentRun.agent} · fable) is analyzing your codebase. New suggestions will appear automatically when it finishes.`,
        );
      } else {
        setBanner(
          `Synthesized fresh codebase-aware feature & architecture suggestions${brainstormFocus.trim() ? ` for "${brainstormFocus.trim()}"` : ''}.`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDispatchSelected = async (autoStart: boolean) => {
    if (selectedSuggestions.size === 0 && selectedItems.size === 0) return;
    setBusy(autoStart ? 'dispatch-run' : 'dispatch-board');
    setError(null);
    setBanner(null);
    try {
      const res = await api<DispatchRoadmapItemsResponse>(
        `/api/projects/${projectId}/roadmap/dispatch`,
        'POST',
        {
          itemIds: Array.from(selectedItems),
          suggestionIds: Array.from(selectedSuggestions),
          autoStart,
        },
      );
      setRoadmap(res.roadmap);
      setSelectedSuggestions(new Set());
      setSelectedItems(new Set());
      setBanner(
        `Created ${res.createdTickets.length} Kanban ticket(s)${res.startedRun ? ` and launched agent run (${res.startedRun.title ?? res.startedRun.id.slice(0, 8)})` : ''}!`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleQuickPromoteSuggestion = async (sug: BrainstormSuggestion, autoStart: boolean) => {
    setBusy(`sug-${sug.id}`);
    setError(null);
    setBanner(null);
    try {
      if (!autoStart) {
        const targetMs =
          roadmap?.milestones.find((m) => m.code === sug.suggestedMilestoneCode) ??
          roadmap?.milestones[1] ??
          roadmap?.milestones[0];
        const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items`, 'POST', {
          milestoneId: targetMs?.id ?? 'M2',
          title: sug.title,
          description: `${sug.rationale}\n\n---\nImplementation Spec:\n${sug.implementationPrompt}`,
          category: sug.category,
          persona: sug.persona,
          preferredAgent: sug.preferredAgent,
          preferredModel: sug.preferredModel,
          priority: sug.impact === 'high' ? 3 : 2,
          status: 'planned',
        });
        const afterDelete = await api<ProjectRoadmapState>(
          `/api/projects/${projectId}/roadmap/items/${sug.id}`,
          'DELETE',
        );
        setRoadmap(afterDelete ?? next);
        setBanner(`Added "${sug.title}" to Milestone ${targetMs?.code ?? 'M2'}.`);
      } else {
        const res = await api<DispatchRoadmapItemsResponse>(
          `/api/projects/${projectId}/roadmap/dispatch`,
          'POST',
          { suggestionIds: [sug.id], autoStart: true },
        );
        setRoadmap(res.roadmap);
        setBanner(
          `Added "${sug.title}" to Roadmap, created Ticket ${res.createdTickets[0]?.key ?? ''}, and dispatched ${sug.preferredAgent} (${sug.preferredModel})!`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleChangeRoute = async (id: string, preferredAgent: AgentId, preferredModel: AgentModelId) => {
    setError(null);
    setRoadmap((prev) =>
      !prev
        ? prev
        : {
            ...prev,
            suggestions: prev.suggestions.map((s) =>
              s.id === id ? { ...s, preferredAgent, preferredModel } : s,
            ),
            milestones: prev.milestones.map((m) => ({
              ...m,
              items: m.items.map((it) => (it.id === id ? { ...it, preferredAgent, preferredModel } : it)),
            })),
          },
    );
    try {
      const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items/${id}`, 'PATCH', {
        preferredAgent,
        preferredModel,
      });
      setRoadmap(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleBuildAllSuggestions = async () => {
    if (filteredSuggestions.length === 0 || busy !== null) return;
    setBusy('build-all-suggestions');
    setError(null);
    setBanner(null);
    try {
      const res = await api<DispatchRoadmapItemsResponse>(
        `/api/projects/${projectId}/roadmap/dispatch`,
        'POST',
        { suggestionIds: filteredSuggestions.map((s) => s.id), autoStart: true },
      );
      setRoadmap(res.roadmap);
      setSelectedSuggestions(new Set());
      setBanner(
        `Promoted all ${res.createdTickets.length} Brainstorming idea(s) to the Roadmap & Kanban Board and started the autonomous multi-agent pipeline!`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleAutoGenerateRoadmap = async (mode: 'instant' | 'agent') => {
    if (busy !== null || (mode === 'agent' && isAgentBrainstorming)) return;
    setBusy(mode === 'agent' ? 'autogen-agent' : 'autogen-instant');
    setError(null);
    setBanner(null);
    try {
      const res = await api<AutoGenerateRoadmapResponse>(
        `/api/projects/${projectId}/roadmap/auto-generate`,
        'POST',
        { mode, instructions: quickAddText.trim() || brainstormFocus.trim() },
      );
      setRoadmap(res.roadmap);
      if (mode === 'agent' && res.agentRun) {
        setPendingBrainstormRunId(res.agentRun.id);
        setBanner(
          `System Architect (${res.agentRun.agent}) is inspecting ${projectName ?? 'the repository'} to generate a tailored milestone roadmap…`,
        );
      } else {
        setBanner(
          'Auto-generated project-tailored milestones & tasks from PROJECT.md and repository context!',
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSmartQuickAdd = async (e: FormEvent) => {
    e.preventDefault();
    const raw = quickAddText.trim();
    if (!raw) return;
    setBusy('quick-add');
    setError(null);
    setBanner(null);
    try {
      if (quickAddTarget === '__new_milestone__') {
        const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/milestones`, 'POST', {
          title: raw,
        });
        setRoadmap(next);
        setQuickAddText('');
        setQuickAddTarget('auto');
        setBanner(`Created new milestone "${raw}".`);
      } else {
        const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items`, 'POST', {
          milestoneId: quickAddTarget || 'auto',
          title: raw,
        });
        setRoadmap(next);
        setQuickAddText('');
        setBanner(`Auto-routed "${raw}" to the right milestone, specialist persona & AI model!`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleInlineMilestoneAdd = async (msId: string, msCode: string) => {
    const raw = (inlineMsInputs[msId] ?? '').trim();
    if (!raw) return;
    setBusy(`inline-add-${msId}`);
    setError(null);
    try {
      const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items`, 'POST', {
        milestoneId: msId,
        title: raw,
      });
      setRoadmap(next);
      setInlineMsInputs((prev) => ({ ...prev, [msId]: '' }));
      setBanner(`Added "${raw}" to ${msCode} (auto-assigned specialist & model).`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleClearAllSuggestions = () => {
    void api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items/__all_suggestions__`, 'DELETE')
      .then((next) => {
        setRoadmap(next);
        setSelectedSuggestions(new Set());
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleDismissSuggestion = (sugId: string) => {
    void api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items/${sugId}`, 'DELETE')
      .then(setRoadmap)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleToggleItemDone = (item: RoadmapItem) => {
    const nextStatus = item.status === 'done' ? 'planned' : 'done';
    void api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items/${item.id}`, 'PATCH', {
      status: nextStatus,
    })
      .then(setRoadmap)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleDeleteItem = (itemId: string) => {
    void api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items/${itemId}`, 'DELETE')
      .then(setRoadmap)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleDispatchSingleItem = (itemId: string) => {
    setBusy(`item-${itemId}`);
    setError(null);
    void api<DispatchRoadmapItemsResponse>(`/api/projects/${projectId}/roadmap/dispatch`, 'POST', {
      itemIds: [itemId],
      autoStart: true,
    })
      .then((res) => {
        setRoadmap(res.roadmap);
        setBanner(
          `Dispatched item to Kanban Board (${res.createdTickets[0]?.key ?? 'ready'}) and started autonomous execution!`,
        );
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const handleDispatchMilestone = (msId: string, msCode: string, undispatchedIds: string[]) => {
    setBusy(`ms-${msId}`);
    void api<DispatchRoadmapItemsResponse>(`/api/projects/${projectId}/roadmap/dispatch`, 'POST', {
      itemIds: undispatchedIds,
      autoStart: true,
    })
      .then((res) => {
        setRoadmap(res.roadmap);
        setBanner(
          `Dispatched Milestone ${msCode} (${res.createdTickets.length} new ticket(s)) to the AI Coding Factory!`,
        );
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  const handleDeleteMilestone = (msId: string, msCode: string) => {
    setBusy(`del-ms-${msId}`);
    setError(null);
    void api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/milestones/${msId}`, 'DELETE')
      .then((next) => {
        setRoadmap(next);
        setBanner(`Removed milestone ${msCode} (any remaining items were preserved).`);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  return {
    handleBrainstorm,
    handleDispatchSelected,
    handleQuickPromoteSuggestion,
    handleChangeRoute,
    handleBuildAllSuggestions,
    handleAutoGenerateRoadmap,
    handleSmartQuickAdd,
    handleInlineMilestoneAdd,
    handleClearAllSuggestions,
    handleDismissSuggestion,
    handleToggleItemDone,
    handleDeleteItem,
    handleDispatchSingleItem,
    handleDispatchMilestone,
    handleDeleteMilestone,
  };
}

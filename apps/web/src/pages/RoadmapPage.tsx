import {
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  type AutoGenerateRoadmapResponse,
  type BrainstormResponse,
  type BrainstormSuggestion,
  coerceModelForProvider,
  type DispatchRoadmapItemsResponse,
  type FactorySettings,
  getModelInfoForProvider,
  getModelsForProvider,
  type Project,
  type ProjectRoadmapState,
  PROVIDER_REGISTRY,
  type RoadmapCategory,
  type RoadmapItem,
} from '@emberline/protocol';
import {
  Bot,
  Brain,
  Construction,
  Inbox,
  Landmark,
  Map as MapIcon,
  Palette,
  Rocket,
  Shield,
  Sparkles,
  Square,
  SquareCheck,
  SquareKanban,
  Target,
  Trash2,
  Zap,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { PersonaBadge } from '../components/PersonaBadge';
import { ProviderMark } from '../components/ProviderMark';
import { useApi } from '../hooks/useApi';
import { useRuns } from '../hooks/liveData';

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity CLI',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  codex: 'OpenAI Codex',
  aider: 'Aider CLI',
};

export const MODEL_LABELS: Record<AgentModelId, string> = {
  auto: 'Auto (Match Persona Rank)',
  fable: 'Claude Fable (★5 Frontier)',
  opus: 'Claude Opus (★4 Flagship)',
  sonnet: 'Claude Sonnet (★3 Balanced)',
  haiku: 'Claude Haiku (★2 Fast)',
  argon: 'Antigravity Argon (★5 Frontier)',
  'gemini-pro': 'Gemini Pro (★5 / ★4 High)',
  'gemini-flash': 'Gemini Flash (★3 Balanced)',
  'gemini-flash-lite': 'Gemini Flash-Lite (★1 Fast)',
  o3: 'OpenAI o3 (★5 Frontier)',
  'gpt-4o': 'GPT-4o / 4.1 (★4 Flagship)',
  'o4-mini': 'OpenAI o4-mini (★3 Balanced)',
  'gpt-4o-mini': 'GPT-4o Mini (★2 Fast)',
};

const CATEGORY_META: Record<RoadmapCategory, { label: string; icon: ReactNode }> = {
  feature: { label: 'Feature', icon: <Rocket className="icon" aria-hidden /> },
  ui_ux: { label: 'UI/UX & Polish', icon: <Palette className="icon" aria-hidden /> },
  architecture: { label: 'Architecture', icon: <Construction className="icon" aria-hidden /> },
  performance: { label: 'Performance', icon: <Zap className="icon" aria-hidden /> },
  qa_security: { label: 'QA & Security', icon: <Shield className="icon" aria-hidden /> },
};

export function AgentModelBadge({ agent, model }: { agent: AgentId; model: AgentModelId }) {
  const validModel = coerceModelForProvider(agent, model);
  const modelInfo = getModelInfoForProvider(agent, validModel);
  const prov = PROVIDER_REGISTRY[agent] ?? PROVIDER_REGISTRY.claude;

  const color =
    modelInfo?.rank === 5
      ? 'var(--warn)'
      : modelInfo?.rank === 4
        ? 'var(--accent)'
        : modelInfo?.rank === 3
          ? 'var(--info)'
          : 'var(--ok)';

  return (
    <span
      className="badge mono"
      style={{
        fontSize: '0.7rem',
        color,
        borderColor: 'var(--border)',
        background: 'var(--bg)',
      }}
      title={`Routed to ${prov.label} · Model: ${modelInfo ? `${modelInfo.label} (Rank ${modelInfo.rank}/5)` : validModel}`}
    >
      <ProviderMark id={prov.id} />
      {prov.shortLabel.toLowerCase()}
      {validModel && validModel !== 'auto'
        ? ` · ${modelInfo ? `★${modelInfo.rank} ${modelInfo.shortLabel}` : validModel}`
        : ''}
    </span>
  );
}

export function RouteBadgeSelect({
  agent,
  model,
  persona,
  enabledProviders,
  disabled,
  onChange,
}: {
  agent: AgentId;
  model: AgentModelId;
  persona?: AgentPersona;
  enabledProviders?: AgentId[];
  disabled?: boolean;
  onChange: (nextAgent: AgentId, nextModel: AgentModelId) => void;
}) {
  const activeProviders: AgentId[] =
    enabledProviders && enabledProviders.length > 0 ? enabledProviders : ['claude'];
  const effectiveAgent: AgentId = activeProviders.includes(agent)
    ? agent
    : (activeProviders[0] ?? 'claude');
  const effectiveModel: AgentModelId = coerceModelForProvider(effectiveAgent, model, persona);
  const providerEntry = PROVIDER_REGISTRY[effectiveAgent] ?? PROVIDER_REGISTRY.claude;
  const scopedModels = getModelsForProvider(effectiveAgent);
  const modelInfo = getModelInfoForProvider(effectiveAgent, effectiveModel);

  const color =
    modelInfo?.rank === 5
      ? 'var(--warn)'
      : modelInfo?.rank === 4
        ? 'var(--accent)'
        : modelInfo?.rank === 3
          ? 'var(--info)'
          : 'var(--ok)';

  const handleAgentChange = (nextAgent: AgentId) => {
    const nextModel = coerceModelForProvider(nextAgent, effectiveModel, persona);
    onChange(nextAgent, nextModel);
  };

  return (
    <span
      className="badge mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        fontSize: '0.7rem',
        color,
        borderColor: 'var(--border)',
        background: 'var(--bg)',
      }}
      title={`Route: ${providerEntry.label} · ${modelInfo ? `${modelInfo.label} (★${modelInfo.rank}/5 · ${modelInfo.tier.toUpperCase()})` : effectiveModel}`}
    >
      {activeProviders.length <= 1 ? (
        <span style={{ padding: '1px 2px' }}>
          <ProviderMark id={providerEntry.id} />
          {providerEntry.shortLabel.toLowerCase()}
        </span>
      ) : (
        <select
          aria-label="Preferred Agent"
          disabled={disabled}
          value={effectiveAgent}
          onChange={(e) => handleAgentChange(e.target.value as AgentId)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: '1px 2px',
            outline: 'none',
          }}
        >
          {activeProviders.map((provId) => {
            const p = PROVIDER_REGISTRY[provId];
            return (
              <option
                key={provId}
                value={provId}
                style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}
              >
                {p.shortLabel.toLowerCase()}
              </option>
            );
          })}
        </select>
      )}
      <span style={{ opacity: 0.6 }}>·</span>
      <select
        aria-label="Preferred Model"
        disabled={disabled}
        value={effectiveModel}
        onChange={(e) => onChange(effectiveAgent, e.target.value as AgentModelId)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          padding: '1px 2px',
          outline: 'none',
        }}
      >
        {scopedModels.map((m) => (
          <option
            key={m.id}
            value={m.id}
            style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}
          >
            ★{m.rank} {m.shortLabel}
          </option>
        ))}
        <option value="auto" style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}>
          auto
        </option>
      </select>
    </span>
  );
}

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
    if (roadmapPoll.data) {
      setLocalRoadmap(roadmapPoll.data);
    }
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

  // Smart 1-line Quick-Add state (replaces tedious multi-field forms)
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddTarget, setQuickAddTarget] = useState<string>('auto');
  const [inlineMsInputs, setInlineMsInputs] = useState<Record<string, string>>({});

  const project = useMemo(
    () => projects.data?.find((p) => p.id === projectId),
    [projects.data, projectId],
  );
  const roadmap = localRoadmap ?? roadmapPoll.data;

  const filteredSuggestions = useMemo(() => {
    const list = roadmap?.suggestions ?? [];
    if (categoryFilter === 'all') return list;
    return list.filter((s) => s.category === categoryFilter);
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

  const isAgentBrainstorming = Boolean(activeBrainstormRun || pendingBrainstormRunId);

  const handleBrainstorm = async (mode: 'instant' | 'agent') => {
    if (busy !== null) return;
    if (mode === 'agent' && isAgentBrainstorming) return;
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
      if (elapsed < 550) {
        await new Promise((r) => setTimeout(r, 550 - elapsed));
      }
      setLocalRoadmap(res.roadmap);
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
      setLocalRoadmap(res.roadmap);
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
        // Only add to roadmap milestone without creating a ticket yet
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
        // Dismiss from suggestions list
        const afterDelete = await api<ProjectRoadmapState>(
          `/api/projects/${projectId}/roadmap/items/${sug.id}`,
          'DELETE',
        );
        setLocalRoadmap(afterDelete ?? next);
        setBanner(`Added "${sug.title}" to Milestone ${targetMs?.code ?? 'M2'}.`);
      } else {
        const res = await api<DispatchRoadmapItemsResponse>(
          `/api/projects/${projectId}/roadmap/dispatch`,
          'POST',
          {
            suggestionIds: [sug.id],
            autoStart: true,
          },
        );
        setLocalRoadmap(res.roadmap);
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
    // Optimistically update localRoadmap so dropdowns respond immediately
    setLocalRoadmap((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        suggestions: prev.suggestions.map((s) =>
          s.id === id ? { ...s, preferredAgent, preferredModel } : s,
        ),
        milestones: prev.milestones.map((m) => ({
          ...m,
          items: m.items.map((it) =>
            it.id === id ? { ...it, preferredAgent, preferredModel } : it,
          ),
        })),
      };
    });
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/items/${id}`,
        'PATCH',
        { preferredAgent, preferredModel },
      );
      setLocalRoadmap(next);
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
        {
          suggestionIds: filteredSuggestions.map((s) => s.id),
          autoStart: true,
        },
      );
      setLocalRoadmap(res.roadmap);
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

  const handleToggleSelectAllSuggestions = () => {
    const visibleIds = filteredSuggestions.map((s) => s.id);
    if (visibleIds.length === 0) return;
    const allSelected = visibleIds.every((id) => selectedSuggestions.has(id));
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const handleDismissSuggestion = async (sugId: string) => {
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/items/${sugId}`,
        'DELETE',
      );
      setLocalRoadmap(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleClearAllSuggestions = async () => {
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/items/__all_suggestions__`,
        'DELETE',
      );
      setLocalRoadmap(next);
      setSelectedSuggestions(new Set());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleToggleItemDone = async (item: RoadmapItem) => {
    const nextStatus = item.status === 'done' ? 'planned' : 'done';
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/items/${item.id}`,
        'PATCH',
        { status: nextStatus },
      );
      setLocalRoadmap(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/items/${itemId}`,
        'DELETE',
      );
      setLocalRoadmap(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleDispatchSingleItem = async (itemId: string) => {
    setBusy(`item-${itemId}`);
    setError(null);
    try {
      const res = await api<DispatchRoadmapItemsResponse>(
        `/api/projects/${projectId}/roadmap/dispatch`,
        'POST',
        {
          itemIds: [itemId],
          autoStart: true,
        },
      );
      setLocalRoadmap(res.roadmap);
      setBanner(
        `Dispatched item to Kanban Board (${res.createdTickets[0]?.key ?? 'ready'}) and started autonomous execution!`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleAutoGenerateRoadmap = async (mode: 'instant' | 'agent') => {
    if (busy !== null) return;
    if (mode === 'agent' && isAgentBrainstorming) return;
    setBusy(mode === 'agent' ? 'autogen-agent' : 'autogen-instant');
    setError(null);
    setBanner(null);
    try {
      const res = await api<AutoGenerateRoadmapResponse>(
        `/api/projects/${projectId}/roadmap/auto-generate`,
        'POST',
        {
          mode,
          instructions: quickAddText.trim() || brainstormFocus.trim(),
        },
      );
      setLocalRoadmap(res.roadmap);
      if (mode === 'agent' && res.agentRun) {
        setPendingBrainstormRunId(res.agentRun.id);
        setBanner(
          `System Architect (${res.agentRun.agent}) is inspecting ${project?.name ?? 'the repository'} to generate a tailored milestone roadmap…`,
        );
      } else {
        setBanner(
          `Auto-generated project-tailored milestones & tasks from PROJECT.md and repository context!`,
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
        const next = await api<ProjectRoadmapState>(
          `/api/projects/${projectId}/roadmap/milestones`,
          'POST',
          {
            title: raw,
          },
        );
        setLocalRoadmap(next);
        setQuickAddText('');
        setQuickAddTarget('auto');
        setBanner(`Created new milestone "${raw}".`);
      } else {
        const next = await api<ProjectRoadmapState>(
          `/api/projects/${projectId}/roadmap/items`,
          'POST',
          {
            milestoneId: quickAddTarget || 'auto',
            title: raw,
          },
        );
        setLocalRoadmap(next);
        setQuickAddText('');
        setBanner(
          `Auto-routed "${raw}" to the right milestone, specialist persona & AI model!`,
        );
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
      setLocalRoadmap(next);
      setInlineMsInputs((prev) => ({ ...prev, [msId]: '' }));
      setBanner(`Added "${raw}" to ${msCode} (auto-assigned specialist & model).`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteMilestone = async (msId: string, msCode: string) => {
    setBusy(`del-ms-${msId}`);
    setError(null);
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/milestones/${msId}`,
        'DELETE',
      );
      setLocalRoadmap(next);
      setBanner(`Removed milestone ${msCode} (any remaining items were preserved).`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!roadmap) {
    return (
      <section className="panel" aria-busy="true">
        <p className="muted">Loading Interactive Roadmap &amp; AI Brainstorming Studio…</p>
      </section>
    );
  }

  const totalSelected = selectedSuggestions.size + selectedItems.size;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top Header & Progress Bar */}
      <section className="panel" style={{ padding: '14px 16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
                <Target className="icon" aria-hidden /> {project?.name ?? 'Project'} — Roadmap, Milestones &amp; AI Brainstorming Studio
              </h2>
              <span className="badge mono">
                {roadmap.completedItems}/{roadmap.totalItems} completed ({roadmap.completionPercent}%)
              </span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: '0.82rem', maxWidth: 820 }}>
              {roadmap.visionSummary}
            </p>
          </div>

          <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              id="roadmap-autogen-instant-btn"
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void handleAutoGenerateRoadmap('instant')}
              title="Automatically synthesize domain-tailored milestones & roadmap tasks from PROJECT.md and codebase"
            >
              {busy === 'autogen-instant' ? (
                'Generating…'
              ) : (
                <>
                  <Sparkles className="icon" aria-hidden /> Auto-Generate Roadmap
                </>
              )}
            </button>
            <button
              id="roadmap-autogen-agent-btn"
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null || isAgentBrainstorming}
              onClick={() => void handleAutoGenerateRoadmap('agent')}
              title="Dispatch the System Architect agent to inspect the repository and generate a full custom milestone roadmap"
            >
              {busy === 'autogen-agent' ? (
                'Launching…'
              ) : isAgentBrainstorming ? (
                <>
                  <Landmark className="icon" aria-hidden /> Architect Working…
                </>
              ) : (
                <>
                  <Bot className="icon" aria-hidden /> AI Architect Roadmap
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => navigate(`/projects/${projectId}/board`)}
            >
              <SquareKanban className="icon" aria-hidden /> Open Kanban Board
            </button>
          </div>
        </div>

        {/* Overall Progress Bar + Milestone Quick Pills */}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              width: '100%',
              height: 8,
              borderRadius: 999,
              background: 'var(--bg)',
              overflow: 'hidden',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: `${roadmap.completionPercent}%`,
                height: '100%',
                background: 'var(--ok)',
                transition: 'width 250ms ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {roadmap.milestones.map((ms) => {
              const doneCount = ms.items.filter((i) => i.status === 'done').length;
              return (
                <span
                  key={ms.id}
                  className="badge mono"
                  style={{
                    fontSize: '0.73rem',
                    borderColor:
                      ms.status === 'completed'
                        ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                        : ms.status === 'active'
                          ? 'var(--accent)'
                          : 'var(--border)',
                    color:
                      ms.status === 'completed'
                        ? 'var(--ok)'
                        : ms.status === 'active'
                          ? 'var(--text)'
                          : 'var(--muted)',
                  }}
                >
                  {ms.status === 'completed' ? '✓ ' : ms.status === 'active' ? '● ' : '○ '}
                  {ms.code}: {ms.title} ({doneCount}/{ms.items.length})
                </span>
              );
            })}
          </div>
        </div>

        {/* Smart 1-Line Quick-Add Bar (Auto-Routes Milestone, Persona & Model) */}
        <form
          onSubmit={(e) => void handleSmartQuickAdd(e)}
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 10px',
            borderRadius: 'var(--radius)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
          }}
        >
          <select
            aria-label="Quick Add Target"
            className="input mono"
            style={{ width: 230, fontSize: '0.78rem', padding: '6px 8px' }}
            value={quickAddTarget}
            onChange={(e) => setQuickAddTarget(e.target.value)}
            title="Choose where to add: Smart Auto-Route automatically selects the milestone, specialist persona, and model!"
          >
            <option value="auto">Smart Auto-Route (Recommended)</option>
            {roadmap.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} — {m.title.slice(0, 32)}
              </option>
            ))}
            <option value="__new_milestone__">Create as New Milestone Phase</option>
          </select>
          <input
            id="roadmap-quick-add-input"
            className="input grow"
            style={{ minWidth: 240 }}
            placeholder={
              quickAddTarget === '__new_milestone__'
                ? 'Type new milestone title (e.g. "Multiplayer & Cloud Sync") and press Enter…'
                : 'Type any feature or task in plain language and press Enter — AI auto-assigns Milestone, Persona & Model…'
            }
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={busy !== null || !quickAddText.trim()}
          >
            {busy === 'quick-add'
              ? 'Adding…'
              : quickAddTarget === '__new_milestone__'
                ? '+ Add Milestone'
                : '+ Quick Add'}
          </button>
        </form>

        {/* Multi-Select Batch Action Bar */}
        {totalSelected > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              background: 'color-mix(in srgb, var(--ember-1) 10%, transparent)',
              border: '1px solid var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span className="mono" style={{ fontSize: '0.82rem', fontWeight: 600 }}>
              <SquareCheck className="icon" aria-hidden /> {totalSelected} selected ({selectedSuggestions.size} suggestion
              {selectedSuggestions.size === 1 ? '' : 's'}, {selectedItems.size} roadmap item
              {selectedItems.size === 1 ? '' : 's'})
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setSelectedSuggestions(new Set());
                  setSelectedItems(new Set());
                }}
              >
                Clear Selection
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void handleDispatchSelected(false)}
              >
                <Inbox className="icon" aria-hidden /> Create Ready Tickets on Board
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() => void handleDispatchSelected(true)}
              >
                {busy === 'dispatch-run' ? (
                  'Dispatching…'
                ) : (
                  <>
                    <Rocket className="icon" aria-hidden /> Create Tickets &amp; Auto-Dispatch Multi-Agent Pipeline
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {banner && (
          <div className="banner" style={{ marginTop: 10 }}>
            {banner}
          </div>
        )}
        {error && (
          <div className="banner banner-error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </section>

      {/* Main Studio Grid: Left = AI Brainstorming Studio, Right = Interactive Milestones */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))',
          gap: 14,
          alignItems: 'start',
        }}
      >
        {/* LEFT COLUMN: AI Brainstorming & Feature Suggestions */}
        <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <header className="panel-head" style={{ marginBottom: 0 }}>
            <div>
              <h2><Brain className="icon" aria-hidden /> AI Brainstorming &amp; Feature Suggestions</h2>
              <p className="muted">
                Explore what to build next, customize each idea&apos;s CLI agent &amp; model route inline, or launch all ideas at once.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="badge mono">{filteredSuggestions.length} ideas</span>
              {filteredSuggestions.length > 0 && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ fontSize: '0.74rem', padding: '3px 8px' }}
                    onClick={handleToggleSelectAllSuggestions}
                    title="Select or deselect all visible brainstorming suggestions"
                  >
                    {filteredSuggestions.every((s) => selectedSuggestions.has(s.id)) ? (
                      <>
                        <Square className="icon" aria-hidden /> Deselect All
                      </>
                    ) : (
                      <>
                        <SquareCheck className="icon" aria-hidden /> Select All
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ fontSize: '0.74rem', padding: '3px 8px' }}
                    disabled={busy !== null}
                    onClick={() => void handleClearAllSuggestions()}
                    title="Clear all current brainstorming suggestions"
                  >
                    <Trash2 className="icon" aria-hidden /> Clear
                  </button>
                  <button
                    id="brainstorm-build-all-btn"
                    type="button"
                    className="btn btn-sm btn-primary"
                    style={{ fontSize: '0.74rem', padding: '3px 10px' }}
                    disabled={busy !== null}
                    onClick={() => void handleBuildAllSuggestions()}
                    title="Create Kanban tickets for all visible suggestions and start autonomous execution"
                  >
                    {busy === 'build-all-suggestions' ? (
                      'Starting All…'
                    ) : (
                      <>
                        <Rocket className="icon" aria-hidden /> Build All ({filteredSuggestions.length})
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </header>

          {/* Interactive Brainstorm Prompt Box */}
          <div
            style={{
              padding: 10,
              borderRadius: 'var(--radius)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <input
              id="brainstorm-focus-input"
              className="input"
              placeholder="Optional brainstorm focus (leave empty for general project analysis, or type a topic and press Enter)…"
              value={brainstormFocus}
              onChange={(e) => setBrainstormFocus(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleBrainstorm('instant');
                }
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div className="segmented" style={{ fontSize: '0.74rem' }}>
                <button
                  type="button"
                  className={categoryFilter === 'all' ? 'active' : ''}
                  onClick={() => setCategoryFilter('all')}
                >
                  All
                </button>
                {(Object.keys(CATEGORY_META) as RoadmapCategory[]).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={categoryFilter === cat ? 'active' : ''}
                    onClick={() => setCategoryFilter(cat)}
                  >
                    {CATEGORY_META[cat].icon} {CATEGORY_META[cat].label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  id="brainstorm-instant-btn"
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void handleBrainstorm('instant')}
                  title="Analyze PROJECT.md & project domain to synthesize instant suggestions"
                >
                  {busy === 'brainstorm-instant' ? (
                    'Synthesizing…'
                  ) : (
                    <>
                      <Zap className="icon" aria-hidden /> Synthesize Ideas
                    </>
                  )}
                </button>
                <button
                  id="brainstorm-agent-btn"
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy !== null || isAgentBrainstorming}
                  onClick={() => void handleBrainstorm('agent')}
                  title={
                    isAgentBrainstorming
                      ? 'A Deep Brainstorming Agent is already running for this project'
                      : 'Launch a Product Owner (Claude Fable) agent to deeply inspect the codebase and write new suggestions'
                  }
                >
                  {busy === 'brainstorm-agent' ? (
                    'Launching…'
                  ) : isAgentBrainstorming ? (
                    <>
                      <Brain className="icon" aria-hidden /> Brainstorming in Progress…
                    </>
                  ) : (
                    <>
                      <Bot className="icon" aria-hidden /> Deep Agent Brainstorm
                    </>
                  )}
                </button>
              </div>
            </div>

            {activeBrainstormRun && (
              <div
                style={{
                  marginTop: 4,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius)',
                  background: 'color-mix(in srgb, var(--violet) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--violet) 40%, transparent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: '0.78rem',
                }}
              >
                <span className="mono">
                  <span className="dot run-working" style={{ marginRight: 6 }} />
                  Deep Brainstorming Agent ({activeBrainstormRun.agent} · fable) is inspecting the repository…
                </span>
                {activeBrainstormRun.terminalId && (
                  <Link
                    href={`/terminals/${activeBrainstormRun.terminalId}`}
                    className="btn btn-sm btn-ghost mono"
                    style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                  >
                    View Terminal →
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Brainstorm Suggestion Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filteredSuggestions.map((sug) => {
              const checked = selectedSuggestions.has(sug.id);
              const cat = CATEGORY_META[sug.category] ?? CATEGORY_META.feature;
              return (
                <div
                  key={sug.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 'var(--radius)',
                    background: checked ? 'color-mix(in srgb, var(--ember-1) 8%, transparent)' : 'var(--bg-elevated)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '0.88rem',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSuggestion(sug.id)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        {cat.icon} {sug.title}
                      </span>
                    </label>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Dismiss suggestion"
                      onClick={() => void handleDismissSuggestion(sug.id)}
                    >
                      ×
                    </button>
                  </div>

                  <p className="muted" style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.45 }}>
                    {sug.rationale}
                  </p>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                      paddingTop: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                        Target: {sug.suggestedMilestoneCode}
                      </span>
                      <PersonaBadge persona={sug.persona} />
                      <RouteBadgeSelect
                        agent={sug.preferredAgent}
                        model={sug.preferredModel}
                        persona={sug.persona}
                        enabledProviders={enabledProviders}
                        disabled={busy !== null}
                        onChange={(nextAgent, nextModel) =>
                          void handleChangeRoute(sug.id, nextAgent, nextModel)
                        }
                      />
                      <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                        Impact: {sug.impact.toUpperCase()}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy !== null}
                        onClick={() => void handleQuickPromoteSuggestion(sug, false)}
                        title={`Add to Milestone ${sug.suggestedMilestoneCode} without starting a run yet`}
                      >
                        + Add to {sug.suggestedMilestoneCode}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy !== null}
                        onClick={() => void handleQuickPromoteSuggestion(sug, true)}
                        title="Add to Roadmap, create Kanban ticket, and start the specialist agent immediately"
                      >
                        {busy === `sug-${sug.id}` ? (
                          'Starting…'
                        ) : (
                          <>
                            <Rocket className="icon" aria-hidden /> Build Now
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredSuggestions.length === 0 && (
              <div
                style={{
                  textAlign: 'center',
                  padding: '24px 16px',
                  borderRadius: 'var(--radius)',
                  border: '1px dashed var(--border)',
                  background: 'var(--bg)',
                }}
              >
                {isAgentBrainstorming ? (
                  <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
                    <Brain className="icon" aria-hidden /> <strong>Deep Brainstorming Agent</strong> is analyzing <strong>{project?.name ?? 'this project'}</strong>…
                    Tailored suggestions will automatically appear here as soon as analysis finishes.
                  </p>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
                    Brainstorming list is empty. Click <strong><Bot className="icon" aria-hidden /> Deep Agent Brainstorm</strong> (for full AI codebase analysis)
                    or <strong><Zap className="icon" aria-hidden /> Synthesize Ideas</strong> above to populate suggestions tailored to{' '}
                    <strong>{project?.name ?? 'this project'}</strong>.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN: Interactive Milestones & Roadmap Checklist */}
        <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <header className="panel-head" style={{ marginBottom: 0 }}>
            <div>
              <h2><MapIcon className="icon" aria-hidden /> Project Milestones &amp; Roadmap</h2>
              <p className="muted">
                Track milestone delivery, check off completed items, or dispatch any roadmap item to the Kanban board.
              </p>
            </div>
            <span className="badge mono">{roadmap.milestones.length} milestones</span>
          </header>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {roadmap.milestones.map((ms) => {
              const doneCount = ms.items.filter((i) => i.status === 'done').length;
              const pct = ms.items.length > 0 ? Math.round((doneCount / ms.items.length) * 100) : 0;
              const undispatchedIds = ms.items.filter((i) => i.status !== 'done').map((i) => i.id);

              return (
                <div
                  key={ms.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 'var(--radius)',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge mono" style={{ fontWeight: 700 }}>
                          {ms.code}
                        </span>
                        <strong style={{ fontSize: '0.92rem' }}>{ms.title}</strong>
                        <span className="muted mono" style={{ fontSize: '0.75rem' }}>
                          {doneCount}/{ms.items.length} ({pct}%)
                        </span>
                      </div>
                      {ms.description && (
                        <p className="muted" style={{ margin: '3px 0 0', fontSize: '0.76rem' }}>
                          {ms.description}
                        </p>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {undispatchedIds.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy !== null}
                          onClick={async () => {
                            setBusy(`ms-${ms.id}`);
                            try {
                              const res = await api<DispatchRoadmapItemsResponse>(
                                `/api/projects/${projectId}/roadmap/dispatch`,
                                'POST',
                                {
                                  itemIds: undispatchedIds,
                                  autoStart: true,
                                },
                              );
                              setLocalRoadmap(res.roadmap);
                              setBanner(
                                `Dispatched Milestone ${ms.code} (${res.createdTickets.length} new ticket(s)) to the AI Coding Factory!`,
                              );
                            } catch (err) {
                              setError(errorMessage(err));
                            } finally {
                              setBusy(null);
                            }
                          }}
                          title={`Create Kanban tickets for all remaining items in ${ms.code} and start execution`}
                        >
                          {busy === `ms-${ms.id}` ? (
                            'Starting…'
                          ) : (
                            <>
                              <Rocket className="icon" aria-hidden /> Run {ms.code}
                            </>
                          )}
                        </button>
                      )}
                      {roadmap.milestones.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={busy !== null}
                          onClick={() => void handleDeleteMilestone(ms.id, ms.code)}
                          title={`Remove milestone ${ms.code}`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Milestone Progress Bar */}
                  <div
                    style={{
                      width: '100%',
                      height: 5,
                      borderRadius: 999,
                      background: 'var(--bg)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: pct === 100 ? 'var(--ok)' : 'var(--accent)',
                      }}
                    />
                  </div>

                  {/* Milestone Items */}
                  {ms.items.length === 0 ? (
                    <p className="muted small" style={{ margin: '2px 0' }}>
                      No items in {ms.code} yet. Click <strong><Sparkles className="icon" aria-hidden /> Auto-Generate Roadmap</strong> above, promote a brainstorm idea, or type below.
                    </p>
                  ) : (
                    <ul className="list" style={{ margin: 0 }}>
                      {ms.items.map((item) => {
                        const isDone = item.status === 'done';
                        const isChecked = selectedItems.has(item.id);
                        return (
                          <li
                            key={item.id}
                            className="row"
                            style={{
                              padding: '8px 10px',
                              opacity: isDone ? 0.72 : 1,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 200 }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleItem(item.id)}
                                title="Select for batch dispatch"
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost mono"
                                style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                                onClick={() => void handleToggleItemDone(item)}
                                title={isDone ? 'Mark as planned' : 'Mark as done'}
                              >
                                {isDone ? '✓ DONE' : item.status === 'in_progress' ? '● ACTIVE' : '○ TODO'}
                              </button>
                              <span
                                style={{
                                  fontSize: '0.84rem',
                                  fontWeight: 500,
                                  textDecoration: isDone ? 'line-through' : 'none',
                                }}
                              >
                                {item.title}
                              </span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <PersonaBadge persona={item.persona} />
                              <RouteBadgeSelect
                                agent={item.preferredAgent}
                                model={item.preferredModel}
                                persona={item.persona}
                                enabledProviders={enabledProviders}
                                disabled={busy !== null}
                                onChange={(nextAgent, nextModel) =>
                                  void handleChangeRoute(item.id, nextAgent, nextModel)
                                }
                              />
                              {item.ticketKey ? (
                                <Link
                                  href={`/projects/${projectId}/board`}
                                  className="badge mono"
                                  style={{ fontSize: '0.7rem', textDecoration: 'none' }}
                                  title="View linked ticket on Kanban Board"
                                >
                                  <SquareKanban className="icon" aria-hidden /> {item.ticketKey}
                                </Link>
                              ) : (
                                !isDone && (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                                    disabled={busy !== null}
                                    onClick={() => void handleDispatchSingleItem(item.id)}
                                    title="Create Kanban ticket and start specialist agent"
                                  >
                                    {busy === `item-${item.id}` ? (
                                      '…'
                                    ) : (
                                      <>
                                        <Rocket className="icon" aria-hidden /> Dispatch
                                      </>
                                    )}
                                  </button>
                                )
                              )}
                              <button
                                type="button"
                                className="icon-btn"
                                title="Remove from roadmap"
                                onClick={() => void handleDeleteItem(item.id)}
                              >
                                ×
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* Inline 1-Line Quick-Add Input inside Milestone Card */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                    <input
                      className="input"
                      style={{ flex: 1, fontSize: '0.78rem', padding: '5px 8px' }}
                      placeholder={`+ Add task to ${ms.code} and press Enter (auto-routes persona & model)…`}
                      value={inlineMsInputs[ms.id] ?? ''}
                      onChange={(e) =>
                        setInlineMsInputs((prev) => ({ ...prev, [ms.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleInlineMilestoneAdd(ms.id, ms.code);
                        }
                      }}
                    />
                    {(inlineMsInputs[ms.id] ?? '').trim() && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '4px 10px', fontSize: '0.74rem' }}
                        disabled={busy !== null}
                        onClick={() => void handleInlineMilestoneAdd(ms.id, ms.code)}
                      >
                        Add
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
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

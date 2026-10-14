import type {
  AgentId,
  AgentModelId,
  AgentPersona,
  BrainstormResponse,
  BrainstormSuggestion,
  DispatchRoadmapItemsResponse,
  Project,
  ProjectRoadmapState,
  RoadmapCategory,
  RoadmapItem,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { PersonaBadge, PersonaPicker } from '../components/PersonaBadge';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity CLI',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  codex: 'OpenAI Codex',
  aider: 'Aider CLI',
};

export const MODEL_LABELS: Record<AgentModelId, string> = {
  auto: 'Auto (Persona Default)',
  fable: 'Claude Fable (Deep Analysis)',
  opus: 'Claude Opus (Core Coding)',
  sonnet: 'Claude Sonnet (Fast / Low-Token)',
  haiku: 'Claude Haiku (Ultra-Light)',
  argon: 'Antigravity Argon (Frontend / UI)',
  'gemini-pro': 'Gemini 2.5 Pro',
  'gpt-4o': 'GPT-4o / Codex',
};

const CATEGORY_META: Record<RoadmapCategory, { label: string; icon: string }> = {
  feature: { label: 'Feature', icon: '🚀' },
  ui_ux: { label: 'UI/UX & Polish', icon: '🎨' },
  architecture: { label: 'Architecture', icon: '🏗' },
  performance: { label: 'Performance', icon: '⚡' },
  qa_security: { label: 'QA & Security', icon: '🛡' },
};

export function AgentModelBadge({ agent, model }: { agent: AgentId; model: AgentModelId }) {
  const isAntigravity = agent === 'antigravity' || model === 'argon';
  const isCopilot = agent === 'copilot';
  const isFable = model === 'fable';
  const isSonnet = model === 'sonnet' || model === 'haiku';

  const color = isAntigravity
    ? '#38bdf8'
    : isCopilot
      ? '#a78bfa'
      : isFable
        ? '#f59e0b'
        : isSonnet
          ? '#34d399'
          : 'var(--accent)';

  return (
    <span
      className="badge mono"
      style={{
        fontSize: '0.7rem',
        color,
        borderColor: 'var(--border)',
        background: 'var(--bg)',
      }}
      title={`Routed to ${AGENT_LABELS[agent] ?? agent} · Model: ${MODEL_LABELS[model] ?? model}`}
    >
      {agent === 'antigravity' ? '⚡ agy' : agent === 'copilot' ? '🤖 copilot' : `✦ ${agent}`}
      {model && model !== 'auto' ? ` · ${model}` : ''}
    </span>
  );
}

const COMPACT_AGENT_OPTIONS: Array<{ id: AgentId; short: string }> = [
  { id: 'claude', short: '✦ claude' },
  { id: 'antigravity', short: '⚡ agy' },
  { id: 'copilot', short: '🤖 copilot' },
  { id: 'gemini', short: '✦ gemini' },
  { id: 'codex', short: '✦ codex' },
  { id: 'aider', short: '✦ aider' },
];

const COMPACT_MODEL_OPTIONS: Array<{ id: AgentModelId; short: string }> = [
  { id: 'opus', short: 'opus' },
  { id: 'sonnet', short: 'sonnet' },
  { id: 'fable', short: 'fable' },
  { id: 'haiku', short: 'haiku' },
  { id: 'argon', short: 'argon' },
  { id: 'gemini-pro', short: 'gemini-pro' },
  { id: 'gpt-4o', short: 'gpt-4o' },
  { id: 'auto', short: 'auto' },
];

export function RouteBadgeSelect({
  agent,
  model,
  disabled,
  onChange,
}: {
  agent: AgentId;
  model: AgentModelId;
  disabled?: boolean;
  onChange: (nextAgent: AgentId, nextModel: AgentModelId) => void;
}) {
  const isAntigravity = agent === 'antigravity' || model === 'argon';
  const isCopilot = agent === 'copilot';
  const isFable = model === 'fable';
  const isSonnet = model === 'sonnet' || model === 'haiku';

  const color = isAntigravity
    ? '#38bdf8'
    : isCopilot
      ? '#a78bfa'
      : isFable
        ? '#f59e0b'
        : isSonnet
          ? '#34d399'
          : 'var(--accent)';

  const handleAgentChange = (nextAgent: AgentId) => {
    let nextModel = model;
    if (nextAgent === 'claude' && (model === 'argon' || model === 'gemini-pro' || model === 'gpt-4o')) {
      nextModel = 'opus';
    } else if (nextAgent === 'antigravity' && model !== 'argon') {
      nextModel = 'argon';
    } else if (nextAgent === 'gemini' && model !== 'gemini-pro') {
      nextModel = 'gemini-pro';
    } else if ((nextAgent === 'codex' || nextAgent === 'copilot') && model !== 'gpt-4o') {
      nextModel = 'gpt-4o';
    }
    onChange(nextAgent, nextModel);
  };

  return (
    <span
      className="badge mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '1px 6px',
        fontSize: '0.7rem',
        color,
        borderColor: 'var(--border)',
        background: 'var(--bg)',
      }}
      title={`Click to change route (${AGENT_LABELS[agent] ?? agent} · ${MODEL_LABELS[model] ?? model})`}
    >
      <select
        aria-label="Preferred Agent"
        disabled={disabled}
        value={agent}
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
        {COMPACT_AGENT_OPTIONS.map((a) => (
          <option key={a.id} value={a.id} style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}>
            {a.short}
          </option>
        ))}
      </select>
      <span style={{ opacity: 0.6 }}>·</span>
      <select
        aria-label="Preferred Model"
        disabled={disabled}
        value={model}
        onChange={(e) => onChange(agent, e.target.value as AgentModelId)}
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
        {COMPACT_MODEL_OPTIONS.map((m) => (
          <option key={m.id} value={m.id} style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}>
            {m.short}
          </option>
        ))}
      </select>
    </span>
  );
}

export function RoadmapStudioPanel({ projectId }: { projectId: string }) {
  const [, navigate] = useLocation();
  const projects = usePoll(() => api<Project[]>('/api/projects'), 15_000);
  const roadmapPoll = usePoll(() => api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap`), 6_000);
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

  // Add Item Form state
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemMilestoneId, setNewItemMilestoneId] = useState('');
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<RoadmapCategory>('feature');
  const [newItemPersona, setNewItemPersona] = useState<AgentPersona>('coder');
  const [newItemAgent, setNewItemAgent] = useState<AgentId>('claude');
  const [newItemModel, setNewItemModel] = useState<AgentModelId>('opus');

  // Add Milestone Form state
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [newMsCode, setNewMsCode] = useState('');
  const [newMsTitle, setNewMsTitle] = useState('');
  const [newMsDesc, setNewMsDesc] = useState('');

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
          `🧠 Deep Brainstorming Agent (${res.agentRun.agent} · fable) is analyzing your codebase. New suggestions will appear automatically when it finishes.`,
        );
      } else {
        setBanner(
          `✨ Synthesized fresh codebase-aware feature & architecture suggestions${brainstormFocus.trim() ? ` for "${brainstormFocus.trim()}"` : ''}.`,
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
        `🚀 Created ${res.createdTickets.length} Kanban ticket(s)${res.startedRun ? ` and launched agent run (${res.startedRun.title ?? res.startedRun.id.slice(0, 8)})` : ''}!`,
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
        setBanner(`📌 Added "${sug.title}" to Milestone ${targetMs?.code ?? 'M2'}.`);
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
          `🚀 Added "${sug.title}" to Roadmap, created Ticket ${res.createdTickets[0]?.key ?? ''}, and dispatched ${sug.preferredAgent} (${sug.preferredModel})!`,
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
        `🚀 Promoted all ${res.createdTickets.length} Brainstorming idea(s) to the Roadmap & Kanban Board and started the autonomous multi-agent pipeline!`,
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
        `🚀 Dispatched item to Kanban Board (${res.createdTickets[0]?.key ?? 'ready'}) and started autonomous execution!`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCreateItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!newItemTitle.trim()) return;
    setBusy('create-item');
    setError(null);
    try {
      const targetMsId = newItemMilestoneId || roadmap?.milestones[0]?.id || 'M1';
      const next = await api<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap/items`, 'POST', {
        milestoneId: targetMsId,
        title: newItemTitle.trim(),
        description: newItemDesc.trim(),
        category: newItemCategory,
        persona: newItemPersona,
        preferredAgent: newItemAgent,
        preferredModel: newItemModel,
        priority: 2,
        status: 'planned',
      });
      setLocalRoadmap(next);
      setNewItemTitle('');
      setNewItemDesc('');
      setShowAddItem(false);
      setBanner(`✅ Added roadmap item "${newItemTitle.trim()}".`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleCreateMilestone = async (e: FormEvent) => {
    e.preventDefault();
    if (!newMsTitle.trim()) return;
    setBusy('create-ms');
    setError(null);
    try {
      const next = await api<ProjectRoadmapState>(
        `/api/projects/${projectId}/roadmap/milestones`,
        'POST',
        {
          code: newMsCode.trim() || undefined,
          title: newMsTitle.trim(),
          description: newMsDesc.trim(),
        },
      );
      setLocalRoadmap(next);
      setNewMsCode('');
      setNewMsTitle('');
      setNewMsDesc('');
      setShowAddMilestone(false);
      setBanner(`✅ Created milestone "${newMsTitle.trim()}".`);
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
                🎯 {project?.name ?? 'Project'} — Roadmap, Milestones &amp; AI Brainstorming Studio
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
              type="button"
              className="btn btn-sm"
              onClick={() => setShowAddMilestone((v) => !v)}
            >
              + New Milestone
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                if (!newItemMilestoneId && roadmap.milestones[0]) {
                  setNewItemMilestoneId(roadmap.milestones[0].id);
                }
                setShowAddItem((v) => !v);
              }}
            >
              + Add Roadmap Item
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => navigate(`/projects/${projectId}/board`)}
            >
              ▤ Open Kanban Board
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
                        ? 'rgba(63, 185, 80, 0.45)'
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

        {/* Multi-Select Batch Action Bar */}
        {totalSelected > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              background: 'rgba(249, 115, 22, 0.1)',
              border: '1px solid var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span className="mono" style={{ fontSize: '0.82rem', fontWeight: 600 }}>
              ☑ {totalSelected} selected ({selectedSuggestions.size} suggestion
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
                📥 Create Ready Tickets on Board
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() => void handleDispatchSelected(true)}
              >
                {busy === 'dispatch-run'
                  ? 'Dispatching…'
                  : '🚀 Create Tickets & Auto-Dispatch Multi-Agent Pipeline'}
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

        {/* Inline Add Milestone Form */}
        {showAddMilestone && (
          <form
            onSubmit={(e) => void handleCreateMilestone(e)}
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 'var(--radius)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <strong style={{ fontSize: '0.85rem' }}>Create New Milestone</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input mono"
                style={{ width: 90 }}
                placeholder="Code (e.g. M5)"
                value={newMsCode}
                onChange={(e) => setNewMsCode(e.target.value)}
              />
              <input
                className="input grow"
                placeholder="Milestone title (e.g. Multi-Tenant RBAC, Hardware I2C Protocol, or Production Hardening)"
                required
                value={newMsTitle}
                onChange={(e) => setNewMsTitle(e.target.value)}
              />
            </div>
            <input
              className="input"
              placeholder="Milestone description / delivery goal (optional)"
              value={newMsDesc}
              onChange={(e) => setNewMsDesc(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAddMilestone(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
                Save Milestone
              </button>
            </div>
          </form>
        )}

        {/* Inline Add Roadmap Item Form */}
        {showAddItem && (
          <form
            onSubmit={(e) => void handleCreateItem(e)}
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 'var(--radius)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <strong style={{ fontSize: '0.85rem' }}>Add Custom Feature / Roadmap Item</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 160px', gap: 8 }}>
              <select
                className="input"
                value={newItemMilestoneId}
                onChange={(e) => setNewItemMilestoneId(e.target.value)}
              >
                {roadmap.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} — {m.title}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Feature or milestone task title…"
                required
                value={newItemTitle}
                onChange={(e) => setNewItemTitle(e.target.value)}
              />
              <select
                className="input"
                value={newItemCategory}
                onChange={(e) => setNewItemCategory(e.target.value as RoadmapCategory)}
              >
                {Object.entries(CATEGORY_META).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.icon} {v.label}
                  </option>
                ))}
              </select>
            </div>

            <textarea
              className="input"
              rows={2}
              placeholder="Specification, acceptance criteria, or implementation notes…"
              value={newItemDesc}
              onChange={(e) => setNewItemDesc(e.target.value)}
            />

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="muted small mono">Specialist:</span>
                <PersonaPicker
                  compact
                  value={newItemPersona}
                  onChange={(p) => {
                    setNewItemPersona(p);
                    if (p === 'product_owner' || p === 'architect') {
                      setNewItemAgent('claude');
                      setNewItemModel('fable');
                    } else if (p === 'qa') {
                      setNewItemAgent('claude');
                      setNewItemModel('sonnet');
                    } else {
                      setNewItemAgent('claude');
                      setNewItemModel('opus');
                    }
                  }}
                />
                <select
                  className="input mono"
                  style={{ fontSize: '0.78rem', padding: '4px 8px' }}
                  value={newItemAgent}
                  onChange={(e) => setNewItemAgent(e.target.value as AgentId)}
                  title="Preferred CLI Agent"
                >
                  {(Object.keys(AGENT_LABELS) as AgentId[]).map((a) => (
                    <option key={a} value={a}>
                      {AGENT_LABELS[a]}
                    </option>
                  ))}
                </select>
                <select
                  className="input mono"
                  style={{ fontSize: '0.78rem', padding: '4px 8px' }}
                  value={newItemModel}
                  onChange={(e) => setNewItemModel(e.target.value as AgentModelId)}
                  title="Preferred Model Tier"
                >
                  {(Object.keys(MODEL_LABELS) as AgentModelId[]).map((m) => (
                    <option key={m} value={m}>
                      {MODEL_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAddItem(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
                  Add to Roadmap
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      {/* Main Studio Grid: Left = AI Brainstorming Studio, Right = Interactive Milestones */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
          gap: 14,
          alignItems: 'start',
        }}
      >
        {/* LEFT COLUMN: AI Brainstorming & Feature Suggestions */}
        <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <header className="panel-head" style={{ marginBottom: 0 }}>
            <div>
              <h2>🧠 AI Brainstorming &amp; Feature Suggestions</h2>
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
                    {filteredSuggestions.every((s) => selectedSuggestions.has(s.id))
                      ? '☐ Deselect All'
                      : '☑ Select All'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ fontSize: '0.74rem', padding: '3px 8px' }}
                    disabled={busy !== null}
                    onClick={() => void handleClearAllSuggestions()}
                    title="Clear all current brainstorming suggestions"
                  >
                    🗑 Clear
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
                    {busy === 'build-all-suggestions'
                      ? 'Starting All…'
                      : `🚀 Build All (${filteredSuggestions.length})`}
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
                  {busy === 'brainstorm-instant' ? 'Synthesizing…' : '⚡ Synthesize Ideas'}
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
                  {busy === 'brainstorm-agent'
                    ? 'Launching…'
                    : isAgentBrainstorming
                      ? '🧠 Brainstorming in Progress…'
                      : '🤖 Deep Agent Brainstorm'}
                </button>
              </div>
            </div>

            {activeBrainstormRun && (
              <div
                style={{
                  marginTop: 4,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius)',
                  background: 'rgba(168, 85, 247, 0.12)',
                  border: '1px solid rgba(168, 85, 247, 0.4)',
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
                    background: checked ? 'rgba(249, 115, 22, 0.08)' : 'var(--bg-elevated)',
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
                        {busy === `sug-${sug.id}` ? 'Starting…' : '🚀 Build Now'}
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
                    🧠 <strong>Deep Brainstorming Agent</strong> is analyzing <strong>{project?.name ?? 'this project'}</strong>…
                    Tailored suggestions will automatically appear here as soon as analysis finishes.
                  </p>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
                    Brainstorming list is empty. Click <strong>🤖 Deep Agent Brainstorm</strong> (for full AI codebase analysis)
                    or <strong>⚡ Synthesize Ideas</strong> above to populate suggestions tailored to{' '}
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
              <h2>🗺 Project Milestones &amp; Roadmap</h2>
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

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setNewItemMilestoneId(ms.id);
                          setShowAddItem(true);
                        }}
                      >
                        + Item
                      </button>
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
                                `🚀 Dispatched Milestone ${ms.code} (${res.createdTickets.length} new ticket(s)) to the AI Coding Factory!`,
                              );
                            } catch (err) {
                              setError(errorMessage(err));
                            } finally {
                              setBusy(null);
                            }
                          }}
                          title={`Create Kanban tickets for all remaining items in ${ms.code} and start execution`}
                        >
                          {busy === `ms-${ms.id}` ? 'Starting…' : `🚀 Run ${ms.code}`}
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
                    <p className="muted small" style={{ margin: '4px 0' }}>
                      No items in {ms.code} yet. Promote an AI suggestion from the left or click <strong>+ Item</strong>.
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
                                  ▤ {item.ticketKey}
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
                                    {busy === `item-${item.id}` ? '…' : '🚀 Dispatch'}
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

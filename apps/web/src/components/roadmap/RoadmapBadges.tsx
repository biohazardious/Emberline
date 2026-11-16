import {
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  coerceModelForProvider,
  getModelInfoForProvider,
  getModelsForProvider,
  PROVIDER_REGISTRY,
  type RoadmapCategory,
  type RoadmapItemStatus,
} from '@emberline/protocol';
import { Construction, Palette, Rocket, Shield, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { ProviderMark } from '../ProviderMark';
import './roadmap-ux.css';

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity CLI',
  copilot: 'Copilot CLI',
  codex: 'OpenAI Codex',
  aider: 'Aider CLI',
};

export const ROADMAP_STATUS_LABEL: Record<RoadmapItemStatus, string> = {
  idea: 'Idea',
  planned: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

export const ROADMAP_STATUS_MARK: Record<RoadmapItemStatus, string> = {
  idea: '◇',
  planned: '○',
  in_progress: '●',
  done: '✓',
};

export const ROADMAP_PRIORITY_LABEL: Record<number, string> = {
  0: 'Low',
  1: 'Normal',
  2: 'High',
  3: 'Urgent',
};

export const CATEGORY_META: Record<RoadmapCategory, { label: string; icon: ReactNode }> = {
  feature: { label: 'Feature', icon: <Rocket className="icon" aria-hidden="true" /> },
  ui_ux: { label: 'UI/UX', icon: <Palette className="icon" aria-hidden="true" /> },
  architecture: { label: 'Architecture', icon: <Construction className="icon" aria-hidden="true" /> },
  performance: { label: 'Performance', icon: <Zap className="icon" aria-hidden="true" /> },
  qa_security: { label: 'QA & security', icon: <Shield className="icon" aria-hidden="true" /> },
};

function rankClass(rank: number | undefined): string {
  if (rank === 5) return 'roadmap-rank-5';
  if (rank === 4) return 'roadmap-rank-4';
  if (rank === 3) return 'roadmap-rank-3';
  return 'roadmap-rank-default';
}

export function RoadmapPriorityBadge({ priority }: { priority: number }) {
  const label = ROADMAP_PRIORITY_LABEL[priority] ?? 'Normal';
  return <span className={`badge mono roadmap-priority-badge roadmap-priority-${priority}`}>{label}</span>;
}

export function RoadmapStateBadge({ status }: { status: RoadmapItemStatus }) {
  return (
    <span className={`badge mono roadmap-state-badge roadmap-state-${status}`}>
      <span aria-hidden="true">{ROADMAP_STATUS_MARK[status]}</span>
      <span>{ROADMAP_STATUS_LABEL[status]}</span>
    </span>
  );
}

export function AgentModelBadge({ agent, model }: { agent: AgentId; model: AgentModelId }) {
  const validModel = coerceModelForProvider(agent, model);
  const modelInfo = getModelInfoForProvider(agent, validModel);
  const prov = PROVIDER_REGISTRY[agent] ?? PROVIDER_REGISTRY.claude;

  return (
    <span className={`badge mono roadmap-agent-badge ${rankClass(modelInfo?.rank)}`}>
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
  const effectiveAgent: AgentId = activeProviders.includes(agent) ? agent : (activeProviders[0] ?? 'claude');
  const effectiveModel: AgentModelId = coerceModelForProvider(effectiveAgent, model, persona);
  const providerEntry = PROVIDER_REGISTRY[effectiveAgent] ?? PROVIDER_REGISTRY.claude;
  const scopedModels = getModelsForProvider(effectiveAgent);
  const modelInfo = getModelInfoForProvider(effectiveAgent, effectiveModel);

  const handleAgentChange = (nextAgent: AgentId) => {
    const nextModel = coerceModelForProvider(nextAgent, effectiveModel, persona);
    onChange(nextAgent, nextModel);
  };

  return (
    <span className={`badge mono roadmap-route-badge ${rankClass(modelInfo?.rank)}`}>
      {activeProviders.length <= 1 ? (
        <span className="roadmap-route-provider">
          <ProviderMark id={providerEntry.id} />
          {providerEntry.shortLabel.toLowerCase()}
        </span>
      ) : (
        <select
          aria-label="Preferred Agent"
          className="roadmap-route-select"
          disabled={disabled}
          value={effectiveAgent}
          onChange={(e) => handleAgentChange(e.target.value as AgentId)}
        >
          {activeProviders.map((provId) => {
            const p = PROVIDER_REGISTRY[provId];
            return (
              <option key={provId} value={provId} className="roadmap-route-option">
                {p.shortLabel.toLowerCase()}
              </option>
            );
          })}
        </select>
      )}
      <span className="roadmap-route-sep" aria-hidden="true">
        ·
      </span>
      <select
        aria-label="Preferred Model"
        className="roadmap-route-select"
        disabled={disabled}
        value={effectiveModel}
        onChange={(e) => onChange(effectiveAgent, e.target.value as AgentModelId)}
      >
        {scopedModels.map((m) => (
          <option key={m.id} value={m.id} className="roadmap-route-option">
            {`★${m.rank} ${m.shortLabel}`}
          </option>
        ))}
        <option value="auto" className="roadmap-route-option">
          auto
        </option>
      </select>
    </span>
  );
}

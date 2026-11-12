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

export const CATEGORY_META: Record<RoadmapCategory, { label: string; icon: ReactNode }> = {
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
  const effectiveAgent: AgentId = activeProviders.includes(agent) ? agent : (activeProviders[0] ?? 'claude');
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
          <option key={m.id} value={m.id} style={{ background: 'var(--bg-elevated)', color: 'var(--text)' }}>
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

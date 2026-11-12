import {
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  coerceModelForProvider,
  getModelInfoForProvider,
  getModelsForProvider,
  type Project,
  type ProjectRoadmapState,
  PROVIDER_REGISTRY,
  type RoadmapCategory,
  type RoadmapItemStatus,
} from '@emberline/protocol';
import { Construction, Palette, Rocket, Shield, Zap } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { ProviderMark } from '../ProviderMark';
import { ico } from '../SectionState';

export interface RoadmapStudioCtx {
  pid: string;
  base: string;
  proj: Project | undefined;
  rm: ProjectRoadmapState | undefined;
  load?: boolean;
  errObj?: unknown;
  retry?: () => Promise<void>;
  provs: AgentId[];
  busy: string | null;
  working: boolean;
  setRm: (next: ProjectRoadmapState) => void;
  onRun: (runId: string) => void;
  route: (id: string, agent: AgentId, model: AgentModelId) => void;
  banner: string | null;
  setBanner: (next: string | null) => void;
  err: string | null;
  task: (busyKey: string | null, fn: () => Promise<void>, clearBanner?: boolean) => Promise<void>;
}

export const RM_PANEL_COL: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
export const RM_COL_10: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
export const RM_ROW_WRAP6: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};
export const RM_ROW_WRAP8: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};
export const RM_ROW_BETWEEN: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
};
export const RM_HEAD_SPLIT: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};
export const RM_CARD_ELEV: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
export const RM_SUBBOX_ELEV: CSSProperties = {
  padding: 10,
  borderRadius: 'var(--radius)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
export const RM_BADGE_68: CSSProperties = { fontSize: '0.68rem' };

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
  feature: { label: 'Feature', icon: ico(Rocket) },
  ui_ux: { label: 'UI/UX & Polish', icon: ico(Palette) },
  architecture: { label: 'Architecture', icon: ico(Construction) },
  performance: { label: 'Performance', icon: ico(Zap) },
  qa_security: { label: 'QA & Security', icon: ico(Shield) },
};

function rankColor(rank: number | undefined): string {
  if (rank === 5) return 'var(--warn)';
  if (rank === 4) return 'var(--accent)';
  if (rank === 3) return 'var(--info)';
  return 'var(--ok)';
}

const OPTION_STYLE: CSSProperties = { background: 'var(--bg-elevated)', color: 'var(--text)' };

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

  const selectStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    font: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: '1px 2px',
    outline: 'none',
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
        color: rankColor(modelInfo?.rank),
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
          onChange={(e) => {
            const nextAgent = e.target.value as AgentId;
            onChange(nextAgent, coerceModelForProvider(nextAgent, effectiveModel, persona));
          }}
          style={selectStyle}
        >
          {activeProviders.map((provId) => (
            <option key={provId} value={provId} style={OPTION_STYLE}>
              {PROVIDER_REGISTRY[provId].shortLabel.toLowerCase()}
            </option>
          ))}
        </select>
      )}
      <span style={{ opacity: 0.6 }}>·</span>
      <select
        aria-label="Preferred Model"
        disabled={disabled}
        value={effectiveModel}
        onChange={(e) => onChange(effectiveAgent, e.target.value as AgentModelId)}
        style={selectStyle}
      >
        {scopedModels.map((m) => (
          <option key={m.id} value={m.id} style={OPTION_STYLE}>
            ★{m.rank} {m.shortLabel}
          </option>
        ))}
        <option value="auto" style={OPTION_STYLE}>
          auto
        </option>
      </select>
    </span>
  );
}

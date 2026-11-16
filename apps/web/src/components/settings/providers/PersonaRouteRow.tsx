import {
  type AgentId,
  type AgentPersona,
  type FactorySettings,
  formatRankStars,
  getModelInfoForProvider,
  type ModelCapabilityTag,
  type ModelCapabilityTier,
  PERSONA_CAPABILITY_TARGETS,
  PROVIDER_REGISTRY,
  type Route,
} from '@emberline/protocol';
import { Brain, ChevronRight, Laptop, type LucideIcon, Palette, Zap } from 'lucide-react';
import { useId } from 'react';
import { CREDENTIAL_LABEL, RouteChainEditor } from '../../RouteChainEditor';
import { ico } from '../../SectionState';
import './providers.css';

const CAPABILITY_TAG_META: Record<ModelCapabilityTag, { label: string; icon: LucideIcon }> = {
  reasoning: { label: 'Reasoning', icon: Brain },
  code: { label: 'Code', icon: Laptop },
  ui_ux: { label: 'UI/UX', icon: Palette },
  fast: { label: 'Fast', icon: Zap },
};

export interface PersonaRouteRowProps {
  personaKey: AgentPersona;
  label: string;
  shortLabel: string;
  chain: Route[];
  enabledProviders: AgentId[];
  settings: FactorySettings | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
  onChangeChain: (next: Route[]) => void;
  onSelectTier: (tier: ModelCapabilityTier) => void;
}

export function PersonaRouteRow({
  personaKey,
  label,
  shortLabel,
  chain,
  enabledProviders,
  settings,
  expanded,
  onToggleExpand,
  onChangeChain,
  onSelectTier,
}: PersonaRouteRowProps) {
  const detailsId = useId();
  const targetSpec = PERSONA_CAPABILITY_TARGETS[personaKey];
  const firstRoute = chain[0];
  const selectedAgent: AgentId = firstRoute?.agent ?? enabledProviders[0] ?? 'claude';
  const providerEntry = PROVIDER_REGISTRY[selectedAgent];
  const selectedModel = firstRoute?.model ?? 'auto';
  const selectedCredential = firstRoute?.credential ?? 'login';
  const modelInfo = getModelInfoForProvider(selectedAgent, selectedModel);
  const activeTier: ModelCapabilityTier = modelInfo?.tier ?? targetSpec.recommendedTier;
  const activeRank = modelInfo?.rank ?? targetSpec.recommendedRank;
  const fallbackCount = Math.max(0, chain.length - 1);

  const firstRouteSummary = `${providerEntry.shortLabel} · ${modelInfo?.shortLabel ?? selectedModel} · ${CREDENTIAL_LABEL[selectedCredential]}`;

  return (
    <div className="persona-route-row" data-persona-row={personaKey}>
      <div className="persona-route-row-main">
        <div className="persona-route-identity">
          <strong className="persona-route-name">{label}</strong>
          <span className="badge mono">{shortLabel}</span>
        </div>

        <div className="persona-route-summary">
          <span className="persona-route-first mono">{firstRouteSummary}</span>
          {fallbackCount > 0 && (
            <span className="persona-route-fallbacks mono">
              +{fallbackCount} {fallbackCount === 1 ? 'fallback' : 'fallbacks'}
            </span>
          )}
        </div>

        <div className="persona-route-controls">
          <span className={`badge mono persona-tier-pill persona-tier-${activeTier}`}>
            {formatRankStars(activeRank)} · {activeTier}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${label} routing`}
            onClick={onToggleExpand}
          >
            <ChevronRight
              className={`icon ui-disclosure-chevron${expanded ? ' ui-disclosure-chevron-open' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div id={detailsId} className="persona-route-details">
          <p className="muted persona-target-summary">{targetSpec.summary}</p>

          <RouteChainEditor
            persona={personaKey}
            value={chain}
            onChange={onChangeChain}
            enabledProviders={enabledProviders}
            keyConfigured={{
              claude: Boolean(settings?.anthropicKeyStored),
              codex: Boolean(settings?.openaiKeyStored),
              aider: Boolean(
                settings?.anthropicKeyStored || settings?.openaiKeyStored || settings?.geminiKeyStored,
              ),
            }}
          />

          <div className="persona-tier-bar">
            <span className="muted mono persona-tier-target">Target ★{targetSpec.recommendedRank}</span>
            <div className="segmented" role="radiogroup" aria-label={`${label} tier`}>
              {(['low', 'medium', 'high'] as const).map((tierKey) => {
                const isCurrentTier = activeTier === tierKey && selectedModel !== 'auto';
                const tierLabel = tierKey === 'low' ? 'Low' : tierKey === 'medium' ? 'Medium' : 'High';
                return (
                  <button
                    key={tierKey}
                    type="button"
                    role="radio"
                    aria-checked={isCurrentTier}
                    className={isCurrentTier ? 'active' : ''}
                    onClick={() => onSelectTier(tierKey)}
                  >
                    {tierLabel}
                  </button>
                );
              })}
            </div>
          </div>

          {modelInfo && (
            <div className="persona-model-meta">
              <div className="persona-model-tags">
                {modelInfo.capabilities.map((cap) => {
                  const cMeta = CAPABILITY_TAG_META[cap];
                  return (
                    <span key={cap} className="mono persona-model-tag">
                      {ico(cMeta.icon)} {cMeta.label}
                    </span>
                  );
                })}
              </div>
              <p className="muted persona-model-desc">{modelInfo.description}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

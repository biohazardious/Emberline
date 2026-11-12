import {
  type AgentId,
  type AgentPersona,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  formatRankStars,
  getModelInfoForProvider,
  type ModelCapabilityTier,
  PERSONA_CAPABILITY_TARGETS,
  type PersonaRouteMap,
  PROVIDER_REGISTRY,
  type QuotaPolicy,
} from '@emberline/protocol';
import { Flame, Globe, Save, Scale, Wallet, Zap } from 'lucide-react';
import { PERSONA_LIST } from '../PersonaBadge';
import { RouteChainEditor } from '../RouteChainEditor';
import { CAPABILITY_TAG_META, type CapabilityPreset, TIER_COLORS } from './providerRoutingHelpers';

export interface PersonaRoutingSectionProps {
  enabledProviders: AgentId[];
  settings: FactorySettings | null;
  personaRoutes: PersonaRouteMap | null;
  setPersonaRoutes: (routes: PersonaRouteMap) => void;
  quotaPolicy: QuotaPolicy;
  setQuotaPolicy: (policy: QuotaPolicy) => void;
  claudeUsage?: ClaudeUsageTelemetry;
  saving: boolean;
  onApplyPreset: (preset: CapabilityPreset) => void;
  onQuickTierSelect: (personaKey: AgentPersona, tier: ModelCapabilityTier) => void;
}

export function PersonaRoutingSection({
  enabledProviders,
  settings,
  personaRoutes,
  setPersonaRoutes,
  quotaPolicy,
  setQuotaPolicy,
  claudeUsage,
  saving,
  onApplyPreset,
  onQuickTierSelect,
}: PersonaRoutingSectionProps) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span className="eyebrow">
              Step 2 · Capability-Ranked Persona Matrix (★1–5 &amp; Low / Med / High)
            </span>
            <h3 style={{ margin: '4px 0 4px' }}>Specialist Persona Routing &amp; Model Rank Assignment</h3>
            <p className="muted small" style={{ maxWidth: 720, margin: 0 }}>
              Each specialist role has a recommended capability rank (<code>★5 Frontier</code> for
              Architecture/PO, <code>★4 High</code> for Full-Stack/UI/Security, <code>★3 Medium</code> for
              Fast QA). Model choices are strictly scoped to the selected provider—switching a persona&apos;s
              provider automatically selects the matching rank model from that provider!
            </p>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onApplyPreset('auto-rank')}
              title="Automatically match each persona to its optimal ★1-5 rank on its active provider"
            >
              <Zap className="icon" aria-hidden /> Auto-Match by Persona Rank
            </button>
            {enabledProviders.length > 1 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onApplyPreset('multi-provider')}
                title="Distribute UI/UX, QA, and Architecture across your enabled providers"
              >
                <Globe className="icon" aria-hidden /> Multi-Provider Split
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onApplyPreset('all-high')}
              title="Assign High / Frontier (★4-5) models across all personas"
            >
              <Flame className="icon" aria-hidden /> All High (★4–5)
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onApplyPreset('all-medium')}
              title="Assign Medium / Balanced (★3) models across all personas"
            >
              <Scale className="icon" aria-hidden /> All Medium (★3)
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onApplyPreset('all-low')}
              title="Assign Low / Fast (★1-2) models across all personas to save tokens"
            >
              <Wallet className="icon" aria-hidden /> All Low / Fast (★1–2)
            </button>
          </div>
        </div>

        <div className="quota-policy">
          <label>
            New runs when their provider is out of quota
            <select
              className="input"
              value={quotaPolicy.newRuns}
              onChange={(e) =>
                setQuotaPolicy({ ...quotaPolicy, newRuns: e.target.value as QuotaPolicy['newRuns'] })
              }
            >
              <option value="wait">Wait for the reset</option>
              <option value="fallback">Start on the next route</option>
            </select>
          </label>
          <label>
            Runs in progress when their provider runs out
            <select
              className="input"
              value={quotaPolicy.inFlight}
              onChange={(e) =>
                setQuotaPolicy({ ...quotaPolicy, inFlight: e.target.value as QuotaPolicy['inFlight'] })
              }
            >
              <option value="wait">Wait for the reset and continue</option>
              <option value="fallback">Hand off to the next route</option>
            </select>
          </label>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          The factory works on one ticket per project at a time, so a ticket waiting for its provider&apos;s
          quota holds that project&apos;s queue. For factory projects, give the persona a fallback route and
          choose &ldquo;Start on the next route&rdquo; / &ldquo;Hand off to the next route&rdquo;.
        </p>

        {claudeUsage?.extraUsage && (
          <p className="muted small" style={{ margin: 0 }}>
            Claude extra usage:{' '}
            {claudeUsage.extraUsage.enabled
              ? `on · $${claudeUsage.extraUsage.usedUsd.toFixed(2)} of $${claudeUsage.extraUsage.limitUsd.toFixed(2)} this month`
              : `off${claudeUsage.extraUsage.disabledReason ? ` (${claudeUsage.extraUsage.disabledReason})` : ''}`}
            {' · '}
            <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
              Change it on claude.ai → Settings → Usage
            </a>
            {claudeUsage.extraUsage.enabled &&
              '. Claude keeps working past its subscription limit and bills extra usage; fallbacks after a Claude route only start when that runs out too.'}
          </p>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))',
            gap: '12px',
          }}
        >
          {PERSONA_LIST.map((meta) => {
            const personaKey = meta.id;
            const targetSpec = PERSONA_CAPABILITY_TARGETS[personaKey];
            const chain = personaRoutes?.[personaKey] ?? [];
            const firstRoute = chain[0];
            const selectedAgent: AgentId = firstRoute?.agent ?? enabledProviders[0] ?? 'claude';
            const providerEntry = PROVIDER_REGISTRY[selectedAgent];
            const selectedModel = firstRoute?.model ?? 'auto';
            const modelInfo = getModelInfoForProvider(selectedAgent, selectedModel);
            const activeTier: ModelCapabilityTier = modelInfo?.tier ?? targetSpec.recommendedTier;
            const activeRank = modelInfo?.rank ?? targetSpec.recommendedRank;
            const tierStyle = TIER_COLORS[activeTier];

            return (
              <div
                key={personaKey}
                style={{
                  padding: '14px',
                  borderRadius: '8px',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <strong>{meta.label}</strong>
                      <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                        {meta.shortLabel}
                      </span>
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: '0.68rem',
                        padding: '2px 7px',
                        borderRadius: '999px',
                        background: tierStyle.bg,
                        border: `1px solid ${tierStyle.border}`,
                        color: tierStyle.text,
                        fontWeight: 600,
                      }}
                      title={`Recommended for ${meta.label}: ${targetSpec.summary}`}
                    >
                      {formatRankStars(activeRank)} · {activeTier.toUpperCase()}
                    </span>
                  </div>
                  <div className="muted small" style={{ fontSize: '0.72rem' }}>
                    {targetSpec.summary}
                  </div>
                </div>

                <div className="field" style={{ gap: 4 }}>
                  <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                    Provider chain (first route, then fallbacks)
                  </span>
                  {personaRoutes && (
                    <RouteChainEditor
                      persona={personaKey}
                      value={chain}
                      onChange={(next) => setPersonaRoutes({ ...personaRoutes, [personaKey]: next })}
                      enabledProviders={enabledProviders}
                      keyConfigured={{
                        claude: Boolean(settings?.anthropicKeyStored),
                        codex: Boolean(settings?.openaiKeyStored),
                        gemini: Boolean(settings?.geminiKeyStored),
                        aider: Boolean(
                          settings?.anthropicKeyStored ||
                          settings?.openaiKeyStored ||
                          settings?.geminiKeyStored,
                        ),
                      }}
                    />
                  )}
                </div>

                <div className="field" style={{ gap: 4 }}>
                  <span
                    className="muted mono"
                    style={{
                      fontSize: '0.68rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>Capability Tier Quick-Match</span>
                    <span>Target: ★{targetSpec.recommendedRank}/5</span>
                  </span>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '4px',
                    }}
                  >
                    {(['low', 'medium', 'high'] as const).map((tierKey) => {
                      const isCurrentTier = activeTier === tierKey && selectedModel !== 'auto';
                      const tMeta = TIER_COLORS[tierKey];
                      return (
                        <button
                          key={tierKey}
                          type="button"
                          onClick={() => onQuickTierSelect(personaKey, tierKey)}
                          style={{
                            padding: '4px 6px',
                            fontSize: '0.68rem',
                            fontFamily: 'var(--font-mono)',
                            fontWeight: isCurrentTier ? 700 : 500,
                            borderRadius: '5px',
                            cursor: 'pointer',
                            background: isCurrentTier
                              ? tMeta.bg
                              : 'color-mix(in srgb, var(--text) 2%, transparent)',
                            border: isCurrentTier ? `1px solid ${tMeta.border}` : '1px solid var(--border)',
                            color: isCurrentTier ? tMeta.text : 'var(--text-muted)',
                            transition: 'all 0.12s ease',
                          }}
                          title={`Auto-select ${providerEntry.shortLabel}'s ${tierKey.toUpperCase()} tier model`}
                        >
                          {tierKey === 'low' ? 'LOW ★1-2' : tierKey === 'medium' ? 'MED ★3' : 'HIGH ★4-5'}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {modelInfo && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '5px',
                      padding: '7px 9px',
                      borderRadius: '6px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {modelInfo.capabilities.map((cap) => {
                        const cMeta = CAPABILITY_TAG_META[cap];
                        const CapIcon = cMeta.icon;
                        return (
                          <span
                            key={cap}
                            className="mono"
                            style={{
                              fontSize: '0.64rem',
                              padding: '1px 5px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--text) 5%, transparent)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <CapIcon className="icon" aria-hidden /> {cMeta.label}
                          </span>
                        );
                      })}
                    </div>
                    <div className="muted small" style={{ fontSize: '0.69rem', lineHeight: 1.3 }}>
                      {modelInfo.description}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? (
            'Saving…'
          ) : (
            <>
              <Save className="icon" aria-hidden /> Save Active Providers &amp; Capability Matrix
            </>
          )}
        </button>
      </div>
    </>
  );
}

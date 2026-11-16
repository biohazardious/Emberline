import {
  type AgentPersona,
  type ClaudeUsageTelemetry,
  type ModelCapabilityTier,
  type QuotaPolicy,
  selectProviderModelByTier,
} from '@emberline/protocol';
import { useState } from 'react';
import { PERSONA_LIST } from '../../PersonaBadge';
import { HelpHint } from '../../ui/HelpHint';
import { buildPresetRoutes, type CapabilityPreset, type ProviderSectionForm } from '../settingsMeta';
import { PersonaRouteRow } from './PersonaRouteRow';
import { PresetMenu } from './PresetMenu';
import './providers.css';

export interface RoutingViewProps {
  form: ProviderSectionForm;
  claudeUsage: ClaudeUsageTelemetry | undefined;
}

export function RoutingView({ form, claudeUsage }: RoutingViewProps) {
  const {
    settings,
    defaultAgent,
    enabledProviders,
    antigravityAck,
    personaRoutes,
    setPersonaRoutes,
    quotaPolicy,
    setQuotaPolicy,
    setNotice,
  } = form;

  const [expandedPersonas, setExpandedPersonas] = useState<Set<AgentPersona>>(() => new Set());

  const togglePersonaExpanded = (persona: AgentPersona) => {
    setExpandedPersonas((prev) => {
      const next = new Set(prev);
      if (next.has(persona)) next.delete(persona);
      else next.add(persona);
      return next;
    });
  };

  const handlePersonaTierQuickSelect = (personaKey: AgentPersona, tier: ModelCapabilityTier) => {
    setPersonaRoutes((prev) => {
      if (!prev) return prev;
      const [first, ...rest] = prev[personaKey];
      if (!first) return prev;
      return {
        ...prev,
        [personaKey]: [
          { ...first, model: selectProviderModelByTier(first.agent, tier, personaKey) },
          ...rest,
        ],
      };
    });
  };

  const applyCapabilityPreset = (preset: CapabilityPreset) => {
    if (!personaRoutes) return;
    const { routes, notice } = buildPresetRoutes(
      preset,
      personaRoutes,
      enabledProviders,
      defaultAgent,
      antigravityAck,
    );
    setPersonaRoutes(routes);
    setNotice(notice);
  };

  return (
    <section className="providers-view" aria-labelledby="providers-routing-heading">
      <header className="providers-view-head">
        <div className="providers-view-title-group">
          <h3 id="providers-routing-heading" className="providers-view-title">
            Routing
          </h3>
          <HelpHint topic="how ranks work">
            <div className="providers-hint-body">
              <p>
                Each specialist persona has a recommended capability rank: <code>★5 Frontier</code> for
                Architecture and Product Owner, <code>★4 High</code> for Coder, UI/UX, DBA and Security, and{' '}
                <code>★3 Medium</code> for QA.
              </p>
              <p>
                Model choices are scoped to the selected provider—switching a persona&apos;s provider picks
                the matching rank model from that provider.
              </p>
            </div>
          </HelpHint>
        </div>

        <div className="providers-view-actions">
          <PresetMenu enabledProviders={enabledProviders} onSelectPreset={applyCapabilityPreset} />
        </div>
      </header>

      <div className="routing-quota-card" role="group" aria-labelledby="routing-quota-heading">
        <div className="routing-quota-head">
          <h4 id="routing-quota-heading" className="routing-quota-title">
            When a provider runs out of quota
          </h4>
          <HelpHint topic="quota policy">
            <div className="providers-hint-body">
              <p>
                The factory works on one ticket per project at a time, so a ticket waiting for its
                provider&apos;s quota holds that project&apos;s queue. Give the persona a fallback route and
                choose &ldquo;Start on the next route&rdquo; or &ldquo;Hand off to the next route&rdquo;.
              </p>
              <p>
                When Claude extra usage is on, Claude keeps working past its subscription limit and bills
                extra usage; fallbacks after a Claude route only start when that runs out too.
              </p>
            </div>
          </HelpHint>
        </div>

        <div className="quota-policy">
          <label>
            New runs
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
            Runs in progress
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

        {claudeUsage?.extraUsage && (
          <p className="muted routing-extra-usage">
            Claude extra usage:{' '}
            {claudeUsage.extraUsage.enabled
              ? `on · $${claudeUsage.extraUsage.usedUsd.toFixed(2)} of $${claudeUsage.extraUsage.limitUsd.toFixed(2)} this month`
              : `off${claudeUsage.extraUsage.disabledReason ? ` (${claudeUsage.extraUsage.disabledReason})` : ''}`}
            {' · '}
            <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
              Change it on claude.ai → Settings → Usage
            </a>
          </p>
        )}
      </div>

      {!personaRoutes ? (
        <p className="muted small">No persona routes configured yet.</p>
      ) : (
        <div className="persona-route-list" role="list" aria-label="Persona routes">
          {PERSONA_LIST.map((meta) => (
            <div key={meta.id} role="listitem">
              <PersonaRouteRow
                personaKey={meta.id}
                label={meta.label}
                shortLabel={meta.shortLabel}
                chain={personaRoutes[meta.id] ?? []}
                enabledProviders={enabledProviders}
                settings={settings}
                expanded={expandedPersonas.has(meta.id)}
                onToggleExpand={() => togglePersonaExpanded(meta.id)}
                onChangeChain={(next) => setPersonaRoutes({ ...personaRoutes, [meta.id]: next })}
                onSelectTier={(tier) => handlePersonaTierQuickSelect(meta.id, tier)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

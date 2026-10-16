import {
  type AgentId,
  type AgentPersona,
  formatRankStars,
  getModelsForProvider,
  MAX_ROUTES,
  PERSONA_CAPABILITY_TARGETS,
  PROVIDER_REGISTRY,
  PROVIDER_RUNTIME,
  type Route,
} from '@emberline/protocol';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';

export const CREDENTIAL_LABEL = { login: 'Sign-in', api_key: 'API key', credits: 'AI credits' } as const;

/** One persona's fallback chain: the first route is used, the next ones when quota runs out. */
export function RouteChainEditor({
  persona,
  value,
  onChange,
  enabledProviders,
  keyConfigured,
}: {
  /** Decides what the Auto model aims for. */
  persona: AgentPersona;
  value: Route[];
  onChange: (next: Route[]) => void;
  enabledProviders: AgentId[];
  keyConfigured: Partial<Record<AgentId, boolean>>;
}) {
  const set = (index: number, patch: Partial<Route>) => {
    const next = value.map((r, i) => {
      if (i !== index) return r;
      const merged = { ...r, ...patch };
      if (patch.agent) {
        merged.model = getModelsForProvider(patch.agent)[0]?.id ?? 'auto';
        merged.credential = PROVIDER_RUNTIME[patch.agent].credentials[0]!;
      }
      return merged;
    });
    onChange(next);
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };
  return (
    <ol className="route-chain">
      {value.map((route, index) => {
        const providers = enabledProviders.includes(route.agent) ? enabledProviders : [route.agent, ...enabledProviders];
        const models = getModelsForProvider(route.agent);
        return (
          // Index keys keep focus in the select being edited; every field is controlled by `value`.
          <li key={index} className="route-step">
            <span className="route-step-index mono">{index === 0 ? 'First' : `Fallback ${index}`}</span>
            <select className="input" value={route.agent} onChange={(e) => set(index, { agent: e.target.value as AgentId })} aria-label="Provider">
              {providers.map((agent) => (
                <option key={agent} value={agent}>{PROVIDER_REGISTRY[agent].shortLabel}</option>
              ))}
            </select>
            <select className="input" value={route.model} onChange={(e) => set(index, { model: e.target.value as Route['model'] })} aria-label="Model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>{formatRankStars(m.rank)} [{m.rank}/5 · {m.tier.toUpperCase()}] {m.label}</option>
              ))}
              <option value="auto">Auto (Match Persona Target Rank ★{PERSONA_CAPABILITY_TARGETS[persona].recommendedRank})</option>
              {route.model !== 'auto' && !models.some((m) => m.id === route.model) && <option value={route.model}>{route.model}</option>}
            </select>
            <select
              className="input"
              value={route.credential}
              onChange={(e) => set(index, { credential: e.target.value as Route['credential'] })}
              aria-label="Sign-in method"
              disabled={PROVIDER_RUNTIME[route.agent].credentials.length === 1}
            >
              {PROVIDER_RUNTIME[route.agent].credentials.map((c) => (
                <option key={c} value={c} disabled={c === 'api_key' && !keyConfigured[route.agent] && route.credential !== c}>
                  {CREDENTIAL_LABEL[c]}{c === 'api_key' && !keyConfigured[route.agent] ? ' (no key saved)' : ''}
                </option>
              ))}
            </select>
            {route.credential === 'api_key' && <span className="badge badge-warn" title="Billed to your API key">paid</span>}
            {route.credential === 'credits' && <span className="badge badge-warn" title="Uses your Antigravity AI credits once the subscription quota is used up">paid</span>}
            <span className="route-step-actions">
              <button type="button" className="icon-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp size={14} /></button>
              <button type="button" className="icon-btn" onClick={() => move(index, 1)} disabled={index === value.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
              <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, i) => i !== index))} disabled={value.length === 1} aria-label="Remove"><X size={14} /></button>
            </span>
          </li>
        );
      })}
      {value.length < MAX_ROUTES && (
        <li>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const agent = enabledProviders[0] ?? 'claude';
              onChange([...value, { agent, model: getModelsForProvider(agent)[0]?.id ?? 'auto', credential: PROVIDER_RUNTIME[agent].credentials[0]! }]);
            }}
          >
            <Plus size={14} /> Add fallback
          </button>
        </li>
      )}
    </ol>
  );
}

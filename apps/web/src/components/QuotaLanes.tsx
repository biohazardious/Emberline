import {
  type AgentId,
  type Credential,
  type FactorySettings,
  PROVIDER_REGISTRY,
  type QuotaWindow,
  type Route,
  type Run,
  type SchedulerState,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { handoffCandidates, HANDOFF_STATES } from '../handoffCandidates';
import { liveKeys, useScheduler } from '../hooks/liveData';
import { useApi } from '../hooks/useApi';
import { withHandoff } from '../runHandoff';
import { formatCountdown, useNow } from '../time';
import { CREDENTIAL_LABEL } from './RouteChainEditor';

const providerLabel = (agent: string) => PROVIDER_REGISTRY[agent as AgentId]?.shortLabel ?? agent;

const laneLabel = (w: QuotaWindow) => {
  const pool = w.pool === '*' ? 'all models' : w.pool;
  return `${providerLabel(w.agent)} · ${pool}${w.credential === 'login' ? '' : ` · ${CREDENTIAL_LABEL[w.credential as Credential] ?? w.credential}`}`;
};

/** One row per exhausted lane, each with its own countdown and "Try now". */
export function QuotaLanes({ windows, compact = false }: { windows: QuotaWindow[]; compact?: boolean }) {
  const { setScheduler } = useScheduler();
  const now = useNow(1000);
  const [error, setError] = useState<string>();
  if (windows.length === 0) return null;
  return (
    <>
      <ul className={`quota-lanes${compact ? ' compact' : ''}`}>
        {windows.map((w) => (
          <li key={w.id} title={w.message ?? undefined}>
            <span className="quota-lane-name">{laneLabel(w)}</span>
            <span className="quota-lane-eta mono">resets in {formatCountdown(w.resumeAt, now)}</span>
            {w.message && !compact && <span className="quota-lane-message muted small">{w.message}</span>}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`Try ${laneLabel(w)} now`}
              title="Try now instead of waiting; if the limit still applies the pause starts again"
              onClick={async () => {
                try {
                  setError(undefined);
                  setScheduler(
                    await api<SchedulerState>('/api/scheduler/resume', 'POST', {
                      agent: w.agent,
                      credential: w.credential,
                      pool: w.pool,
                    }),
                  );
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Try now
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="form-error quota-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

const SOURCE_LABEL = {
  run: "This run's chain",
  persona: 'Persona chain',
  provider: 'Other providers',
} as const;

const routeKey = (r: Route) => `${r.agent}|${r.model}|${r.credential}`;

const routeLabel = (r: Route) =>
  `${providerLabel(r.agent)} · ${r.model}${r.credential === 'login' ? '' : ` (${CREDENTIAL_LABEL[r.credential]}, paid)`}`;

/**
 * "Continue with…" for a waiting run: its own chain, its persona's chain, then each enabled
 * provider's default route, as one select so it fits the Fleet card and the inspector header.
 */
export function HandoffMenu({ run }: { run: Run }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState('');
  const [confirming, setConfirming] = useState(false);
  // The second click confirms ending the live session of this state only; a new state asks afresh.
  useEffect(() => setConfirming(false), [run.state]);
  const client = useQueryClient();
  const { data: settings } = useApi<FactorySettings>('/api/factory/settings', 15_000);
  const { scheduler } = useScheduler();
  if (run.handedOffTo || run.cancelled || !HANDOFF_STATES.has(run.state)) return null;
  const candidates = handoffCandidates(run, settings, scheduler?.windows);
  if (candidates.length === 0) return null;
  const selected =
    candidates.find((c) => routeKey(c.route) === picked) ??
    candidates.find((c) => !c.exhausted) ??
    candidates[0]!;
  const groups = (['run', 'persona', 'provider'] as const)
    .map((source) => [source, candidates.filter((c) => c.source === source)] as const)
    .filter(([, list]) => list.length > 0);
  const id = `handoff-${run.id}`;
  return (
    <div className="handoff-menu" role="group" aria-label="Continue with">
      <label htmlFor={id}>Continue with</label>
      <select
        id={id}
        className="input"
        value={routeKey(selected.route)}
        disabled={busy}
        onChange={(e) => {
          setError(null);
          setConfirming(false);
          setPicked(e.target.value);
        }}
      >
        {groups.map(([source, list]) => (
          <optgroup key={source} label={SOURCE_LABEL[source]}>
            {list.map((c) => (
              <option key={routeKey(c.route)} value={routeKey(c.route)} disabled={c.exhausted}>
                {routeLabel(c.route)}
                {c.exhausted ? ' — out of quota' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy || selected.exhausted}
        aria-label={`Hand off to ${routeLabel(selected.route)}`}
        onClick={async () => {
          // A waiting_input run has a live session; handing off ends it, so ask once first.
          if (run.state === 'waiting_input' && !confirming) {
            setConfirming(true);
            return;
          }
          try {
            setConfirming(false);
            setError(null);
            setBusy(true);
            const successor = await api<Run>(`/api/runs/${run.id}/handoff`, 'POST', {
              route: selected.route,
            });
            // Flip the predecessor to "handed off" now instead of waiting for the SSE event.
            client.setQueryData<Run[]>(liveKeys.runs, (list) =>
              list ? withHandoff(list, run, successor) : list,
            );
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Hand off
      </button>
      {confirming && (
        <span className="muted small" role="status">
          Hand off ends this live session — click again to confirm
        </span>
      )}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

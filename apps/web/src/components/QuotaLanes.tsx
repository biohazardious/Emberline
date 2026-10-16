import { type AgentId, type Credential, PROVIDER_REGISTRY, type QuotaWindow, type Run, type SchedulerState } from '@emberline/protocol';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { useScheduler } from '../hooks/liveData';
import { formatCountdown, useNow } from './QuotaPanel';
import { CREDENTIAL_LABEL } from './RouteChainEditor';

const providerLabel = (agent: string) => PROVIDER_REGISTRY[agent as AgentId]?.shortLabel ?? agent;

const laneLabel = (w: QuotaWindow) => {
  const pool = w.pool === '*' ? 'all models' : w.pool;
  return `${providerLabel(w.agent)} · ${pool}${w.credential === 'login' ? '' : ` · ${(CREDENTIAL_LABEL[w.credential as Credential] ?? w.credential)}`}`;
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
            <button
              type="button"
              className="btn btn-ghost btn-sm"
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
      {error && <p className="form-error quota-error">{error}</p>}
    </>
  );
}

/** "Continue with…" for a waiting run: its chain's other routes. */
export function HandoffMenu({ run }: { run: Run }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const routes = run.routes.filter((_, i) => i !== run.routeIndex);
  if (run.handedOffTo || run.cancelled || !(run.state === 'rate_limited' || run.state === 'failed') || routes.length === 0) {
    return null;
  }
  return (
    <div className="handoff-menu">
      <span>Continue with</span>
      {routes.map((route) => (
        <button
          key={`${route.agent}-${route.model}-${route.credential}`}
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={async () => {
            try {
              setError(null);
              setBusy(true);
              await api<Run>(`/api/runs/${run.id}/handoff`, 'POST', { route });
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {providerLabel(route.agent)} · {route.model}
          {route.credential === 'login' ? '' : ` (${CREDENTIAL_LABEL[route.credential]}, paid)`}
        </button>
      ))}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

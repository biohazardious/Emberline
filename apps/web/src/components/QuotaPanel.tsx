import { MAX_CONCURRENCY, type SchedulerState } from '@emberline/protocol';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useScheduler } from '../hooks/useScheduler';

const SOURCE_LABEL = {
  hook: 'from Claude',
  screen: 'read from the terminal',
  probe: 'reset time unknown, probing',
} as const;

/** Re-renders every `ms` so countdowns stay fresh. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function formatCountdown(target: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(target) - now) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Quota strip: slot usage, queue, concurrency setting and, while the usage window is exhausted,
 * a countdown to the automatic resume with a manual override.
 */
export function QuotaPanel({ compact = false }: { compact?: boolean }) {
  const { scheduler, setScheduler } = useScheduler();
  const now = useNow(1_000);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!scheduler) return null;
  const { window } = scheduler;

  const call = async (fn: () => Promise<SchedulerState>) => {
    setBusy(true);
    setError(undefined);
    try {
      setScheduler(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="quota-panel"
      className={`quota ${window ? 'quota-paused' : 'quota-ok'}${compact ? ' quota-compact' : ''}`}
      aria-label="Quota scheduler"
    >
      <div className="quota-main">
        <span className="quota-orb" aria-hidden="true" />
        {window ? (
          <div className="quota-text">
            <strong>Usage limit reached</strong>
            <span className="muted">
              Resuming in <span className="mono quota-countdown">{formatCountdown(window.resumeAt, now)}</span>
              {' · '}
              {window.resetsAt ? `resets ${clock(window.resetsAt)}` : 'next probe'} ({SOURCE_LABEL[window.resetSource]})
            </span>
            {window.message && !compact && <span className="quota-message mono">{window.message}</span>}
          </div>
        ) : (
          <div className="quota-text">
            <strong>Quota available</strong>
            <span className="muted">
              {scheduler.busy}/{scheduler.maxConcurrentRuns} slots busy
              {scheduler.queued > 0 && ` · ${scheduler.queued} queued`}
            </span>
          </div>
        )}
      </div>
      <div className="quota-side">
        {window && (
          <span className="quota-stat" title="Runs waiting for the reset">
            {scheduler.rateLimited} paused · {scheduler.queued} queued
          </span>
        )}
        {!compact && (
          <div className="segmented" role="radiogroup" aria-label="Parallel runs">
            {Array.from({ length: Math.min(4, MAX_CONCURRENCY) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                id={`concurrency-${n}`}
                aria-checked={scheduler.maxConcurrentRuns === n}
                className={scheduler.maxConcurrentRuns === n ? 'active' : ''}
                title={`Run at most ${n} agent${n > 1 ? 's' : ''} at once`}
                disabled={busy}
                onClick={() =>
                  void call(() => api<SchedulerState>('/api/scheduler', 'PATCH', { maxConcurrentRuns: n }))
                }
              >
                {n}
              </button>
            ))}
          </div>
        )}
        {window && (
          <button
            id="quota-resume"
            className="btn btn-sm"
            disabled={busy}
            title="Try now instead of waiting; if the limit still applies the pause starts again"
            onClick={() => void call(() => api<SchedulerState>('/api/scheduler/resume', 'POST'))}
          >
            Resume now
          </button>
        )}
      </div>
      {error && <p className="form-error quota-error">{error}</p>}
    </section>
  );
}

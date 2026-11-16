import {
  type AgentId,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  MAX_CONCURRENCY,
  PROVIDER_REGISTRY,
  type QuotaWindow,
  type SchedulerState,
} from '@emberline/protocol';
import { RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { useRuns, useScheduler } from '../hooks/liveData';
import { useApi } from '../hooks/useApi';
import { formatCountdown, useNow } from '../time';
import { ProviderMark } from './ProviderMark';
import { laneLabel, QuotaLanes } from './QuotaLanes';
import {
  clockShort,
  formatClaudePlanLabel,
  formatTokensCompact,
  type ProviderTelemetryItem,
  QuotaMeterBar,
  QuotaUsageDetails,
} from './quota/QuotaUsageDetails';
import './settings/settings-panels.css';
import { HelpHint } from './ui/HelpHint';

export { formatClaudePlanLabel, formatTokensCompact };

export function QuotaPanel({ compact = false }: { compact?: boolean }) {
  const { scheduler, setScheduler } = useScheduler();
  const { runs } = useRuns();
  const usagePoll = useApi<ClaudeUsageTelemetry>('/api/factory/claude-usage', 30_000);
  const settingsPoll = useApi<FactorySettings>('/api/factory/settings', 25_000);
  const [manualUsage, setManualUsage] = useState<ClaudeUsageTelemetry | null>(null);
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const now = useNow(1_000);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const usage = manualUsage ?? usagePoll.data ?? null;

  const providerTelemetry = useMemo((): ProviderTelemetryItem[] => {
    const enabled: AgentId[] = settingsPoll.data?.enabledProviders?.length
      ? settingsPoll.data.enabledProviders
      : ['claude'];
    const authMap = settingsPoll.data?.providerAuth;
    return enabled.map((providerId) => {
      const entry = PROVIDER_REGISTRY[providerId];
      const providerRuns = (runs ?? []).filter((r) => r.agent === providerId);
      const activeCount = providerRuns.filter(
        (r) => !r.endedAt && r.state !== 'done' && r.state !== 'failed',
      ).length;
      const doneCount = providerRuns.filter((r) => r.state === 'done').length;
      const failedCount = providerRuns.filter((r) => r.state === 'failed').length;
      const auth = authMap?.[providerId];
      return {
        providerId,
        entry,
        activeCount,
        doneCount,
        failedCount,
        authenticated:
          auth?.authenticated ?? (providerId === 'claude' ? Boolean(usage?.authenticated) : true),
        authLabel:
          auth?.label ??
          (providerId === 'claude' ? formatClaudePlanLabel(usage) : `${entry.shortLabel} Ready`),
      };
    });
  }, [settingsPoll.data, runs, usage]);

  if (!scheduler) return null;
  const windows = scheduler.windows;
  const window = windows.length > 0 ? windows[0] : undefined;

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

  const handleRefreshUsage = async () => {
    setRefreshingUsage(true);
    try {
      const fresh = await api<ClaudeUsageTelemetry>('/api/factory/claude-usage?refresh=1');
      setManualUsage(fresh);
      await settingsPoll.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRefreshingUsage(false);
    }
  };

  const resumeWindow = (w: QuotaWindow) =>
    call(() =>
      api<SchedulerState>('/api/scheduler/resume', 'POST', {
        agent: w.agent,
        credential: w.credential,
        pool: w.pool,
      }),
    );

  const fivePct = Math.min(100, Math.max(0, Math.round(usage?.fiveHour?.utilizationPercent ?? 0)));
  const sevenPct = Math.min(100, Math.max(0, Math.round(usage?.sevenDay?.utilizationPercent ?? 0)));

  if (compact) {
    if (!window) return null;
    return (
      <section id="quota-panel" className="quota quota-paused quota-compact" aria-label="Quota scheduler">
        <div className="quota-main">
          <span className="quota-orb" aria-hidden="true" />
          <div className="quota-text">
            <strong>Out of quota</strong>
            <QuotaLanes windows={windows} compact />
          </div>
        </div>

        <div className="quota-side">
          <span className="quota-stat mono">
            {scheduler.rateLimited} paused · {scheduler.queued} queued
          </span>
        </div>
        {error && <p className="form-error quota-error">{error}</p>}
      </section>
    );
  }

  const coveredWindowIds = new Set<string>();
  const lanes = providerTelemetry.map((p) => {
    const matching = windows.find((w) => w.agent === p.providerId);
    if (matching) coveredWindowIds.add(matching.id);
    const hasMeter = p.providerId === 'claude' && Boolean(usage?.fiveHour || usage?.sevenDay);
    const isKnownAvailable =
      !matching &&
      (p.providerId === 'claude'
        ? Boolean(usage?.authenticated || hasMeter)
        : p.providerId !== 'antigravity' && p.authenticated);
    const stateKind: 'paused' | 'ok' | 'unknown' = matching ? 'paused' : isKnownAvailable ? 'ok' : 'unknown';
    const stateText = matching
      ? `Paused until ${clockShort(matching.resetsAt ?? matching.resumeAt)}`
      : stateKind === 'ok'
        ? 'Available'
        : 'Unknown';
    return {
      provider: p,
      window: matching ?? null,
      hasMeter,
      stateKind,
      stateText,
    };
  });
  const extraWindows = windows.filter((w) => !coveredWindowIds.has(w.id));

  return (
    <section
      id="quota-panel"
      className={`quota quota-panel settings-panel ${window ? 'quota-paused' : 'quota-ok'}`}
      aria-label="Quota scheduler"
    >
      <header className="settings-panel-head">
        <div className="settings-panel-title-group">
          <div className="settings-panel-heading-row">
            <span className="quota-orb" aria-hidden="true" />
            <h2 id="quota-title">Usage limits</h2>
            <HelpHint topic="usage limits">
              When an agent CLI hits a subscription limit, its lane pauses until the reset time and resumes on
              its own. Parallel runs sets how many agents may run at once across all projects.
            </HelpHint>
          </div>
          <p className="muted mono">
            {scheduler.busy}/{scheduler.maxConcurrentRuns} slots busy
            {scheduler.queued > 0 ? ` · ${scheduler.queued} queued` : ''}
            {scheduler.rateLimited > 0 ? ` · ${scheduler.rateLimited} paused` : ''}.
          </p>
        </div>

        <div className="quota-side">
          <div className="segmented" role="radiogroup" aria-label="Parallel runs">
            {Array.from({ length: Math.min(4, MAX_CONCURRENCY) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                id={`concurrency-${n}`}
                aria-checked={scheduler.maxConcurrentRuns === n}
                aria-label={`${n} parallel run${n > 1 ? 's' : ''}`}
                className={scheduler.maxConcurrentRuns === n ? 'active' : ''}
                disabled={busy}
                onClick={() =>
                  void call(() => api<SchedulerState>('/api/scheduler', 'PATCH', { maxConcurrentRuns: n }))
                }
              >
                {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={refreshingUsage}
            onClick={() => void handleRefreshUsage()}
          >
            <RotateCw className="icon" aria-hidden="true" />
            {refreshingUsage ? 'Refreshing…' : 'Refresh usage'}
          </button>
        </div>
      </header>

      <ul className="quota-lane-list" aria-label="Provider lanes">
        {lanes.map(({ provider: p, window: laneWindow, hasMeter, stateKind, stateText }) => (
          <li key={p.providerId} className="quota-lane-row">
            <div className="quota-lane-identity">
              <ProviderMark id={p.entry.id} />
              <span>{p.providerId === 'claude' ? formatClaudePlanLabel(usage) : p.entry.shortLabel}</span>
            </div>

            <div className="quota-lane-metrics">
              <span className={`badge mono quota-state-${stateKind}`}>{stateText}</span>

              {hasMeter && usage && (
                <span className="quota-lane-meter mono">
                  <QuotaMeterBar percent={fivePct} />
                  <span>
                    5h {usage.fiveHour ? `${fivePct}%` : '—'}
                    {usage.fiveHour?.resetsAt ? ` · ${formatCountdown(usage.fiveHour.resetsAt, now)}` : ''}
                  </span>
                  <span className="muted">
                    7d {usage.sevenDay ? `${sevenPct}%` : '—'}
                    {usage.sevenDay?.resetsAt ? ` · ${formatCountdown(usage.sevenDay.resetsAt, now)}` : ''}
                  </span>
                </span>
              )}

              {!hasMeter && laneWindow && (
                <span className="mono muted">Resets in {formatCountdown(laneWindow.resumeAt, now)}</span>
              )}

              {laneWindow?.message && (
                <span className="quota-lane-message muted small">{laneWindow.message}</span>
              )}
            </div>

            {laneWindow && (
              <div className="quota-lane-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Resume ${laneLabel(laneWindow)} now`}
                  disabled={busy}
                  onClick={() => void resumeWindow(laneWindow)}
                >
                  Resume now
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {extraWindows.length > 0 && <QuotaLanes windows={extraWindows} />}

      <QuotaUsageDetails
        usage={usage}
        fivePct={fivePct}
        sevenPct={sevenPct}
        providerTelemetry={providerTelemetry}
        now={now}
      />

      {error && (
        <p className="form-error quota-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

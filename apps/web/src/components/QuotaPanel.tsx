import {
  type AgentId,
  type ClaudeTokenBucket,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  MAX_CONCURRENCY,
  PROVIDER_REGISTRY,
  type SchedulerState,
} from '@emberline/protocol';
import { Calendar, ChartColumn, Clock, CreditCard, RotateCw, Timer, Zap } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { ProviderMark } from './ProviderMark';
import { useApi } from '../hooks/useApi';
import { useRuns, useScheduler } from '../hooks/liveData';

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
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatClaudePlanLabel(usage?: ClaudeUsageTelemetry | null): string {
  if (!usage) return 'Claude';
  const sub = (usage.subscriptionType ?? '').toLowerCase();
  const tier = (usage.rateLimitTier ?? '').toLowerCase();
  if (sub === 'max') {
    if (tier.includes('20x')) return 'Claude Max 20x';
    if (tier.includes('5x')) return 'Claude Max 5x';
    return 'Claude Max';
  }
  if (sub === 'pro') return 'Claude Pro';
  if (sub === 'team') return 'Claude Team';
  if (sub) return `Claude ${sub.toUpperCase()}`;
  return 'Claude OAuth';
}

function barColor(pct: number): string {
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 65) return 'var(--warn)';
  return 'var(--accent)';
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTimeShort = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function TokenBucketCard({
  label,
  sublabel,
  bucket,
}: {
  label: ReactNode;
  sublabel: string;
  bucket: ClaudeTokenBucket;
}) {
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <span className="muted mono" style={{ fontSize: '0.72rem' }}>
          {sublabel} · {bucket.turnCount} turns
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong className="mono" style={{ fontSize: '1.25rem', color: 'var(--text)' }}>
          {formatTokensCompact(bucket.totalTokens)}
        </strong>
        <span className="muted" style={{ fontSize: '0.74rem' }}>
          total tokens
        </span>
      </div>
      <div
        className="mono muted"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '3px 8px',
          fontSize: '0.72rem',
          paddingTop: 4,
          borderTop: '1px solid var(--border)',
        }}
      >
        <span>In: {formatTokensCompact(bucket.inputTokens)}</span>
        <span>Out: {formatTokensCompact(bucket.outputTokens)}</span>
        <span>Cache R: {formatTokensCompact(bucket.cacheReadTokens)}</span>
        <span>Cache W: {formatTokensCompact(bucket.cacheCreationTokens)}</span>
      </div>
    </div>
  );
}

/**
 * Quota & Claude Usage Telemetry:
 * - Slot usage, queue, concurrency setting, and automatic rate-limit resume countdown
 * - Live Anthropic OAuth 5-hour (session/hourly) & 7-day (weekly) utilization percentages
 * - Local Claude CLI token consumption across 1h, 24h, and 7d windows
 */
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

  const providerTelemetry = useMemo(() => {
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
        authenticated: auth?.authenticated ?? (providerId === 'claude' ? Boolean(usage?.authenticated) : true),
        authLabel: auth?.label ?? (providerId === 'claude' ? formatClaudePlanLabel(usage) : `${entry.shortLabel} Ready`),
      };
    });
  }, [settingsPoll.data, runs, usage]);

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

  const fivePct = Math.min(100, Math.max(0, Math.round(usage?.fiveHour?.utilizationPercent ?? 0)));
  const sevenPct = Math.min(100, Math.max(0, Math.round(usage?.sevenDay?.utilizationPercent ?? 0)));

  if (compact) {
    if (!window) return null;
    return (
      <section
        id="quota-panel"
        className="quota quota-paused quota-compact"
        aria-label="Quota scheduler"
        style={{ flexWrap: 'wrap', gap: 12 }}
      >
        <div className="quota-main">
          <span className="quota-orb" aria-hidden="true" />
          <div className="quota-text">
            <strong>Usage limit reached</strong>
            <span className="muted">
              Resuming in <span className="mono quota-countdown">{formatCountdown(window.resumeAt, now)}</span>
              {' · '}
              {window.resetsAt ? `resets ${clock(window.resetsAt)}` : 'next probe'} ({SOURCE_LABEL[window.resetSource]})
            </span>
          </div>
        </div>

        <div className="quota-side">
          {window && (
            <span className="quota-stat" title="Runs waiting for the reset">
              {scheduler.rateLimited} paused · {scheduler.queued} queued
            </span>
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

  return (
    <section
      id="quota-panel"
      className={`quota ${window ? 'quota-paused' : 'quota-ok'}`}
      aria-label="Quota scheduler"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
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
              {window.message && <span className="quota-message mono">{window.message}</span>}
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

        <div className="quota-side" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {usage && (
            <span
              className="badge mono"
              style={{
                color: usage.authenticated ? 'var(--ok)' : 'var(--warn)',
                borderColor: usage.authenticated ? 'color-mix(in srgb, var(--ok) 35%, transparent)' : 'var(--warn)',
              }}
            >
              ● {formatClaudePlanLabel(usage)} · OAuth {usage.authenticated ? 'ACTIVE' : 'INACTIVE'}
              {usage.tokenExpiresAt ? ` (valid ${formatCountdown(usage.tokenExpiresAt, now)})` : ''}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={refreshingUsage}
            onClick={() => void handleRefreshUsage()}
            title="Fetch live rate limits from Anthropic OAuth & recalculate token buckets"
          >
            {refreshingUsage ? (
              'Refreshing…'
            ) : (
              <>
                <RotateCw className="icon" aria-hidden /> Refresh Usage
              </>
            )}
          </button>
          {window && (
            <span className="quota-stat" title="Runs waiting for the reset">
              {scheduler.rateLimited} paused · {scheduler.queued} queued
            </span>
          )}
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
      </div>

      {usage && (
        <>
          {/* Live Rate-Limit Gauges (5-Hour Session + 7-Day Weekly + Extra Credits) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 10,
            }}
          >
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                  <Timer className="icon" aria-hidden /> 5-Hour Session Limit (Hourly / Rolling)
                </span>
                <strong className="mono" style={{ fontSize: '1.05rem', color: barColor(fivePct) }}>
                  {usage.fiveHour ? `${fivePct}%` : '—'}
                </strong>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 8,
                  borderRadius: 999,
                  background: 'var(--bg)',
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    width: `${fivePct}%`,
                    height: '100%',
                    background: barColor(fivePct),
                    transition: 'width 250ms ease',
                  }}
                />
              </div>
              <div className="muted mono" style={{ fontSize: '0.73rem', display: 'flex', justifyContent: 'space-between' }}>
                <span>{100 - fivePct}% remaining in 5h window</span>
                {usage.fiveHour?.resetsAt && (
                  <span>
                    Resets in {formatCountdown(usage.fiveHour.resetsAt, now)} ({clock(usage.fiveHour.resetsAt)})
                  </span>
                )}
              </div>
            </div>

            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                  <Calendar className="icon" aria-hidden /> 7-Day Weekly Limit
                </span>
                <strong className="mono" style={{ fontSize: '1.05rem', color: barColor(sevenPct) }}>
                  {usage.sevenDay ? `${sevenPct}%` : '—'}
                </strong>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 8,
                  borderRadius: 999,
                  background: 'var(--bg)',
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    width: `${sevenPct}%`,
                    height: '100%',
                    background: barColor(sevenPct),
                    transition: 'width 250ms ease',
                  }}
                />
              </div>
              <div className="muted mono" style={{ fontSize: '0.73rem', display: 'flex', justifyContent: 'space-between' }}>
                <span>{100 - sevenPct}% remaining this week</span>
                {usage.sevenDay?.resetsAt && (
                  <span>
                    Resets in {formatCountdown(usage.sevenDay.resetsAt, now)} ({dateTimeShort(usage.sevenDay.resetsAt)})
                  </span>
                )}
              </div>
            </div>

            {usage.extraUsage && (usage.extraUsage.enabled || usage.extraUsage.limitUsd > 0 || usage.extraUsage.usedUsd > 0) && (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                    <CreditCard className="icon" aria-hidden /> Extra Usage Credits
                  </span>
                  <strong className="mono" style={{ fontSize: '0.95rem' }}>
                    ${usage.extraUsage.usedUsd.toFixed(2)}
                    {usage.extraUsage.limitUsd > 0 ? ` / $${usage.extraUsage.limitUsd.toFixed(2)}` : ''}
                  </strong>
                </div>
                <div
                  style={{
                    width: '100%',
                    height: 8,
                    borderRadius: 999,
                    background: 'var(--bg)',
                    overflow: 'hidden',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.round(usage.extraUsage.utilizationPercent ?? 0))}%`,
                      height: '100%',
                      background: barColor(Math.round(usage.extraUsage.utilizationPercent ?? 0)),
                    }}
                  />
                </div>
                <div className="muted mono" style={{ fontSize: '0.73rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Monthly overflow ({Math.round(usage.extraUsage.utilizationPercent ?? 0)}%)</span>
                  <span>
                    {usage.extraUsage.enabled
                      ? 'Active'
                      : usage.extraUsage.disabledReason
                        ? `Paused (${usage.extraUsage.disabledReason})`
                        : 'Disabled'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Token Consumption Telemetry across 1h / 24h / 7d */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            <TokenBucketCard
              label={
                <>
                  <Zap className="icon" aria-hidden /> Hourly Token Usage
                </>
              }
              sublabel="Last 1h"
              bucket={usage.hourlyTokens}
            />
            <TokenBucketCard
              label={
                <>
                  <Clock className="icon" aria-hidden /> Daily Token Usage
                </>
              }
              sublabel="Last 24h"
              bucket={usage.dailyTokens}
            />
            <TokenBucketCard
              label={
                <>
                  <ChartColumn className="icon" aria-hidden /> Weekly Token Usage
                </>
              }
              sublabel="Last 7d"
              bucket={usage.weeklyTokens}
            />
          </div>
        </>
      )}

      {/* Multi-Provider Fleet Readiness & Run Telemetry */}
      {providerTelemetry.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 10,
          }}
        >
          {providerTelemetry.map((p) => (
            <div
              key={p.providerId}
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                  <ProviderMark id={p.entry.id} />
                  {p.entry.shortLabel}
                </span>
                <span
                  className="badge mono"
                  style={{
                    fontSize: '0.68rem',
                    color: p.authenticated ? 'var(--ok)' : 'var(--warn)',
                    borderColor: p.authenticated ? 'color-mix(in srgb, var(--ok) 35%, transparent)' : 'var(--warn)',
                  }}
                >
                  ● {p.authenticated ? 'READY' : 'UNCONFIGURED'}
                </span>
              </div>
              <span className="muted mono" style={{ fontSize: '0.72rem' }}>
                {p.authLabel}
              </span>
              <div
                className="mono muted"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.73rem',
                  paddingTop: 4,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <span>
                  Active: <strong style={{ color: 'var(--text)' }}>{p.activeCount}</strong>
                </span>
                <span>
                  Done: <strong style={{ color: 'var(--text)' }}>{p.doneCount}</strong>
                </span>
                <span>
                  Failed: <strong style={{ color: 'var(--text)' }}>{p.failedCount}</strong>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="form-error quota-error">{error}</p>}
    </section>
  );
}


import type {
  AgentId,
  ClaudeTokenBucket,
  ClaudeUsageTelemetry,
  ProviderRegistryEntry,
} from '@emberline/protocol';
import { Calendar, ChartColumn, Clock, CreditCard, Timer, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatCountdown } from '../../time';
import { ProviderMark } from '../ProviderMark';
import { Disclosure } from '../ui/Disclosure';

export interface ProviderTelemetryItem {
  providerId: AgentId;
  entry: ProviderRegistryEntry;
  activeCount: number;
  doneCount: number;
  failedCount: number;
  authenticated: boolean;
  authLabel: string;
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

export function quotaTone(pct: number): 'ok' | 'warn' | 'bad' {
  if (pct >= 85) return 'bad';
  if (pct >= 65) return 'warn';
  return 'ok';
}

export const clockShort = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const dateTimeShort = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function QuotaMeterBar({ percent, className }: { percent: number; className?: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  const tone = quotaTone(pct);
  return (
    <svg
      className={className ?? 'quota-meter-svg'}
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect className={`quota-fill-${tone}`} width={pct} height={8} rx={4} />
    </svg>
  );
}

function LimitGauge({
  icon,
  title,
  percent,
  value,
  remaining,
  resetsAt,
  resetLabel,
  status,
  now,
}: {
  icon: ReactNode;
  title: string;
  percent: number | null;
  value?: string;
  remaining: string;
  resetsAt?: string | null;
  resetLabel?: (iso: string) => string;
  status?: string;
  now: number;
}) {
  const pct = Math.min(100, Math.max(0, percent ?? 0));
  const tone = quotaTone(pct);
  return (
    <div className="quota-gauge">
      <div className="quota-gauge-head">
        <span className="quota-gauge-title">
          {icon} {title}
        </span>
        <strong className={`mono${value ? '' : ` quota-text-${tone}`}`}>
          {value ?? (percent === null ? '—' : `${pct}%`)}
        </strong>
      </div>
      <QuotaMeterBar percent={pct} className="quota-gauge-bar" />
      <div className="quota-gauge-foot muted mono">
        <span>{remaining}</span>
        {resetsAt ? (
          <span>
            Resets in {formatCountdown(resetsAt, now)}
            {resetLabel ? ` (${resetLabel(resetsAt)})` : ''}
          </span>
        ) : (
          status && <span>{status}</span>
        )}
      </div>
    </div>
  );
}

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
    <div className="quota-bucket-card">
      <div className="quota-bucket-head">
        <span className="quota-bucket-title">{label}</span>
        <span className="muted mono quota-bucket-sub">
          {sublabel} · {bucket.turnCount} turns
        </span>
      </div>
      <div className="quota-bucket-total">
        <strong className="mono">{formatTokensCompact(bucket.totalTokens)}</strong>
        <span className="muted">total tokens</span>
      </div>
      <div className="mono muted quota-bucket-grid">
        <span>In: {formatTokensCompact(bucket.inputTokens)}</span>
        <span>Out: {formatTokensCompact(bucket.outputTokens)}</span>
        <span>Cache R: {formatTokensCompact(bucket.cacheReadTokens)}</span>
        <span>Cache W: {formatTokensCompact(bucket.cacheCreationTokens)}</span>
      </div>
    </div>
  );
}

export function QuotaUsageDetails({
  usage,
  fivePct,
  sevenPct,
  providerTelemetry,
  now,
}: {
  usage: ClaudeUsageTelemetry | null;
  fivePct: number;
  sevenPct: number;
  providerTelemetry: readonly ProviderTelemetryItem[];
  now: number;
}) {
  if (!usage && providerTelemetry.length === 0) return null;

  return (
    <Disclosure label="Usage details">
      <div className="quota-details-stack">
        {usage && (
          <>
            <p className="muted quota-details-note mono">
              {formatClaudePlanLabel(usage)} · OAuth {usage.authenticated ? 'active' : 'inactive'}
              {usage.tokenExpiresAt ? ` (valid ${formatCountdown(usage.tokenExpiresAt, now)})` : ''}
              {usage.limitsUpdatedAt
                ? ` · reported ${dateTimeShort(usage.limitsUpdatedAt)}.`
                : ' · limits appear after the next Claude run.'}
            </p>
            <div className="quota-gauges">
              <LimitGauge
                icon={<Timer className="icon" aria-hidden="true" />}
                title="5-hour session limit"
                percent={usage.fiveHour ? fivePct : null}
                remaining={`${100 - fivePct}% remaining in 5h window`}
                resetsAt={usage.fiveHour?.resetsAt ?? null}
                resetLabel={clockShort}
                now={now}
              />
              <LimitGauge
                icon={<Calendar className="icon" aria-hidden="true" />}
                title="7-day weekly limit"
                percent={usage.sevenDay ? sevenPct : null}
                remaining={`${100 - sevenPct}% remaining this week`}
                resetsAt={usage.sevenDay?.resetsAt ?? null}
                resetLabel={dateTimeShort}
                now={now}
              />
              {usage.extraUsage &&
                (usage.extraUsage.enabled ||
                  usage.extraUsage.limitUsd > 0 ||
                  usage.extraUsage.usedUsd > 0) && (
                  <LimitGauge
                    icon={<CreditCard className="icon" aria-hidden="true" />}
                    title="Extra usage credits"
                    percent={Math.round(usage.extraUsage.utilizationPercent ?? 0)}
                    value={`$${usage.extraUsage.usedUsd.toFixed(2)}${usage.extraUsage.limitUsd > 0 ? ` / $${usage.extraUsage.limitUsd.toFixed(2)}` : ''}`}
                    remaining={`Monthly overflow (${Math.round(usage.extraUsage.utilizationPercent ?? 0)}%)`}
                    status={
                      usage.extraUsage.enabled
                        ? 'Active'
                        : usage.extraUsage.disabledReason
                          ? `Paused (${usage.extraUsage.disabledReason})`
                          : 'Disabled'
                    }
                    now={now}
                  />
                )}
            </div>

            <div className="quota-gauges">
              <TokenBucketCard
                label={
                  <>
                    <Zap className="icon" aria-hidden="true" /> Hourly token usage
                  </>
                }
                sublabel="Last 1h"
                bucket={usage.hourlyTokens}
              />
              <TokenBucketCard
                label={
                  <>
                    <Clock className="icon" aria-hidden="true" /> Daily token usage
                  </>
                }
                sublabel="Last 24h"
                bucket={usage.dailyTokens}
              />
              <TokenBucketCard
                label={
                  <>
                    <ChartColumn className="icon" aria-hidden="true" /> Weekly token usage
                  </>
                }
                sublabel="Last 7d"
                bucket={usage.weeklyTokens}
              />
            </div>

            {providerTelemetry.some((p) => p.providerId === 'antigravity') && (
              <p className="muted quota-details-note">
                Antigravity does not expose a live quota endpoint; when a run hits a limit, its reset time
                appears in the lane row above.
              </p>
            )}
          </>
        )}

        {providerTelemetry.length > 0 && (
          <div className="quota-buckets-grid">
            {providerTelemetry.map((p) => (
              <div key={p.providerId} className="quota-bucket-card">
                <div className="quota-bucket-head">
                  <span className="quota-bucket-title">
                    <ProviderMark id={p.entry.id} />
                    {p.entry.shortLabel}
                  </span>
                  <span className={`badge mono ${p.authenticated ? 'quota-state-ok' : 'quota-state-paused'}`}>
                    {p.authenticated ? 'Ready' : 'Unconfigured'}
                  </span>
                </div>
                <span className="muted mono quota-bucket-sub">{p.authLabel}</span>
                <div className="mono muted quota-provider-counts">
                  <span>
                    Active: <strong>{p.activeCount}</strong>
                  </span>
                  <span>
                    Done: <strong>{p.doneCount}</strong>
                  </span>
                  <span>
                    Failed: <strong>{p.failedCount}</strong>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Disclosure>
  );
}

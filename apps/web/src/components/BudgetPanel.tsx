import type { Project, ProjectUsageResponse } from '@emberline/protocol';
import { useApi } from '../hooks/useApi';
import { formatTokensCompact } from './QuotaPanel';

const formatDuration = (sec: number) =>
  sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`;

/**
 * Per-project usage over the last 7 days and the factory guardrails (daily run budget, ticket
 * depth). Token counts come from agent transcripts when available; otherwise they are estimates
 * and marked as such. There is no money figure: runs use the subscription, not per-token billing.
 */
export function BudgetPanel({ project }: { project: Project }) {
  const usage = useApi<ProjectUsageResponse>(`/api/projects/${project.id}/usage?days=7`, 30_000);
  const data = usage.data;
  if (!data) return null;
  const totals = data.days.reduce(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      tokens: acc.tokens + d.inputTokens + d.outputTokens,
      duration: acc.duration + d.durationSec,
      estimated: acc.estimated + d.estimatedRuns,
    }),
    { runs: 0, tokens: 0, duration: 0, estimated: 0 },
  );
  const maxTokens = Math.max(1, ...data.days.map((d) => d.inputTokens + d.outputTokens));
  const budget = data.maxAutoRunsPerProjectPerDay;

  return (
    <section className="panel" aria-labelledby="budget-title">
      <header className="panel-head">
        <div>
          <h2 id="budget-title">Usage &amp; budget · {project.name}</h2>
          <p className="muted">
            Last 7 days: {totals.runs} runs, {formatTokensCompact(totals.tokens)} tokens, {formatDuration(totals.duration)}{' '}
            of agent time.
            {totals.estimated > 0 && ` Tokens of ${totals.estimated} run(s) are estimated (no transcript usage).`}
          </p>
        </div>
        <div className="actions">
          <span
            className={`badge mono${data.budgetExhausted ? ' badge-warn' : ''}`}
            title="Runs started for this project in the last 24 hours, against the auto-dispatch budget (Settings)"
          >
            {data.runsLast24h}/{budget === 0 ? '∞' : budget} runs · 24h
          </span>
          <span className="badge badge-soft mono" title="Generations of agent-created tickets allowed (Settings)">
            ticket depth ≤ {data.maxTicketDepth}
          </span>
        </div>
      </header>
      {data.budgetExhausted && (
        <p className="banner banner-warn" role="status">
          Daily run budget reached: auto-dispatch is paused for this project until older runs leave the 24-hour
          window. Manual starts still work; raise the budget in Settings if this is intended.
        </p>
      )}
      <div className="usage-bars" role="list">
        {data.days.map((d) => {
          const tokens = d.inputTokens + d.outputTokens;
          return (
            <div
              key={d.date}
              className="usage-day"
              role="listitem"
              title={`${d.date}: ${d.runs} runs · ${formatTokensCompact(d.inputTokens)} in / ${formatTokensCompact(d.outputTokens)} out (${formatTokensCompact(d.cachedTokens)} cached) · ${d.toolCalls} tool calls · ${formatDuration(d.durationSec)}${d.estimatedRuns > 0 ? ` · ${d.estimatedRuns} estimated` : ''}`}
            >
              <div className="usage-bar-track">
                <div className="usage-bar" style={{ height: `${Math.round((tokens / maxTokens) * 100)}%` }} />
              </div>
              <span className="usage-day-label mono">{d.date.slice(5)}</span>
              <span className="usage-day-runs muted mono">{d.runs}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

import {
  type AgentId,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  PROVIDER_REGISTRY,
  type Run,
} from '@emberline/protocol';
import { ProviderMark } from '../ProviderMark';
import { formatClaudePlanLabel, formatTokensCompact } from '../QuotaPanel';

export function SidebarProviderTelemetry({
  activeProviders,
  currentProvider,
  onSelectProvider,
  factorySettings,
  claudeUsage,
  allRuns,
}: {
  activeProviders: AgentId[];
  currentProvider: AgentId;
  onSelectProvider: (id: AgentId) => void;
  factorySettings: FactorySettings | undefined;
  claudeUsage: ClaudeUsageTelemetry | undefined;
  allRuns: Run[] | undefined;
}) {
  const entry = PROVIDER_REGISTRY[currentProvider];
  const authInfo = factorySettings?.providerAuth?.[currentProvider];
  const isClaude = currentProvider === 'claude';
  const isAuthed = authInfo?.authenticated ?? (isClaude ? Boolean(claudeUsage?.authenticated) : true);
  const providerBucket =
    claudeUsage?.providerTokens?.[currentProvider] ??
    (isClaude && claudeUsage
      ? {
          hourlyTokens: claudeUsage.hourlyTokens,
          dailyTokens: claudeUsage.dailyTokens,
          weeklyTokens: claudeUsage.weeklyTokens,
        }
      : undefined);
  const providerRuns = (allRuns ?? []).filter((r) => r.agent === currentProvider);
  const activeProviderRuns = providerRuns.filter(
    (r) => !r.endedAt && r.state !== 'done' && r.state !== 'failed',
  ).length;
  const doneProviderRuns = providerRuns.filter((r) => r.state === 'done').length;

  return (
    <div id="sidebar-provider-telemetry" className="sidebar-telemetry mono muted">
      {activeProviders.length > 1 && (
        <div role="tablist" aria-label="Providers" className="sidebar-telemetry-tabs">
          {activeProviders.map((pid) => {
            const pEntry = PROVIDER_REGISTRY[pid];
            const pAuth =
              factorySettings?.providerAuth?.[pid]?.authenticated ??
              (pid === 'claude' ? Boolean(claudeUsage?.authenticated) : true);
            const selected = pid === currentProvider;
            return (
              <button
                key={pid}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`sidebar-telemetry-tab${selected ? ' active' : ''}`}
                onClick={() => onSelectProvider(pid)}
                title={pEntry.shortLabel}
              >
                <span className={`sidebar-telemetry-dot${pAuth ? ' ok' : ' warn'}`} />
                <span>
                  <ProviderMark id={pEntry.id} />
                  {pEntry.shortLabel}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="sidebar-telemetry-row sidebar-telemetry-head">
        <strong>
          <ProviderMark id={entry.id} />
          {isClaude ? formatClaudePlanLabel(claudeUsage) : entry.shortLabel}
        </strong>
        <span className={`sidebar-telemetry-status ${isAuthed ? 'ok' : 'warn'}`}>
          ● {isAuthed ? 'active' : 'setup'}
        </span>
      </div>

      {isClaude && claudeUsage ? (
        <div className="sidebar-telemetry-row">
          <span>5h: {Math.round(claudeUsage.fiveHour?.utilizationPercent ?? 0)}%</span>
          <span>7d: {Math.round(claudeUsage.sevenDay?.utilizationPercent ?? 0)}%</span>
        </div>
      ) : (
        <div className="sidebar-telemetry-row">
          <span>Turns: {providerBucket?.weeklyTokens?.turnCount ?? 0}</span>
          <span>
            Runs: {activeProviderRuns > 0 ? `${activeProviderRuns} live / ` : ''}
            {doneProviderRuns} done
          </span>
        </div>
      )}

      <div className="sidebar-telemetry-row">
        <span>1h: {formatTokensCompact(providerBucket?.hourlyTokens?.totalTokens ?? 0)}</span>
        <span>7d: {formatTokensCompact(providerBucket?.weeklyTokens?.totalTokens ?? 0)}</span>
      </div>
    </div>
  );
}

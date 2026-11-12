import type {
  CrossCriticResult,
  DiffScope,
  Run,
  RunDiffSummary,
  RunForgeStatus,
  RunPreviewStatus,
  SlopAuditReport,
} from '@emberline/protocol';
import { Coins, Lock, Scale, Shield, TriangleAlert, Wrench } from 'lucide-react';
import { Link } from 'wouter';

interface Props {
  run: Run;
  subTab: 'diff' | 'artifacts';
  onSubTabChange: (tab: 'diff' | 'artifacts') => void;
  scope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  summary: RunDiffSummary | null;
  artifactsCount: number;
  slopAudit: SlopAuditReport | null;
  crossCritic: CrossCriticResult | null;
  runningCritic: boolean;
  onToggleHygieneDrawer: () => void;
  onRunCrossCritic: () => void;
  previewStatus: RunPreviewStatus | null;
  previewBusy: boolean;
  previewDrawerOpen: boolean;
  onTogglePreviewDrawer: () => void;
  onStopPreview: () => void;
  forgeStatus: RunForgeStatus | null;
  prDrawerOpen: boolean;
  onTogglePrDrawer: () => void;
  renderSideBySide: boolean;
  onToggleSideBySide: () => void;
  loading: boolean;
  onRefresh: () => void;
  onOpenShortcuts: () => void;
}

export function ReviewToolbar({
  run,
  subTab,
  onSubTabChange,
  scope,
  onScopeChange,
  summary,
  artifactsCount,
  slopAudit,
  crossCritic,
  runningCritic,
  onToggleHygieneDrawer,
  onRunCrossCritic,
  previewStatus,
  previewBusy,
  previewDrawerOpen,
  onTogglePreviewDrawer,
  onStopPreview,
  forgeStatus,
  prDrawerOpen,
  onTogglePrDrawer,
  renderSideBySide,
  onToggleSideBySide,
  loading,
  onRefresh,
  onOpenShortcuts,
}: Props) {
  const totalAdditions = summary?.totalAdditions ?? 0;
  const totalDeletions = summary?.totalDeletions ?? 0;

  return (
    <div className="review-toolbar">
      <div className="review-toolbar-group">
        <div className="segmented" role="tablist" aria-label="Review mode">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'diff'}
            className={subTab === 'diff' ? 'active review-tabular' : 'review-tabular'}
            onClick={() => onSubTabChange('diff')}
          >
            Diff &amp; Git ({summary?.files.length ?? 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'artifacts'}
            className={subTab === 'artifacts' ? 'active review-tabular' : 'review-tabular'}
            onClick={() => onSubTabChange('artifacts')}
          >
            Artifacts ({artifactsCount})
          </button>
        </div>

        {subTab === 'diff' && (
          <>
            <div className="segmented" role="tablist" aria-label="Diff scope">
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'branch'}
                className={scope === 'branch' ? 'active' : ''}
                onClick={() => onScopeChange('branch')}
                title="All changes on this branch vs base branch"
              >
                Branch vs {summary?.baseBranch ?? 'base'}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'unstaged'}
                className={scope === 'unstaged' ? 'active' : ''}
                onClick={() => onScopeChange('unstaged')}
                title="Unstaged working tree changes"
              >
                Unstaged
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'staged'}
                className={scope === 'staged' ? 'active' : ''}
                onClick={() => onScopeChange('staged')}
                title="Staged index changes"
              >
                Staged
              </button>
            </div>

            <span className="badge mono review-tabular">
              <span style={{ color: 'var(--ok)' }}>+{totalAdditions}</span>
              {' / '}
              <span style={{ color: 'var(--danger)' }}>-{totalDeletions}</span>
            </span>

            {summary && summary.aheadCount > 0 && (
              <span className="badge badge-soft mono review-tabular">{summary.aheadCount} ahead</span>
            )}

            {run.telemetry && run.telemetry.totalTokens > 0 && (
              <span
                className="badge badge-soft mono review-tabular"
                title={`Input: ${run.telemetry.inputTokens.toLocaleString()} tok · Output: ${run.telemetry.outputTokens.toLocaleString()} tok${
                  run.telemetry.cachedTokens > 0
                    ? ` · Cached: ${run.telemetry.cachedTokens.toLocaleString()} tok`
                    : ''
                } · Tool Calls: ${run.telemetry.toolCalls} · Duration: ${run.telemetry.durationSec}s${
                  run.telemetry.isEstimated ? ' (estimated)' : ''
                }`}
              >
                <Coins className="icon" aria-hidden /> {(run.telemetry.totalTokens / 1000).toFixed(1)}k tok ·{' '}
                <Wrench className="icon" aria-hidden /> {run.telemetry.toolCalls}
              </span>
            )}

            {slopAudit && (
              <>
                <button
                  type="button"
                  className="badge mono review-tabular"
                  onClick={onToggleHygieneDrawer}
                  style={{
                    cursor: 'pointer',
                    borderColor:
                      slopAudit.secretGuardPassed !== false
                        ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                        : 'color-mix(in srgb, var(--bad) 65%, transparent)',
                    color: slopAudit.secretGuardPassed !== false ? 'var(--ok)' : 'var(--bad)',
                    background:
                      slopAudit.secretGuardPassed !== false
                        ? 'color-mix(in srgb, var(--ok) 8%, transparent)'
                        : 'color-mix(in srgb, var(--bad) 18%, transparent)',
                  }}
                  title="Pre-Commit Secret & Credential Guard — scans for leaked API keys, tokens, private keys, and .env files"
                >
                  {slopAudit.secretGuardPassed !== false ? (
                    <>
                      <Lock className="icon" aria-hidden /> Secrets: CLEAN
                    </>
                  ) : (
                    <>
                      <TriangleAlert className="icon" aria-hidden /> Secret Leak ({slopAudit.secretLeakCount})
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="badge mono review-tabular"
                  onClick={onToggleHygieneDrawer}
                  style={{
                    cursor: 'pointer',
                    borderColor: slopAudit.passed
                      ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                      : 'color-mix(in srgb, var(--bad) 50%, transparent)',
                    color: slopAudit.passed ? 'var(--ok)' : 'var(--bad)',
                    background: slopAudit.passed
                      ? 'color-mix(in srgb, var(--ok) 10%, transparent)'
                      : 'color-mix(in srgb, var(--bad) 12%, transparent)',
                  }}
                  title="Click to inspect Anti-AI-Slop & Code Hygiene Audit Scorecard"
                >
                  {slopAudit.passed ? (
                    <Shield className="icon" aria-hidden />
                  ) : (
                    <TriangleAlert className="icon" aria-hidden />
                  )}{' '}
                  Hygiene {slopAudit.grade} · {slopAudit.score}/100
                  {slopAudit.issues.length > 0 ? ` (${slopAudit.issues.length})` : ''}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="review-toolbar-group">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={runningCritic}
          onClick={onRunCrossCritic}
          style={{
            borderColor: crossCritic
              ? crossCritic.verdict === 'PASS'
                ? 'color-mix(in srgb, var(--ok) 40%, transparent)'
                : 'color-mix(in srgb, var(--warn) 50%, transparent)'
              : undefined,
          }}
          title="Have a rival AI provider audit this run's diff against the ticket specification and Anti-Slop rules"
        >
          <Scale className="icon" aria-hidden />{' '}
          {runningCritic
            ? 'Auditing…'
            : crossCritic
              ? `${crossCritic.reviewSource === 'rival' ? crossCritic.reviewerAgent.toUpperCase() : 'Audit'}: ${crossCritic.verdict}`
              : 'Cross-Provider Critic'}
        </button>

        {previewStatus?.status === 'running' ||
        previewStatus?.status === 'starting' ||
        (previewStatus?.status === 'failed' && previewStatus.downFailed) ? (
          <>
            {previewStatus.status === 'starting' && (
              <span
                className="badge badge-soft mono review-tabular"
                title={previewStatus.command ?? undefined}
              >
                Preview starting :{previewStatus.port}…
              </span>
            )}
            {previewStatus.status === 'running' && previewStatus.url && (
              <a
                href={previewStatus.url}
                target="_blank"
                rel="noreferrer"
                className="badge badge-soft mono review-tabular"
                title={`Preview running (${previewStatus.command ?? 'dev'})`}
              >
                Preview :{previewStatus.port} ↗
              </a>
            )}
            {previewStatus.terminalId && (
              <Link
                href={`/terminals/${previewStatus.terminalId}`}
                className="btn btn-sm btn-ghost"
                title="View live preview server logs"
              >
                Logs
              </Link>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={previewBusy}
              onClick={onStopPreview}
            >
              Stop Preview
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onTogglePreviewDrawer}
            title="Start an isolated preview dev server for this worktree"
          >
            {previewDrawerOpen ? 'Cancel Preview' : 'Preview Server'}
          </button>
        )}

        {forgeStatus?.pullRequest ? (
          <a
            href={forgeStatus.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="badge badge-soft mono review-tabular"
            title={forgeStatus.pullRequest.title}
          >
            {forgeStatus.provider === 'gitlab' ? 'MR !' : 'PR #'}
            {forgeStatus.pullRequest.number} · {forgeStatus.pullRequest.state}
            {forgeStatus.pullRequest.ciStatus !== 'unknown'
              ? ` · CI: ${forgeStatus.pullRequest.ciStatus}`
              : ''}{' '}
            ↗
          </a>
        ) : (
          <>
            {forgeStatus?.compareUrl && (
              <a
                href={forgeStatus.compareUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm btn-ghost"
                title="Open branch comparison / new PR page in browser"
              >
                Compare ↗
              </a>
            )}
            {run.branch && (
              <button type="button" className="btn btn-sm" onClick={onTogglePrDrawer}>
                {prDrawerOpen ? 'Cancel PR' : 'Create PR / MR'}
              </button>
            )}
          </>
        )}

        {subTab === 'diff' && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onToggleSideBySide}>
            {renderSideBySide ? 'Inline Diff' : 'Split Diff'}
          </button>
        )}

        <button
          type="button"
          className="btn btn-sm btn-ghost review-shortcut-btn"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <kbd className="kbd">?</kbd>
        </button>

        <button type="button" className="btn btn-sm btn-ghost" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>
    </div>
  );
}

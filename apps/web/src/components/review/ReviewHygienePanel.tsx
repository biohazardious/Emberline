import type { CrossCriticResult, SlopAuditReport } from '@emberline/protocol';
import { Eraser, Lightbulb, LoaderCircle, Rocket, Scale, Shield } from 'lucide-react';

interface Props {
  slopAudit: SlopAuditReport | null;
  crossCritic: CrossCriticResult | null;
  runningCritic: boolean;
  cleaningSlop: boolean;
  agentDisplayName: string;
  onAutoCleanSlop: (customPrompt?: string | null) => void;
  onRunCrossCritic: () => void;
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
}

export function ReviewHygienePanel({
  slopAudit,
  crossCritic,
  runningCritic,
  cleaningSlop,
  agentDisplayName,
  onAutoCleanSlop,
  onRunCrossCritic,
  onSelectFile,
  onClose,
}: Props) {
  if (!slopAudit && !crossCritic) return null;

  return (
    <div className="review-actions-bar review-hygiene-panel">
      <div className="review-hygiene-head">
        <div className="review-hygiene-badges">
          <strong style={{ fontSize: '0.84rem' }}>
            <Shield className="icon" aria-hidden /> Anti-AI-Slop &amp; Code Craftsmanship Audit
          </strong>
          {slopAudit && (
            <span className="badge mono review-tabular" style={{ fontSize: '0.7rem' }}>
              Grade {slopAudit.grade} · {slopAudit.score}/100 · {slopAudit.filesAudited} file(s) · +
              {slopAudit.addedLinesAudited} lines scanned
            </span>
          )}
          {crossCritic && (
            <span
              className="badge mono review-tabular"
              style={{
                fontSize: '0.7rem',
                borderColor:
                  crossCritic.verdict === 'PASS'
                    ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                    : 'color-mix(in srgb, var(--warn) 45%, transparent)',
                color: crossCritic.verdict === 'PASS' ? 'var(--ok)' : 'var(--warn)',
              }}
            >
              <Scale className="icon" aria-hidden />{' '}
              {crossCritic.reviewSource === 'rival'
                ? `${crossCritic.authorAgent.toUpperCase()} → reviewed by ${crossCritic.reviewerAgent.toUpperCase()} (${crossCritic.reviewerModel})`
                : 'Deterministic audit only (rival review did not run)'}
              : {crossCritic.verdict}
            </span>
          )}
        </div>

        <div className="review-hygiene-actions">
          {slopAudit?.autoFixPrompt && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={cleaningSlop}
              onClick={() => onAutoCleanSlop(slopAudit.autoFixPrompt)}
              title="Send all detected slop/hygiene findings back to the agent to clean automatically"
            >
              {cleaningSlop ? (
                <>
                  <LoaderCircle className="icon icon-spin" aria-hidden /> Dispatching…
                </>
              ) : (
                <>
                  <Eraser className="icon" aria-hidden /> Auto-Clean Slop ({slopAudit.issues.length})
                </>
              )}
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={runningCritic} onClick={onRunCrossCritic}>
            {runningCritic ? (
              <>
                <LoaderCircle className="icon icon-spin" aria-hidden /> Running Critic…
              </>
            ) : (
              <>
                <Scale className="icon" aria-hidden /> Re-Run Cross-Provider Critic
              </>
            )}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Hide
          </button>
        </div>
      </div>

      {crossCritic && (
        <div className="review-critic-summary-box">
          <div>
            <strong>
              <Scale className="icon" aria-hidden /> Cross-Provider Critic Summary:
            </strong>{' '}
            {crossCritic.summary}
          </div>
          {crossCritic.followUpPrompt && (
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={cleaningSlop}
              onClick={() => onAutoCleanSlop(crossCritic.followUpPrompt)}
            >
              <Rocket className="icon" aria-hidden /> Send Critic Fixes to {agentDisplayName}
            </button>
          )}
        </div>
      )}

      {slopAudit && slopAudit.issues.length === 0 ? (
        <div className="muted small" style={{ color: 'var(--ok)' }}>
          ✓ Clean diff: zero <code>any</code> evasions, zero unfinished <code>TODO</code>/<code>FIXME</code>{' '}
          stubs, zero skipped tests, and zero vibe-coding clichés detected.
        </div>
      ) : (
        slopAudit && (
          <div className="review-hygiene-issue-list">
            {slopAudit.issues.map((iss) => (
              <button
                key={iss.id}
                type="button"
                onClick={() => onSelectFile(iss.file)}
                className={`review-hygiene-issue-card ${iss.severity === 'error' ? 'is-error' : 'is-warn'}`}
                title="Click to open file in diff viewer"
              >
                <div className="review-hygiene-issue-top">
                  <span className="mono review-tabular" style={{ fontWeight: 600 }}>
                    <span style={{ color: iss.severity === 'error' ? 'var(--bad)' : 'var(--warn)' }}>
                      [{iss.severity.toUpperCase()} · {iss.category}]
                    </span>{' '}
                    {iss.file}:{iss.line} — {iss.message}
                  </span>
                  <code className="muted mono" style={{ fontSize: '0.68rem' }}>
                    {iss.snippet}
                  </code>
                </div>
                <div className="muted small" style={{ fontSize: '0.71rem' }}>
                  <Lightbulb className="icon" aria-hidden /> Fix: {iss.fixHint}
                </div>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

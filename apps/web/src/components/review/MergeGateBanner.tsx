import { CheckCircle2, OctagonAlert } from 'lucide-react';
import { Link } from 'wouter';
import type { MergeGateSummary } from '../../reviewGate';

interface Props {
  gate: MergeGateSummary;
  busy?: boolean;
  onJumpToComment: (commentId: string) => void;
  onVerifyCarried: () => void;
  onOpenShortcuts?: () => void;
}

export function MergeGateBanner({
  gate,
  busy = false,
  onJumpToComment,
  onVerifyCarried,
  onOpenShortcuts,
}: Props) {
  if (!gate.loaded && !gate.isBlocked) {
    return null;
  }

  if (!gate.isBlocked) {
    return (
      <div className="review-gate-summary review-gate-open" role="status" aria-label="Merge gate status">
        <div className="review-gate-head">
          <span className="review-gate-pill review-gate-pill-ok mono">
            <CheckCircle2 className="icon" aria-hidden /> Merge gate ready
          </span>
          <span className="muted small review-tabular">0 blocking reasons</span>
        </div>
        {onOpenShortcuts && (
          <div className="review-gate-kbd-hints hide-sm">
            <span className="muted small">
              <kbd className="kbd">j</kbd>/<kbd className="kbd">k</kbd> file · <kbd className="kbd">n</kbd>/
              <kbd className="kbd">p</kbd> comment · <kbd className="kbd">c</kbd> comment ·{' '}
              <kbd className="kbd">b</kbd> blocking
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost review-shortcut-btn"
              onClick={onOpenShortcuts}
              aria-label="Open keyboard shortcuts"
            >
              <kbd className="kbd">?</kbd> Shortcuts
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      className="review-gate-summary review-gate-blocked banner banner-warn review-blocking-banner"
      role="alert"
      aria-label="Merge gate blocking reasons"
    >
      <div className="review-gate-head">
        <div className="review-gate-head-main">
          <span className="review-gate-pill review-gate-pill-blocked mono review-tabular">
            <OctagonAlert className="icon" aria-hidden /> Merge gate blocked ({gate.blockingOpen})
          </span>
          <span className="review-gate-headline">{gate.headline}</span>
        </div>
        {onOpenShortcuts && (
          <button
            type="button"
            className="btn btn-sm btn-ghost review-shortcut-btn"
            onClick={onOpenShortcuts}
            aria-label="Open keyboard shortcuts"
          >
            <kbd className="kbd">?</kbd> Shortcuts
          </button>
        )}
      </div>

      <ul className="review-gate-reasons" aria-label="Blocking reasons">
        {gate.blockingComments.map((item) => (
          <li key={item.id} className="review-gate-reason-item">
            <a
              href={item.href}
              className="review-gate-link mono review-tabular"
              onClick={(e) => {
                e.preventDefault();
                onJumpToComment(item.id);
              }}
            >
              <span className="review-gate-link-path">{item.filePath}</span>
              <span className="review-gate-link-loc">{item.location}</span>
            </a>
            <span className="badge comment-badge-blocking mono">{item.status}</span>
            {!item.inDiff && <span className="badge badge-soft mono">off-diff</span>}
            <span className="review-gate-excerpt">{item.excerpt}</span>
          </li>
        ))}

        {gate.predecessorBlocking && (
          <li className="review-gate-reason-item">
            <span className="badge comment-badge-blocking mono review-tabular">
              {gate.predecessorBlocking.count} predecessor
            </span>
            <span>
              {gate.predecessorBlocking.count} unresolved blocking comment
              {gate.predecessorBlocking.count === 1 ? '' : 's'} carried across handoff
              {gate.predecessorBlocking.predecessorRunId && (
                <>
                  {' · '}
                  <Link
                    href={`/runs/${gate.predecessorBlocking.predecessorRunId}/review`}
                    className="review-gate-link mono"
                  >
                    Inspect run {gate.predecessorBlocking.predecessorRunId.slice(0, 8)}
                  </Link>
                </>
              )}
            </span>
          </li>
        )}

        {gate.carriedBlocking && (
          <li className="review-gate-reason-item review-gate-carried-row">
            <span className="badge comment-badge-blocking mono review-tabular">
              {gate.carriedBlocking.count} carried
            </span>
            <span className="review-gate-carried-text">
              {gate.carriedBlocking.message}
              {gate.carriedBlocking.fromRun && (
                <>
                  {' ('}
                  <Link
                    href={`/runs/${gate.carriedBlocking.fromRun}/review`}
                    className="review-gate-link mono"
                  >
                    {gate.carriedBlocking.fromRun.slice(0, 8)}
                  </Link>
                  {')'}
                </>
              )}
              .
            </span>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={onVerifyCarried}
            >
              Verified
            </button>
          </li>
        )}

        {gate.holdReasons.map((hold) => (
          <li key={hold.id} className="review-gate-reason-item">
            <span className="badge comment-badge-blocking mono">{hold.label}</span>
            <span>{hold.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

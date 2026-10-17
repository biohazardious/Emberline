import type { RunBuildOutput, RunBuildOutputsResponse } from '@emberline/protocol';
import { Copy, Download, Package } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes } from '../buildOutputs';
import { copyText } from '../clipboard';
import { CopyFallback } from './CopyFallback';
import { timeAgo } from '../time';

/** Text longer than this (or with more lines) starts collapsed. */
const COLLAPSE_CHARS = 420;
const COLLAPSE_LINES = 6;

/** Long text clamped to a few lines, with a toggle to read all of it. */
export function ExpandableText({
  text,
  className = 'event-detail mono',
}: {
  text: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES;
  return (
    <div className="expandable">
      <p className={`${className}${long && !open ? ' expandable-clamped' : ''}`}>{text}</p>
      {long && (
        <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** The agent's last answer, in full. */
export function FinalAnswer({ text }: { text: string }) {
  return (
    <section className="run-outcome" aria-label="Final answer">
      <span className="eyebrow">Final answer</span>
      <ExpandableText text={text} className="run-outcome-text" />
    </section>
  );
}

/** The terminal's last screen, kept after its session closed. */
export function LastScreen({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="run-outcome" aria-label="Last terminal screen">
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
        <span className="eyebrow">{open ? '▾' : '▸'} Last terminal screen</span>
      </button>
      {open && <pre className="run-outcome-screen mono">{text}</pre>}
    </section>
  );
}


/**
 * Deliverables a run built (APKs, installers, firmware), wherever the build wrote them, with their
 * full paths. Renders nothing when there are none.
 */
export function BuildOutputsList({ runId, refreshKey }: { runId: string; refreshKey?: string | null }) {
  const [data, setData] = useState<RunBuildOutputsResponse | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<RunBuildOutputsResponse>(`/api/runs/${runId}/build-outputs`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);

  if (!data || data.outputs.length === 0) return null;
  const fullPath = (o: RunBuildOutput) => `${data.hostWorktreePath ?? data.worktreePath}/${o.path}`;
  return (
    <section className="run-outcome" aria-label="Build outputs">
      <span className="eyebrow">
        <Package className="icon" aria-hidden /> Build outputs ({data.outputs.length})
      </span>
      <ul className="build-outputs">
        {data.outputs.map((o) => (
          <li key={o.path} className="build-output">
            <div className="build-output-main">
              <strong className="mono">{o.name}</strong>
              <span className="muted small">
                {formatBytes(o.sizeBytes)} · {timeAgo(o.mtime)}
                {!o.tracked && ' · not in git (stays in this run’s worktree)'}
              </span>
              <code className="build-output-path mono" title={fullPath(o)}>
                {fullPath(o)}
              </code>
            </div>
            <div className="build-output-actions">
              <button
                type="button"
                className="icon-btn"
                title="Copy the full path"
                onClick={() => void copyText(fullPath(o)).then((ok) => setManualCopy(ok ? null : fullPath(o)))}
              >
                <Copy className="icon" aria-hidden />
              </button>
              <a
                className="icon-btn"
                title="Download"
                href={`/api/runs/${runId}/build-outputs/download?path=${encodeURIComponent(o.path)}`}
                download={o.name}
              >
                <Download className="icon" aria-hidden />
              </a>
            </div>
          </li>
        ))}
      </ul>
      {manualCopy && <CopyFallback text={manualCopy} onClose={() => setManualCopy(null)} />}
    </section>
  );
}

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
                onClick={() =>
                  void copyText(fullPath(o)).then((ok) => setManualCopy(ok ? null : fullPath(o)))
                }
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

export type ConflictEventType =
  'conflict_auto_resolved' | 'conflict_heal_failed' | 'conflict_resolver_started';

export interface ConflictEventInfo {
  type: ConflictEventType;
  summary: string;
  files: string[];
  unresolved: string[];
  commitSha: string | null;
  mainHead: string | null;
  resolverRunId: string | null;
  gateFailure: string | null;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Extracts structured conflict detail and file lists for M5 run timeline events. */
export function conflictEventInfo(type: string, payload: unknown): ConflictEventInfo | null {
  if (
    type !== 'conflict_auto_resolved' &&
    type !== 'conflict_heal_failed' &&
    type !== 'conflict_resolver_started'
  ) {
    return null;
  }
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const filesFromPayload = readStringList(rec.files);
  const conflictsFromPayload = readStringList(rec.conflicts);
  const unresolved = readStringList(rec.unresolved);
  const files =
    filesFromPayload.length > 0
      ? filesFromPayload
      : conflictsFromPayload.length > 0
        ? conflictsFromPayload
        : unresolved;
  const commitSha = readNonEmptyString(rec.commitSha);
  const mainHead = readNonEmptyString(rec.mainHead);
  const resolverRunId = readNonEmptyString(rec.runId);
  const gateFailure = readNonEmptyString(rec.gateFailure);
  const message = readNonEmptyString(rec.message);

  if (type === 'conflict_auto_resolved') {
    const countLabel = files.length > 0 ? ` in ${files.length} ${files.length === 1 ? 'file' : 'files'}` : '';
    const shaLabel = commitSha ? ` (${commitSha.slice(0, 7)})` : '';
    return {
      type,
      summary: message ?? `Auto-resolved additive conflicts${countLabel}${shaLabel}`,
      files,
      unresolved,
      commitSha,
      mainHead,
      resolverRunId,
      gateFailure,
    };
  }

  if (type === 'conflict_heal_failed') {
    const fallback =
      files.length > 0
        ? `Could not auto-resolve ${files.length} ${files.length === 1 ? 'file' : 'files'}`
        : 'Could not auto-resolve merge conflicts';
    return {
      type,
      summary: message ?? fallback,
      files,
      unresolved,
      commitSha,
      mainHead,
      resolverRunId,
      gateFailure,
    };
  }

  const countLabel =
    files.length > 0
      ? ` for ${files.length} ${files.length === 1 ? 'conflicted file' : 'conflicted files'}`
      : '';
  const headLabel = mainHead ? ` against ${mainHead.slice(0, 7)}` : '';
  return {
    type,
    summary: message ?? `Started resolver run${countLabel}${headLabel}`,
    files,
    unresolved,
    commitSha,
    mainHead,
    resolverRunId,
    gateFailure,
  };
}

/** Structured file list and summary rendered inside a run timeline item for conflict events. */
export function ConflictEventDetail({ info }: { info: ConflictEventInfo }) {
  const unresolvedSet = new Set(info.unresolved);
  const showPartialUnresolved = info.unresolved.length > 0 && info.unresolved.length < info.files.length;
  return (
    <div className="conflict-event-detail">
      <p className="event-detail mono">{info.summary}</p>
      {info.files.length > 0 && (
        <ul className="conflict-event-files mono small" aria-label="Conflicted files">
          {info.files.map((file) => (
            <li key={file} className="conflict-event-file">
              <code>{file}</code>
              {showPartialUnresolved && unresolvedSet.has(file) && (
                <span className="muted"> (unresolved)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {info.gateFailure && <ExpandableText text={info.gateFailure} />}
    </div>
  );
}

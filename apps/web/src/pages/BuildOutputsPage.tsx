import type { CollectBuildOutputsResponse, ProjectBuildOutput, ProjectBuildOutputsResponse } from '@emberline/protocol';
import { Check, Copy, Download, Package, Pin, PinOff, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import {
  filterOutputs,
  formatBytes,
  OUTPUT_GROUPS,
  type OutputGroupFilter,
  usageFraction,
  usageText,
} from '../buildOutputs';
import { PERSONA_BY_ID } from '../components/PersonaBadge';
import { useApi } from '../hooks/useApi';
import { useQueryParam } from '../hooks/navigation';
import { timeAgo } from '../time';

/** Shows a build output's origin: the ticket (opens the board drawer), else the run, else "run removed". */
function Origin({ output, projectId }: { output: ProjectBuildOutput; projectId: string }) {
  if (output.ticketId) {
    return (
      <Link href={`/projects/${projectId}/board?ticket=${output.ticketId}`} className="build-outputs-origin">
        {output.ticketKey && <span className="mono">{output.ticketKey}</span>}
        {output.ticketTitle && <span className="build-outputs-ticket-title"> {output.ticketTitle}</span>}
      </Link>
    );
  }
  if (!output.runExists) return <span className="muted small">run removed</span>;
  return (
    <Link href={`/runs/${output.runId}/review`} className="mono build-outputs-origin">
      run {output.runId.slice(0, 8)}
    </Link>
  );
}

function Who({ output }: { output: ProjectBuildOutput }) {
  const parts = [output.persona ? PERSONA_BY_ID[output.persona].label : null, output.agent].filter(Boolean);
  return <span className="muted small">{parts.length ? parts.join(' · ') : '-'}</span>;
}

function Actions({
  output,
  busy,
  confirming,
  copied,
  onCopy,
  onPin,
  onDelete,
}: {
  output: ProjectBuildOutput;
  busy: boolean;
  confirming: boolean;
  copied: boolean;
  onCopy: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="build-outputs-actions">
      <a
        className="icon-btn"
        title="Download"
        aria-label={`Download ${output.name}`}
        href={`/api/build-outputs/${output.id}/download`}
        download={output.name}
      >
        <Download className="icon" aria-hidden />
      </a>
      <button
        type="button"
        className="icon-btn"
        title="Copy the path on the host"
        aria-label={`Copy host path of ${output.name}`}
        onClick={onCopy}
      >
        {copied ? <Check className="icon" aria-hidden /> : <Copy className="icon" aria-hidden />}
      </button>
      <button
        type="button"
        className={`icon-btn${output.pinned ? ' build-outputs-pinned' : ''}`}
        title={output.pinned ? 'Unpin (the quota may delete it)' : 'Pin (never deleted by the quota)'}
        aria-label={output.pinned ? `Unpin ${output.name}` : `Pin ${output.name}`}
        aria-pressed={output.pinned}
        disabled={busy}
        onClick={onPin}
      >
        {output.pinned ? <PinOff className="icon" aria-hidden /> : <Pin className="icon" aria-hidden />}
      </button>
      <button
        type="button"
        className={confirming ? 'btn btn-sm danger' : 'icon-btn'}
        title="Delete this archived file"
        aria-label={confirming ? `Confirm deleting ${output.name}` : `Delete ${output.name}`}
        disabled={busy}
        onClick={onDelete}
      >
        {confirming ? (
          'Click again to confirm'
        ) : (
          <Trash2 className="icon" aria-hidden />
        )}
      </button>
    </div>
  );
}

export function BuildOutputsPage({ projectId }: { projectId: string }) {
  const [runFilter, setRunFilter] = useQueryParam('run');
  const [group, setGroup] = useState<OutputGroupFilter>('all');
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Poll faster while a collect pass runs.
  const [fast, setFast] = useState(false);
  const { data, error: loadError, loading, refresh } = useApi<ProjectBuildOutputsResponse>(
    `/api/projects/${projectId}/build-outputs`,
    fast ? 2_000 : 8_000,
  );
  const collecting = (data?.collecting ?? false) || starting;
  useEffect(() => setFast(collecting), [collecting]);

  // The delete confirmation lapses on its own.
  useEffect(() => {
    if (!confirmId) return;
    const timer = setTimeout(() => setConfirmId(null), 4_000);
    return () => clearTimeout(timer);
  }, [confirmId]);
  useEffect(() => {
    if (!copiedId) return;
    const timer = setTimeout(() => setCopiedId(null), 1_500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  const outputs = useMemo(
    () => filterOutputs(data?.outputs ?? [], { group, query, runId: runFilter }),
    [data?.outputs, group, query, runFilter],
  );
  const pinnedBytes = (data?.outputs ?? []).filter((o) => o.pinned).reduce((sum, o) => sum + o.sizeBytes, 0);
  const quotaFull = data !== undefined && data.quotaBytes > 0 && pinnedBytes >= data.quotaBytes;

  async function collect() {
    setError(null);
    setStarting(true);
    try {
      await api<CollectBuildOutputsResponse>(`/api/projects/${projectId}/build-outputs/collect`, 'POST');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function mutate(output: ProjectBuildOutput, action: () => Promise<unknown>) {
    setError(null);
    setBusyId(output.id);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  function copyPath(output: ProjectBuildOutput) {
    void navigator.clipboard
      ?.writeText(output.hostPath)
      .then(() => setCopiedId(output.id))
      .catch(() => setError('Could not copy to the clipboard.'));
  }

  function actionsFor(o: ProjectBuildOutput) {
    return (
      <Actions
        output={o}
        busy={busyId === o.id}
        confirming={confirmId === o.id}
        copied={copiedId === o.id}
        onCopy={() => copyPath(o)}
        onPin={() => void mutate(o, () => api(`/api/build-outputs/${o.id}`, 'PATCH', { pinned: !o.pinned }))}
        onDelete={() => {
          if (confirmId !== o.id) {
            setConfirmId(o.id);
            return;
          }
          setConfirmId(null);
          void mutate(o, () => api(`/api/build-outputs/${o.id}`, 'DELETE'));
        }}
      />
    );
  }

  const total = data?.outputs.length ?? 0;
  const fraction = data ? usageFraction(data.usedBytes, data.quotaBytes) : 0;
  const last = data?.lastCollect;

  return (
    <div className="board-page build-outputs-page">
      <div className="board-head">
        <div className="board-title">
          <Package className="icon" aria-hidden />
          <h1>Build Outputs</h1>
        </div>
        <button type="button" className="btn btn-sm" disabled={collecting || !data} onClick={() => void collect()}>
          <RefreshCw className={`icon${collecting ? ' icon-spin' : ''}`} aria-hidden />{' '}
          {collecting ? 'Collecting…' : 'Collect now'}
        </button>
      </div>

      {data && (
        <section className="build-outputs-usage" aria-label="Archive usage">
          <div className="build-outputs-usage-line">
            <strong className="mono">{usageText(data.usedBytes, data.quotaBytes)}</strong>
            {quotaFull && <span className="badge badge-bad">quota full</span>}
            <span className="muted small">
              Archive: <code className="mono">{data.hostArchiveDir}</code>
            </span>
          </div>
          <div
            className="build-outputs-meter"
            role="progressbar"
            aria-label="Archive usage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
          >
            <div
              className={`build-outputs-meter-fill${fraction >= 0.9 ? ' warn' : ''}`}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          {quotaFull && (
            <p className="muted small">
              Pinned outputs fill the whole quota, so nothing new is archived. Unpin or delete some, or raise the
              quota in Settings.
            </p>
          )}
          {last && !collecting && (
            <p className="muted small" role="status">
              Last collect {timeAgo(last.finishedAt)}: {last.archived} archived, {last.skipped} unchanged,{' '}
              {last.failed} failed.
            </p>
          )}
        </section>
      )}

      {(error || loadError !== undefined) && (
        <div className="error-text" role="alert">
          {error ?? errorMessage(loadError)}
        </div>
      )}

      {total > 0 && (
        <div className="build-outputs-filters">
          <div className="build-outputs-chips" role="group" aria-label="Filter by type">
            {OUTPUT_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`chip-btn${group === g.id ? ' chip-on' : ''}`}
                aria-pressed={group === g.id}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
            {runFilter && (
              <button type="button" className="chip-btn chip-on" onClick={() => setRunFilter(null)}>
                Run {runFilter.slice(0, 8)} <X className="icon" aria-hidden />
                <span className="sr-only">Clear the run filter</span>
              </button>
            )}
          </div>
          <label className="build-outputs-search">
            <Search className="icon" aria-hidden />
            <input
              type="search"
              className="input"
              placeholder="Search name or ticket"
              aria-label="Search build outputs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      )}

      {loading && !data && <p className="muted" aria-busy="true">Loading…</p>}

      {data && total === 0 && (
        <div className="build-outputs-empty">
          <Package className="icon" aria-hidden />
          <p>
            <strong>No build outputs yet.</strong>
          </p>
          <p className="muted small">
            When a run finishes and has built an APK, installer or firmware image, a copy is kept here so it survives
            cleaning up the worktree. Use Collect now to pick up files from runs that still have a worktree.
          </p>
        </div>
      )}

      {total > 0 && outputs.length === 0 && <p className="muted">No outputs match the filter.</p>}

      {outputs.length > 0 && (
        <>
          <table className="build-outputs-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Ticket / run</th>
                <th>By</th>
                <th>Archived</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((o) => (
                <tr key={o.id}>
                  <td className="build-outputs-name">
                    <strong className="mono">{o.name}</strong>
                    {o.pinned && <span className="badge badge-ok">pinned</span>}
                  </td>
                  <td className="mono">{formatBytes(o.sizeBytes)}</td>
                  <td>
                    <Origin output={o} projectId={projectId} />
                  </td>
                  <td>
                    <Who output={o} />
                  </td>
                  <td className="muted small" title={o.archivedAt}>
                    {timeAgo(o.archivedAt)}
                  </td>
                  <td>{actionsFor(o)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="build-outputs-cards">
            {outputs.map((o) => (
              <li key={o.id} className="build-outputs-card">
                <div className="build-outputs-name">
                  <strong className="mono">{o.name}</strong>
                  {o.pinned && <span className="badge badge-ok">pinned</span>}
                </div>
                <div className="muted small">
                  <span className="mono">{formatBytes(o.sizeBytes)}</span> · {timeAgo(o.archivedAt)}
                </div>
                <Origin output={o} projectId={projectId} />
                <Who output={o} />
                {actionsFor(o)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

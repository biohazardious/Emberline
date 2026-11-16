import type {
  CollectBuildOutputsResponse,
  ProjectBuildOutput,
  ProjectBuildOutputsResponse,
} from '@emberline/protocol';
import { Check, Copy, Download, Package, Pin, PinOff, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import {
  filterOutputs,
  formatBytes,
  OUTPUT_GROUPS,
  type OutputGroup,
  type OutputGroupFilter,
  outputGroup,
  outputPath,
  usageFraction,
  usageText,
} from '../buildOutputs';
import { copyText } from '../clipboard';
import { SearchInput } from '../components/BoardFilterBar';
import { CopyFallback } from '../components/CopyFallback';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { HelpHint, MoreMenu, PageHeader } from '../components/ui';
import { useQueryParam } from '../hooks/navigation';
import { useApi } from '../hooks/useApi';
import { timeAgo } from '../time';
import './build-outputs-ux.css';

const KIND_LABEL: Record<OutputGroup, string> = {
  android: 'APK / AAB',
  installer: 'Installer',
  firmware: 'Firmware',
  other: 'Other',
};

/** Shows a build output's origin: the ticket (opens the board drawer), else the run, else "run removed". */
function Origin({ output, projectId }: { output: ProjectBuildOutput; projectId: string }) {
  if (output.ticketId) {
    return (
      <Link
        href={`/projects/${projectId}/board?ticket=${output.ticketId}`}
        className="mono build-outputs-ux-origin"
      >
        {output.ticketKey ?? output.ticketTitle ?? 'ticket'}
      </Link>
    );
  }
  if (!output.runExists) return <span className="muted small">run removed</span>;
  return (
    <Link href={`/runs/${output.runId}/review`} className="mono build-outputs-ux-origin">
      run {output.runId.slice(0, 8)}
    </Link>
  );
}

function RowActions({
  output,
  busy,
  copied,
  onCopy,
  onPin,
  onDelete,
}: {
  output: ProjectBuildOutput;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const where = outputPath(output).where === 'host' ? 'on host' : 'in container';
  return (
    <div className="build-outputs-ux-actions">
      <a
        className="btn btn-sm"
        aria-label={`Download ${output.name}`}
        href={`/api/build-outputs/${output.id}/download`}
        download={output.name}
      >
        <Download className="icon" aria-hidden="true" /> Download
      </a>
      <MoreMenu
        ariaLabel={`More actions for ${output.name}`}
        items={[
          {
            id: 'pin',
            label: output.pinned ? 'Unpin' : 'Pin',
            icon: output.pinned ? (
              <PinOff className="icon" aria-hidden="true" />
            ) : (
              <Pin className="icon" aria-hidden="true" />
            ),
            disabled: busy,
            onSelect: onPin,
          },
          {
            id: 'copy',
            label: copied ? 'Copied path' : `Copy path (${where})`,
            icon: copied ? (
              <Check className="icon" aria-hidden="true" />
            ) : (
              <Copy className="icon" aria-hidden="true" />
            ),
            onSelect: onCopy,
          },
          {
            id: 'delete',
            label: 'Delete',
            icon: <Trash2 className="icon" aria-hidden="true" />,
            danger: true,
            disabled: busy,
            onSelect: onDelete,
          },
        ]}
      />
    </div>
  );
}

export function BuildOutputsPage({ projectId }: { projectId: string }) {
  const [runFilter, setRunFilter] = useQueryParam('run');
  const [group, setGroup] = useState<OutputGroupFilter>('all');
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // With a run filter the list also reports that run's handoff chain, which the filter matches.
  const runQuery = runFilter ? `?run=${encodeURIComponent(runFilter)}` : '';
  // Poll faster while a collect pass runs.
  const {
    data,
    error: loadError,
    loading,
    refresh,
  } = useApi<ProjectBuildOutputsResponse>(`/api/projects/${projectId}/build-outputs${runQuery}`, (latest) =>
    starting || latest?.collecting ? 2_000 : 8_000,
  );
  const collecting = (data?.collecting ?? false) || starting;

  useEffect(() => {
    if (!copiedId) return;
    const timer = setTimeout(() => setCopiedId(null), 1_500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  const outputs = useMemo(
    () =>
      filterOutputs(data?.outputs ?? [], {
        group,
        query,
        runIds: runFilter ? (data?.runChain ?? [runFilter]) : null,
      }),
    [data?.outputs, data?.runChain, group, query, runFilter],
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

  async function copyPath(output: ProjectBuildOutput) {
    const { path } = outputPath(output);
    if (await copyText(path)) {
      setManualCopy(null);
      setCopiedId(output.id);
    } else {
      setManualCopy(path);
    }
  }

  const total = data?.outputs.length ?? 0;
  const fraction = data ? usageFraction(data.usedBytes, data.quotaBytes) : 0;
  const last = data?.lastCollect;

  return (
    <div className="board-page build-outputs-ux-page">
      <PageHeader
        title="Build outputs"
        icon={<Package className="icon" aria-hidden="true" />}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            disabled={collecting || !data}
            onClick={() => void collect()}
          >
            <RefreshCw className={`icon${collecting ? ' icon-spin' : ''}`} aria-hidden="true" />{' '}
            {collecting ? 'Collecting…' : 'Collect now'}
          </button>
        }
      />

      {data && (
        <section className="panel build-outputs-ux-usage" aria-label="Archive usage">
          <div className="build-outputs-ux-meter-line">
            <strong className="mono">{usageText(data.usedBytes, data.quotaBytes)}</strong>
            <progress
              className={`build-outputs-ux-meter${fraction >= 0.9 ? ' warn' : ''}`}
              max={100}
              value={Math.round(fraction * 100)}
              aria-label="Archive usage"
            />
            {quotaFull && <span className="badge badge-bad">quota full</span>}
            <HelpHint topic="output retention">
              <div className="build-outputs-ux-help-copy">
                <p>
                  Archived build outputs survive worktree cleanup. When the archive reaches its quota, the
                  oldest unpinned files are evicted first; pinned files are kept until you unpin or delete
                  them.
                </p>
                <p>
                  {data.hostArchiveDir ? 'Host archive: ' : 'Container archive: '}
                  <code className="mono">{data.hostArchiveDir ?? data.archiveDir}</code>
                </p>
                {last && !collecting && (
                  <p>
                    Last collect {timeAgo(last.finishedAt)}: {last.archived} archived, {last.skipped}{' '}
                    unchanged, {last.failed} failed.
                  </p>
                )}
              </div>
            </HelpHint>
          </div>
          {quotaFull && (
            <p className="muted small">
              Pinned outputs fill the quota. Unpin or delete files, or raise the quota in Settings.
            </p>
          )}
        </section>
      )}

      {Boolean(loadError) && (
        <ViewErrorBanner label="Could not load build outputs" error={loadError} onRetry={refresh} />
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {manualCopy && <CopyFallback text={manualCopy} onClose={() => setManualCopy(null)} />}

      {total > 0 && (
        <div className="build-outputs-ux-filters">
          <div className="build-outputs-ux-chips" role="group" aria-label="Filter by type">
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
                Run {runFilter.slice(0, 8)} <X className="icon" aria-hidden="true" />
                <span className="sr-only">Clear the run filter</span>
              </button>
            )}
          </div>
          <SearchInput
            className="build-outputs-ux-search"
            ariaLabel="Search build outputs"
            placeholder="Search name or ticket"
            value={query}
            onChange={setQuery}
          />
        </div>
      )}

      {loading && !data && !loadError && <ViewLoadingState label="Loading build outputs…" />}

      {data && total === 0 && (
        <div className="build-outputs-ux-empty">
          <Package className="icon" aria-hidden="true" />
          <p>
            <strong>No build outputs yet.</strong>
          </p>
          <p className="muted small">
            Finished runs archive APKs, installers and firmware here; use Collect now to scan active
            worktrees.
          </p>
        </div>
      )}

      {total > 0 && outputs.length === 0 && (
        <div className="empty">
          <p>No outputs match the filter.</p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setGroup('all');
              setQuery('');
              setRunFilter(null);
            }}
          >
            Clear filter
          </button>
        </div>
      )}

      {outputs.length > 0 && (
        <table className="build-outputs-ux-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Size</th>
              <th scope="col">Date</th>
              <th scope="col">Pinned</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {outputs.map((o) => (
              <tr key={o.id}>
                <td>
                  <div className="build-outputs-ux-name-cell">
                    <strong className="mono">{o.name}</strong>
                    <Origin output={o} projectId={projectId} />
                  </div>
                </td>
                <td className="muted small">{KIND_LABEL[outputGroup(o.name)]}</td>
                <td className="mono">{formatBytes(o.sizeBytes)}</td>
                <td className="muted small mono">{timeAgo(o.archivedAt)}</td>
                <td>
                  {o.pinned ? (
                    <span className="badge badge-ok">pinned</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <RowActions
                    output={o}
                    busy={busyId === o.id}
                    copied={copiedId === o.id}
                    onCopy={() => void copyPath(o)}
                    onPin={() =>
                      void mutate(o, () => api(`/api/build-outputs/${o.id}`, 'PATCH', { pinned: !o.pinned }))
                    }
                    onDelete={() => void mutate(o, () => api(`/api/build-outputs/${o.id}`, 'DELETE'))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

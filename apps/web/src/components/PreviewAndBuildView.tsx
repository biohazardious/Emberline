import type { MainPreviewStatus, Project, RunPreviewStatus, WorkspaceDemoTarget } from '@emberline/protocol';
import { type ReactNode, useState } from 'react';
import { Box, ExternalLink, Package, Play, RotateCw, Square } from 'lucide-react';
import { api, errorMessage } from '../api';
import { choosePrimaryView, previewBadge, previewEmptyText, previewFrameMode, previewProblem } from '../containerPreview';
import { useApi } from '../hooks/useApi';
import { DEMO_IFRAME_SANDBOX } from '../sandbox';

type PreviewStatus = RunPreviewStatus | MainPreviewStatus;

/** `<iframe credentialless>`: not in React's DOM types yet, so passed as a plain attribute. */
const CREDENTIALLESS = { credentialless: 'true' } as Record<string, string>;

/** Where a target's container preview is read, started and stopped. */
export function previewApiPath(projectId: string, target: Pick<WorkspaceDemoTarget, 'id' | 'kind'>): string {
  return target.kind === 'main' ? `/api/projects/${projectId}/preview` : `/api/runs/${target.id}/preview`;
}

/**
 * Preview & Build for one target: its container preview when it has one (compose preview service,
 * engine available), with the static build as a secondary view; otherwise just the static build.
 * Mounted only while the tab is open, so the status (a `compose ps` while it runs) is polled then.
 */
export function PreviewAndBuildView({
  project,
  target,
  engineAvailable,
  targetSelect,
  freshness,
  children,
}: {
  project: Project;
  target: WorkspaceDemoTarget;
  engineAvailable: boolean;
  /** The target picker, shown in the container view's header. */
  targetSelect: ReactNode;
  /** The static build's freshness line and badge, shown next to its toggle. */
  freshness: ReactNode;
  /** The static build view. */
  children: ReactNode;
}) {
  const path = previewApiPath(project.id, target);
  const poll = useApi<PreviewStatus>(path, (data) => (data?.status === 'starting' ? 2_000 : 8_000));
  const [showStatic, setShowStatic] = useState(false);
  const primary = choosePrimaryView(target, poll.data, engineAvailable);

  if (primary === null && !poll.error) {
    return (
      <p className="muted small" role="status">
        Checking for a container preview…
      </p>
    );
  }
  if (primary !== 'container' || !poll.data) return <>{children}</>;

  return (
    <div className="preview-build">
      <div className="preview-build-switch">
        <div className="segmented" role="tablist" aria-label="Preview view">
          <button
            type="button"
            role="tab"
            aria-selected={!showStatic}
            className={showStatic ? '' : 'active'}
            onClick={() => setShowStatic(false)}
          >
            <Box className="icon" aria-hidden /> Container preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showStatic}
            className={showStatic ? 'active' : ''}
            onClick={() => setShowStatic(true)}
          >
            <Package className="icon" aria-hidden /> Static build
          </button>
        </div>
        {/* The static view shows its own freshness line in its header. */}
        {!showStatic && freshness}
      </div>
      {showStatic ? (
        children
      ) : (
        <ContainerPreview
          key={path}
          status={poll.data}
          label={target.label}
          path={path}
          targetSelect={targetSelect}
          refresh={poll.refresh}
        />
      )}
    </div>
  );
}

function ContainerPreview({
  status,
  label,
  path,
  targetSelect,
  refresh,
}: {
  status: PreviewStatus;
  label: string;
  path: string;
  targetSelect: ReactNode;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const badge = previewBadge(status);
  const problem = previewProblem(status);
  const active = status.status === 'running' || status.status === 'starting';
  const unavailable = 'unavailable' in status ? status.unavailable : undefined;
  const frameMode = status.url ? previewFrameMode(window.location.protocol, status.url) : null;

  const act = async (action: 'start' | 'stop') => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api<PreviewStatus>(`${path}/${action}`, 'POST', {});
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  };

  return (
    <div className="container-preview">
      <div className="container-preview-head">
        <div className="container-preview-title">
          <strong>{status.kind === 'compose' ? 'Container preview' : 'Dev server preview'}</strong>
          {targetSelect}
          <span className={badge.className}>{badge.text}</span>
          {(status.command ?? status.detectedCommand) && (
            <span className="mono muted small container-preview-command">{status.command ?? status.detectedCommand}</span>
          )}
        </div>
        <div className="actions">
          {active ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('stop')}>
              <Square className="icon" aria-hidden /> {busy ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('start')}>
              <Play className="icon" aria-hidden /> {busy ? 'Starting…' : 'Start'}
            </button>
          )}
          {status.status === 'running' && status.url && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setNonce((n) => n + 1)}>
                <RotateCw className="icon" aria-hidden /> Reload
              </button>
              <a href={status.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                <ExternalLink className="icon" aria-hidden /> Open
              </a>
            </>
          )}
        </div>
      </div>

      {actionError && (
        <div className="banner banner-error container-preview-banner" role="alert">
          {actionError}
        </div>
      )}
      {problem && (
        <div className="banner banner-error container-preview-banner" role="alert">
          <div>
            <strong>{problem.title}:</strong> {problem.detail}
          </div>
          {problem.hint && <div className="container-preview-hint">{problem.hint}</div>}
          {status.logs && (
            <details>
              <summary>Container output (untrusted)</summary>
              <pre className="mono container-preview-logs">{status.logs}</pre>
            </details>
          )}
        </div>
      )}
      {status.note && status.status !== 'stopped' && (
        <p className="muted small container-preview-note" role="status">
          {status.note}
        </p>
      )}
      {unavailable && status.status !== 'stopped' && (
        <p className="muted small container-preview-note">{unavailable}</p>
      )}

      {status.status === 'running' && status.url && frameMode && !frameMode.frame ? (
        <p className="muted small container-preview-empty" role="status">
          {frameMode.note}{' '}
          <a href={status.url} target="_blank" rel="noreferrer">
            Open the preview
          </a>
        </p>
      ) : status.status === 'running' && status.url ? (
        <iframe
          key={nonce}
          className="container-preview-frame"
          src={status.url}
          sandbox={DEMO_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          // Cookies ignore ports: without this the preview's server (the agent's code) would get
          // Emberline's session cookie. Chromium honours it; other browsers ignore the attribute.
          {...CREDENTIALLESS}
          title={`Container preview - ${label}`}
        />
      ) : (
        <p className="muted small container-preview-empty">{previewEmptyText(status, label)}</p>
      )}
    </div>
  );
}

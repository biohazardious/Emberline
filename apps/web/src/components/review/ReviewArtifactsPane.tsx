import type { RunArtifact } from '@emberline/protocol';
import { DEMO_IFRAME_SANDBOX } from '../../sandbox';
import { BuildOutputsList } from '../RunOutcome';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface Props {
  runId: string;
  stateChangedAt: string;
  artifacts: readonly RunArtifact[];
  loadingArtifacts: boolean;
  previewArtifact: RunArtifact | null;
  onSelectArtifact: (artifact: RunArtifact) => void;
}

export function ReviewArtifactsPane({
  runId,
  stateChangedAt,
  artifacts,
  loadingArtifacts,
  previewArtifact,
  onSelectArtifact,
}: Props) {
  return (
    <div className="review-split-pane">
      <aside className="review-file-list">
        <div style={{ padding: '8px 8px 0' }}>
          <BuildOutputsList runId={runId} refreshKey={stateChangedAt} />
        </div>
        <div className="review-file-list-header">
          <span className="eyebrow review-tabular">Worktree Artifacts ({artifacts.length})</span>
        </div>
        {loadingArtifacts ? (
          <div className="muted small" style={{ padding: '0.75rem' }}>
            Scanning worktree for artifacts…
          </div>
        ) : artifacts.length === 0 ? (
          <div className="muted small" style={{ padding: '0.75rem' }}>
            No screenshots, traces, or new artifact files found in this worktree yet.
          </div>
        ) : (
          artifacts.map((art) => {
            const active = previewArtifact?.path === art.path;
            return (
              <div
                key={art.path}
                className={`review-file-item ${active ? 'active' : ''}`}
                onClick={() => onSelectArtifact(art)}
              >
                <span className="badge mono">{art.kind}</span>
                <span className="review-file-path mono" title={art.path}>
                  {art.path}
                </span>
                <span className="muted mono review-tabular" style={{ fontSize: '0.68rem' }}>
                  {formatBytes(art.sizeBytes)}
                </span>
              </div>
            );
          })
        )}
      </aside>

      <div className="review-diff-pane" style={{ padding: '1rem', overflowY: 'auto' }}>
        {!previewArtifact ? (
          <div className="empty">Select an artifact from the sidebar to preview or download it.</div>
        ) : (
          <div className="stack" style={{ gap: '0.75rem' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.75rem',
              }}
            >
              <div>
                <div className="mono" style={{ fontWeight: 600 }}>
                  {previewArtifact.path}
                </div>
                <div className="muted small review-tabular">
                  {previewArtifact.kind} · {formatBytes(previewArtifact.sizeBytes)} ·{' '}
                  {new Date(previewArtifact.mtime).toLocaleString()}
                </div>
              </div>
              <a
                href={`/api/runs/${runId}/artifacts/raw?path=${encodeURIComponent(previewArtifact.path)}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
              >
                Open / Download Raw ↗
              </a>
            </div>

            {previewArtifact.kind === 'image' ? (
              <div className="artifact-image-preview">
                <img
                  src={`/api/runs/${runId}/artifacts/raw?path=${encodeURIComponent(previewArtifact.path)}`}
                  alt={previewArtifact.path}
                />
              </div>
            ) : (
              <iframe
                title={previewArtifact.path}
                src={`/api/runs/${runId}/artifacts/raw?path=${encodeURIComponent(previewArtifact.path)}`}
                className="artifact-iframe-preview"
                sandbox={DEMO_IFRAME_SANDBOX}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

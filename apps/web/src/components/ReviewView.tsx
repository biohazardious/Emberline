import { useCallback, useEffect, useState } from 'react';
import type {
  DiffFile,
  DiffScope,
  GitCommitResponse,
  GitPushResponse,
  Run,
  RunArtifact,
  RunDiffSummary,
  RunFileDiff,
  RunForgeStatus,
  RunPreviewStatus,
} from '@emberline/protocol';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { MonacoDiff, type DiffAnnotation } from './MonacoDiff';

interface Props {
  run: Run;
  onRunUpdated?: (run: Run) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

export function ReviewView({ run, onRunUpdated }: Props) {
  const [subTab, setSubTab] = useState<'diff' | 'artifacts'>('diff');
  const [scope, setScope] = useState<DiffScope>('branch');
  const [summary, setSummary] = useState<RunDiffSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<RunFileDiff | null>(null);
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline diff review annotations
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [generalNote, setGeneralNote] = useState('');
  const [sendingReview, setSendingReview] = useState(false);

  // Git commit & push state
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAllOnCommit, setStageAllOnCommit] = useState(true);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNotice, setGitNotice] = useState<string | null>(null);

  // Forge PR / MR state
  const [forgeStatus, setForgeStatus] = useState<RunForgeStatus | null>(null);
  const [prDrawerOpen, setPrDrawerOpen] = useState(false);
  const [prTitle, setPrTitle] = useState(run.title ?? `Changes on ${run.branch ?? 'branch'}`);
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prCreating, setPrCreating] = useState(false);

  // Per-worktree Preview Server state
  const [previewStatus, setPreviewStatus] = useState<RunPreviewStatus | null>(null);
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);
  const [previewCmd, setPreviewCmd] = useState('');
  const [previewPort, setPreviewPort] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  // Artifacts state
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<RunArtifact | null>(null);

  const loadSummary = useCallback(
    async (targetScope: DiffScope, keepSelection = true) => {
      setLoadingDiff(true);
      setError(null);
      try {
        const res = await api<RunDiffSummary>(
          `/api/runs/${run.id}/diff?scope=${encodeURIComponent(targetScope)}`,
        );
        setSummary(res);
        setSelectedFile((prev) => {
          if (keepSelection && prev && res.files.some((f) => f.path === prev)) {
            return prev;
          }
          return res.files[0]?.path ?? null;
        });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoadingDiff(false);
      }
    },
    [run.id],
  );

  const loadFile = useCallback(
    async (path: string, targetScope: DiffScope) => {
      setLoadingFile(true);
      try {
        const res = await api<RunFileDiff>(
          `/api/runs/${run.id}/diff/file?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(
            targetScope,
          )}`,
        );
        setFileDiff(res);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoadingFile(false);
      }
    },
    [run.id],
  );

  const loadArtifacts = useCallback(async () => {
    setLoadingArtifacts(true);
    try {
      const list = await api<RunArtifact[]>(`/api/runs/${run.id}/artifacts`);
      setArtifacts(list);
      setPreviewArtifact((prev) => {
        if (prev && list.some((a) => a.path === prev.path)) return prev;
        return list.find((a) => a.kind === 'image') ?? list[0] ?? null;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingArtifacts(false);
    }
  }, [run.id]);

  const loadForge = useCallback(async () => {
    try {
      const status = await api<RunForgeStatus>(`/api/runs/${run.id}/forge`);
      setForgeStatus(status);
    } catch {
      // Ignore if forge status endpoint unavailable
    }
  }, [run.id]);

  const loadPreview = useCallback(async () => {
    try {
      const status = await api<RunPreviewStatus>(`/api/runs/${run.id}/preview`);
      setPreviewStatus(status);
      setPreviewCmd((prev) => prev || status.command || status.detectedCommand || 'npm run dev');
    } catch {
      // Ignore
    }
  }, [run.id]);

  useEffect(() => {
    void loadSummary(scope, false);
    void loadArtifacts();
    void loadForge();
    void loadPreview();
  }, [scope, loadSummary, loadArtifacts, loadForge, loadPreview]);

  useEffect(() => {
    if (selectedFile) {
      void loadFile(selectedFile, scope);
    } else {
      setFileDiff(null);
    }
  }, [selectedFile, scope, loadFile]);

  const handleAddAnnotation = (
    line: number,
    side: 'modified' | 'original',
    comment: string,
  ) => {
    if (!selectedFile) return;
    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filePath: selectedFile,
        line,
        side,
        comment,
      },
    ]);
  };

  const handleRemoveAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSendReviewToClaude = async () => {
    if (annotations.length === 0 && !generalNote.trim()) return;
    setSendingReview(true);
    setError(null);
    try {
      const lines: string[] = [
        'Please address the following code review feedback on this branch:',
        '',
      ];
      if (generalNote.trim()) {
        lines.push(`Overall note: ${generalNote.trim()}`, '');
      }
      if (annotations.length > 0) {
        lines.push('Inline diff annotations:');
        for (const a of annotations) {
          lines.push(`- \`${a.filePath}:${a.line}\` (${a.side}): ${a.comment}`);
        }
      }
      const next = await api<Run>(`/api/runs/${run.id}/prompt`, 'POST', {
        text: lines.join('\n'),
      });
      setAnnotations([]);
      setGeneralNote('');
      setGitNotice('Dispatched review annotations to Claude run.');
      onRunUpdated?.(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSendingReview(false);
    }
  };

  const handleStageToggle = async (file: DiffFile, unstage = false) => {
    setGitBusy(true);
    setError(null);
    try {
      const next = await api<RunDiffSummary>(`/api/runs/${run.id}/git/stage`, 'POST', {
        paths: [file.path],
        unstage,
      });
      setSummary(next);
      if (selectedFile) {
        await loadFile(selectedFile, scope);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMessage.trim()) return;
    setGitBusy(true);
    setError(null);
    setGitNotice(null);
    try {
      const res = await api<GitCommitResponse>(`/api/runs/${run.id}/git/commit`, 'POST', {
        message: commitMessage.trim(),
        stageAll: stageAllOnCommit,
      });
      setCommitMessage('');
      setGitNotice(`Committed ${res.sha} (${res.summary})`);
      await loadSummary(scope, true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handlePush = async () => {
    setGitBusy(true);
    setError(null);
    setGitNotice(null);
    try {
      const res = await api<GitPushResponse>(`/api/runs/${run.id}/git/push`, 'POST', {});
      setGitNotice(`Pushed ${res.branch} → ${res.remote}`);
      await loadSummary(scope, true);
      await loadForge();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCreatePr = async (e: React.FormEvent) => {
    e.preventDefault();
    setPrCreating(true);
    setError(null);
    setGitNotice(null);
    try {
      const res = await api<RunForgeStatus>(`/api/runs/${run.id}/forge/pr`, 'POST', {
        title: prTitle.trim() || undefined,
        body: prBody.trim() || undefined,
        draft: prDraft,
        pushFirst: true,
      });
      setForgeStatus(res);
      setPrDrawerOpen(false);
      if (res.pullRequest) {
        setGitNotice(`Created PR #${res.pullRequest.number}: ${res.pullRequest.title}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPrCreating(false);
    }
  };

  const handleStartPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    setPreviewBusy(true);
    setError(null);
    setGitNotice(null);
    try {
      const parsedPort = previewPort.trim() ? Number(previewPort.trim()) : undefined;
      const res = await api<RunPreviewStatus>(`/api/runs/${run.id}/preview/start`, 'POST', {
        command: previewCmd.trim() || undefined,
        port: parsedPort && Number.isInteger(parsedPort) ? parsedPort : undefined,
      });
      setPreviewStatus(res);
      setPreviewDrawerOpen(false);
      setGitNotice(`Preview dev server running on ${res.url ?? `port ${res.port}`}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleStopPreview = async () => {
    setPreviewBusy(true);
    setError(null);
    try {
      const res = await api<RunPreviewStatus>(`/api/runs/${run.id}/preview/stop`, 'POST', {});
      setPreviewStatus(res);
      setGitNotice('Stopped worktree preview dev server.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const totalAdditions = summary?.totalAdditions ?? 0;
  const totalDeletions = summary?.totalDeletions ?? 0;

  return (
    <div className="review-workspace">
      {/* Top toolbar */}
      <div className="review-toolbar">
        <div className="review-toolbar-group">
          <div className="segmented" role="tablist" aria-label="Review mode">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'diff'}
              className={subTab === 'diff' ? 'active' : ''}
              onClick={() => setSubTab('diff')}
            >
              Diff & Git ({summary?.files.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'artifacts'}
              className={subTab === 'artifacts' ? 'active' : ''}
              onClick={() => setSubTab('artifacts')}
            >
              Artifacts ({artifacts.length})
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
                  onClick={() => setScope('branch')}
                  title="All changes on this branch vs base branch"
                >
                  Branch vs {summary?.baseBranch ?? 'base'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'unstaged'}
                  className={scope === 'unstaged' ? 'active' : ''}
                  onClick={() => setScope('unstaged')}
                  title="Unstaged working tree changes"
                >
                  Unstaged
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'staged'}
                  className={scope === 'staged' ? 'active' : ''}
                  onClick={() => setScope('staged')}
                  title="Staged index changes"
                >
                  Staged
                </button>
              </div>

              <span className="badge mono">
                <span style={{ color: 'var(--ok)' }}>+{totalAdditions}</span>
                {' / '}
                <span style={{ color: 'var(--danger)' }}>-{totalDeletions}</span>
              </span>

              {summary && summary.aheadCount > 0 && (
                <span className="badge badge-soft mono">{summary.aheadCount} ahead</span>
              )}
            </>
          )}
        </div>

        <div className="review-toolbar-group">
          {previewStatus?.status === 'running' ? (
            <>
              {previewStatus.url && (
                <a
                  href={previewStatus.url}
                  target="_blank"
                  rel="noreferrer"
                  className="badge badge-soft mono"
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
                onClick={() => void handleStopPreview()}
              >
                Stop Preview
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setPreviewDrawerOpen((v) => !v)}
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
              className="badge badge-soft mono"
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
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPrDrawerOpen((v) => !v)}
                >
                  {prDrawerOpen ? 'Cancel PR' : 'Create PR / MR'}
                </button>
              )}
            </>
          )}
          {subTab === 'diff' && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setRenderSideBySide((s) => !s)}
            >
              {renderSideBySide ? 'Inline Diff' : 'Split Diff'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              void loadSummary(scope, true);
              void loadArtifacts();
              void loadForge();
              void loadPreview();
            }}
            disabled={loadingDiff || loadingArtifacts}
          >
            Refresh
          </button>
        </div>
      </div>

      {previewDrawerOpen && (
        <form className="review-actions-bar" onSubmit={(e) => void handleStartPreview(e)}>
          <div className="review-commit-form" style={{ flex: 1 }}>
            <input
              type="text"
              className="input mono"
              value={previewCmd}
              onChange={(e) => setPreviewCmd(e.target.value)}
              placeholder="Dev server command (e.g. pnpm dev or npm run dev)"
              required
            />
            <input
              type="number"
              className="input mono"
              value={previewPort}
              onChange={(e) => setPreviewPort(e.target.value)}
              placeholder="Port (auto 3100–3899)"
              style={{ maxWidth: '170px' }}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={previewBusy || !previewCmd.trim()}
            >
              {previewBusy ? 'Starting…' : 'Start Preview Server'}
            </button>
          </div>
        </form>
      )}

      {prDrawerOpen && (
        <form className="review-actions-bar" onSubmit={(e) => void handleCreatePr(e)}>
          <div className="review-commit-form" style={{ flex: 1 }}>
            <input
              type="text"
              className="input"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="Pull request title…"
              required
            />
            <input
              type="text"
              className="input"
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              placeholder="Optional description / summary…"
            />
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={prDraft}
                onChange={(e) => setPrDraft(e.target.checked)}
              />
              Draft
            </label>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={prCreating || !prTitle.trim()}
            >
              {prCreating ? 'Creating PR…' : `Push & Create ${forgeStatus?.provider === 'gitlab' ? 'MR' : 'PR'}`}
            </button>
          </div>
          {!forgeStatus?.tokenConfigured && (
            <span className="muted small">
              Configure a Forge Personal Access Token on the Overview page (or use Compare ↗).
            </span>
          )}
        </form>
      )}

      {error && <p className="form-error" style={{ margin: '0.5rem 0.75rem' }}>{error}</p>}
      {gitNotice && (
        <div className="git-notice-banner">
          <span className="mono">{gitNotice}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGitNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {subTab === 'diff' ? (
        <>
          {/* Commit & Push bar + Inline Review Dispatch */}
          <div className="review-actions-bar">
            <form className="review-commit-form" onSubmit={handleCommit}>
              <input
                type="text"
                className="input"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder={`Commit message on ${run.branch || 'worktree branch'}…`}
                disabled={gitBusy}
              />
              <label className="review-checkbox-label">
                <input
                  type="checkbox"
                  checked={stageAllOnCommit}
                  onChange={(e) => setStageAllOnCommit(e.target.checked)}
                />
                Stage all (-A)
              </label>
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={gitBusy || !commitMessage.trim()}
              >
                Commit
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={gitBusy}
                onClick={handlePush}
                title={`Push ${run.branch ?? 'branch'} to origin`}
              >
                Push Branch
              </button>
            </form>

            <div className="review-annotations-dispatch">
              <input
                type="text"
                className="input"
                value={generalNote}
                onChange={(e) => setGeneralNote(e.target.value)}
                placeholder={
                  annotations.length > 0
                    ? `${annotations.length} line note(s) queued — optional summary…`
                    : 'Quick review note or click lines in diff…'
                }
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={sendingReview || (annotations.length === 0 && !generalNote.trim())}
                onClick={handleSendReviewToClaude}
              >
                {sendingReview
                  ? 'Sending…'
                  : `Request Changes (${annotations.length})`}
              </button>
            </div>
          </div>

          <div className="review-split-pane">
            {/* Left file tree */}
            <aside className="review-file-list">
              <div className="review-file-list-header">
                <span className="eyebrow">Changed Files ({summary?.files.length ?? 0})</span>
              </div>
              {loadingDiff && !summary ? (
                <div className="muted small" style={{ padding: '0.75rem' }}>
                  Inspecting git worktree…
                </div>
              ) : !summary || summary.files.length === 0 ? (
                <div className="muted small" style={{ padding: '0.75rem' }}>
                  No changes in `{scope}` scope.
                </div>
              ) : (
                summary.files.map((f) => {
                  const active = f.path === selectedFile;
                  const fileNoteCount = annotations.filter((a) => a.filePath === f.path).length;
                  return (
                    <div
                      key={f.path}
                      className={`review-file-item ${active ? 'active' : ''}`}
                      onClick={() => setSelectedFile(f.path)}
                    >
                      <span className={`diff-status-badge status-${f.status}`}>
                        {f.status[0]?.toUpperCase() ?? 'M'}
                      </span>
                      <span className="review-file-path mono" title={f.path}>
                        {f.path}
                      </span>
                      {fileNoteCount > 0 && (
                        <span className="badge badge-soft mono">{fileNoteCount}</span>
                      )}
                      <span className="review-file-stats mono">
                        <span style={{ color: 'var(--ok)' }}>+{f.additions}</span>{' '}
                        <span style={{ color: 'var(--danger)' }}>-{f.deletions}</span>
                      </span>
                      {scope !== 'branch' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          style={{ padding: '0.05rem 0.35rem', fontSize: '0.68rem' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleStageToggle(f, scope === 'staged');
                          }}
                          title={scope === 'staged' ? 'Unstage file' : 'Stage file'}
                        >
                          {scope === 'staged' ? '−' : '+'}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </aside>

            {/* Right Monaco diff editor */}
            <div className="review-diff-pane">
              {loadingFile && !fileDiff ? (
                <div className="empty" style={{ margin: '1rem' }}>
                  Loading file diff…
                </div>
              ) : !fileDiff ? (
                <div className="empty" style={{ margin: '1rem' }}>
                  Select a changed file on the left to inspect its diff and attach inline review annotations.
                </div>
              ) : fileDiff.binary ? (
                <div className="empty" style={{ margin: '1rem' }}>
                  Binary file (`{fileDiff.path}`) — switch to the Artifacts tab to preview or download.
                </div>
              ) : (
                <MonacoDiff
                  filePath={fileDiff.path}
                  language={detectLanguage(fileDiff.path)}
                  original={fileDiff.original}
                  modified={fileDiff.modified}
                  renderSideBySide={renderSideBySide}
                  annotations={annotations}
                  onAddAnnotation={handleAddAnnotation}
                  onRemoveAnnotation={handleRemoveAnnotation}
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="review-split-pane">
          <aside className="review-file-list">
            <div className="review-file-list-header">
              <span className="eyebrow">Worktree Artifacts ({artifacts.length})</span>
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
                    onClick={() => setPreviewArtifact(art)}
                  >
                    <span className="badge mono">{art.kind}</span>
                    <span className="review-file-path mono" title={art.path}>
                      {art.path}
                    </span>
                    <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                      {formatBytes(art.sizeBytes)}
                    </span>
                  </div>
                );
              })
            )}
          </aside>

          <div className="review-diff-pane" style={{ padding: '1rem', overflowY: 'auto' }}>
            {!previewArtifact ? (
              <div className="empty">
                Select an artifact from the sidebar to preview or download it.
              </div>
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
                    <div className="muted small">
                      {previewArtifact.kind} · {formatBytes(previewArtifact.sizeBytes)} ·{' '}
                      {new Date(previewArtifact.mtime).toLocaleString()}
                    </div>
                  </div>
                  <a
                    href={`/api/runs/${run.id}/artifacts/raw?path=${encodeURIComponent(
                      previewArtifact.path,
                    )}`}
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
                      src={`/api/runs/${run.id}/artifacts/raw?path=${encodeURIComponent(
                        previewArtifact.path,
                      )}`}
                      alt={previewArtifact.path}
                    />
                  </div>
                ) : (
                  <iframe
                    title={previewArtifact.path}
                    src={`/api/runs/${run.id}/artifacts/raw?path=${encodeURIComponent(
                      previewArtifact.path,
                    )}`}
                    className="artifact-iframe-preview"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

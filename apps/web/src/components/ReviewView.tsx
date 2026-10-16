import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Coins,
  Eraser,
  Lightbulb,
  LoaderCircle,
  Lock,
  Rocket,
  Scale,
  Shield,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CrossCriticResult,
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
  RunReviewState,
  SlopAuditReport,
} from '@emberline/protocol';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { DEMO_IFRAME_SANDBOX } from '../sandbox';
import { MonacoDiff, type DiffAnnotation } from './MonacoDiff';
import { formatAgentDisplayName } from './RunInspector';
import { BuildOutputsList } from './RunOutcome';

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

  // Persistent line comments (stored by core, survive reloads).
  const queryClient = useQueryClient();
  const reviewKey = ['review', run.id] as const;
  const reviewQuery = useQuery({
    queryKey: reviewKey,
    queryFn: () => api<RunReviewState>(`/api/runs/${run.id}/review`),
  });
  const refreshReview = () => queryClient.invalidateQueries({ queryKey: reviewKey });
  const annotations = useMemo<DiffAnnotation[]>(
    () =>
      (reviewQuery.data?.comments ?? [])
        .filter((c) => c.status !== 'resolved')
        .map((c) => ({
          id: c.id,
          filePath: c.filePath,
          line: c.line,
          side: c.side,
          comment: c.body,
          status: c.status === 'sent' ? 'sent' : 'open',
        })),
    [reviewQuery.data],
  );
  const openCount = annotations.filter((a) => a.status === 'open').length;
  const viewedSignature = (f: DiffFile) => `${f.status}:${f.additions}:${f.deletions}`;
  const viewedByPath = useMemo(
    () => new Map((reviewQuery.data?.viewed ?? []).map((v) => [v.filePath, v.signature])),
    [reviewQuery.data],
  );
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

  // Anti-AI-Slop Hygiene & Cross-Provider Critic state
  const [slopAudit, setSlopAudit] = useState<SlopAuditReport | null>(null);
  const [crossCritic, setCrossCritic] = useState<CrossCriticResult | null>(null);
  const [hygieneDrawerOpen, setHygieneDrawerOpen] = useState(false);
  const [runningCritic, setRunningCritic] = useState(false);
  const [cleaningSlop, setCleaningSlop] = useState(false);

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

  const loadSlopAudit = useCallback(async () => {
    try {
      const [auditRes, criticRes] = await Promise.all([
        api<SlopAuditReport>(`/api/runs/${run.id}/slop-audit`),
        api<CrossCriticResult | null>(`/api/runs/${run.id}/cross-critic`).catch(() => null),
      ]);
      setSlopAudit(auditRes);
      if (criticRes) setCrossCritic(criticRes);
      if (!auditRes.passed && auditRes.issues.length > 0) {
        setHygieneDrawerOpen(true);
      }
    } catch {
      // Ignore if worktree not ready
    }
  }, [run.id]);

  useEffect(() => {
    void loadSummary(scope, false);
    void loadArtifacts();
    void loadForge();
    void loadPreview();
    void loadSlopAudit();
  }, [scope, loadSummary, loadArtifacts, loadForge, loadPreview, loadSlopAudit]);

  useEffect(() => {
    if (selectedFile) {
      void loadFile(selectedFile, scope);
    } else {
      setFileDiff(null);
    }
  }, [selectedFile, scope, loadFile]);

  const handleAddAnnotation = (line: number, side: 'modified' | 'original', comment: string) => {
    if (!selectedFile) return;
    api(`/api/runs/${run.id}/review/comments`, 'POST', { filePath: selectedFile, line, side, body: comment })
      .then(refreshReview)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  /** Deletes an unsent comment; a sent one is marked resolved instead (it is part of the history). */
  const handleRemoveAnnotation = (id: string) => {
    const sent = annotations.find((a) => a.id === id)?.status === 'sent';
    const request = sent
      ? api(`/api/runs/${run.id}/review/comments/${id}`, 'PATCH', { status: 'resolved' })
      : api(`/api/runs/${run.id}/review/comments/${id}`, 'DELETE');
    request.then(refreshReview).catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleToggleViewed = (f: DiffFile, viewed: boolean) => {
    api(`/api/runs/${run.id}/review/viewed`, 'PUT', { filePath: f.path, signature: viewedSignature(f), viewed })
      .then(refreshReview)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const handleSendReviewToClaude = async () => {
    if (openCount === 0 && !generalNote.trim()) return;
    setSendingReview(true);
    setError(null);
    try {
      const res = await api<{ run: Run; sent: number }>(`/api/runs/${run.id}/review/request-changes`, 'POST', {
        note: generalNote.trim(),
      });
      setGeneralNote('');
      await refreshReview();
      setGitNotice(`Sent ${res.sent} review comment(s) to ${formatAgentDisplayName(run.agent)}.`);
      onRunUpdated?.(res.run);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSendingReview(false);
    }
  };

  const handleAutoCleanSlop = async (customPrompt?: string | null) => {
    const promptToSend = customPrompt ?? slopAudit?.autoFixPrompt;
    if (!promptToSend) return;
    setCleaningSlop(true);
    setError(null);
    try {
      const next = await api<Run>(`/api/runs/${run.id}/prompt`, 'POST', {
        text: promptToSend,
      });
      setGitNotice(`Dispatched Anti-Slop remediation prompt to ${formatAgentDisplayName(run.agent)}.`);
      onRunUpdated?.(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCleaningSlop(false);
    }
  };

  const handleRunCrossCritic = async (autoDispatchFix = false) => {
    setRunningCritic(true);
    setHygieneDrawerOpen(true);
    setError(null);
    try {
      const res = await api<CrossCriticResult>(`/api/runs/${run.id}/cross-critic`, 'POST', {
        autoDispatchFix,
      });
      setCrossCritic(res);
      setGitNotice(
        res.reviewSource === 'rival'
          ? `${res.reviewerAgent.toUpperCase()} (${res.reviewerModel}) reviewed the diff: ${res.verdict} (${res.score}/100)`
          : `Deterministic audit only: ${res.verdict} (${res.score}/100). ${res.summary}`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunningCritic(false);
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

              {run.telemetry && run.telemetry.totalTokens > 0 && (
                <span
                  className="badge badge-soft mono"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                  title={`Input: ${run.telemetry.inputTokens.toLocaleString()} tok · Output: ${run.telemetry.outputTokens.toLocaleString()} tok${
                    run.telemetry.cachedTokens > 0
                      ? ` · Cached: ${run.telemetry.cachedTokens.toLocaleString()} tok`
                      : ''
                  } · Tool Calls: ${run.telemetry.toolCalls} · Duration: ${run.telemetry.durationSec}s${
                    run.telemetry.isEstimated ? ' (estimated)' : ''
                  }`}
                >
                  <Coins className="icon" aria-hidden /> {(run.telemetry.totalTokens / 1000).toFixed(1)}k tok · <Wrench className="icon" aria-hidden />{' '}
                  {run.telemetry.toolCalls}
                </span>
              )}

              {slopAudit && (
                <>
                  <button
                    type="button"
                    className="badge mono"
                    onClick={() => setHygieneDrawerOpen((v) => !v)}
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
                    className="badge mono"
                    onClick={() => setHygieneDrawerOpen((v) => !v)}
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
                    {slopAudit.passed ? <Shield className="icon" aria-hidden /> : <TriangleAlert className="icon" aria-hidden />} Hygiene {slopAudit.grade} · {slopAudit.score}/100
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
            onClick={() => void handleRunCrossCritic(false)}
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
              void loadSlopAudit();
            }}
            disabled={loadingDiff || loadingArtifacts}
          >
            Refresh
          </button>
        </div>
      </div>

      {hygieneDrawerOpen && (slopAudit || crossCritic) && (
        <div
          className="review-actions-bar"
          style={{
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: '10px',
            padding: '12px 14px',
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '0.84rem' }}>
                <Shield className="icon" aria-hidden /> Anti-AI-Slop &amp; Code Craftsmanship Audit
              </strong>
              {slopAudit && (
                <span className="badge mono" style={{ fontSize: '0.7rem' }}>
                  Grade {slopAudit.grade} · {slopAudit.score}/100 · {slopAudit.filesAudited} file(s) · +{slopAudit.addedLinesAudited} lines scanned
                </span>
              )}
              {crossCritic && (
                <span
                  className="badge mono"
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

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {slopAudit?.autoFixPrompt && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={cleaningSlop}
                  onClick={() => void handleAutoCleanSlop(slopAudit.autoFixPrompt)}
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
              <button
                type="button"
                className="btn btn-sm"
                disabled={runningCritic}
                onClick={() => void handleRunCrossCritic(false)}
              >
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
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setHygieneDrawerOpen(false)}
              >
                Hide
              </button>
            </div>
          </div>

          {crossCritic && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                fontSize: '0.78rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <strong>
                  <Scale className="icon" aria-hidden /> Cross-Provider Critic Summary:
                </strong> {crossCritic.summary}
              </div>
              {crossCritic.followUpPrompt && (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={cleaningSlop}
                  onClick={() => void handleAutoCleanSlop(crossCritic.followUpPrompt)}
                >
                  <Rocket className="icon" aria-hidden /> Send Critic Fixes to {formatAgentDisplayName(run.agent)}
                </button>
              )}
            </div>
          )}

          {slopAudit && slopAudit.issues.length === 0 ? (
            <div className="muted small" style={{ color: 'var(--ok)' }}>
              ✓ Clean diff: zero <code>any</code> evasions, zero unfinished <code>TODO</code>/<code>FIXME</code> stubs, zero skipped tests, and zero vibe-coding clichés detected.
            </div>
          ) : (
            slopAudit && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '190px', overflowY: 'auto' }}>
                {slopAudit.issues.map((iss) => (
                  <div
                    key={iss.id}
                    onClick={() => setSelectedFile(iss.file)}
                    style={{
                      padding: '6px 9px',
                      borderRadius: '6px',
                      background: 'var(--surface-2)',
                      border:
                        iss.severity === 'error'
                          ? '1px solid color-mix(in srgb, var(--bad) 35%, transparent)'
                          : '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                      cursor: 'pointer',
                      fontSize: '0.76rem',
                    }}
                    title="Click to open file in diff viewer"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span className="mono" style={{ fontWeight: 600 }}>
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
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

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

      {error && (
        <p className="form-error" role="alert" style={{ margin: '0.5rem 0.75rem' }}>
          {error}
        </p>
      )}
      {gitNotice && (
        <div className="git-notice-banner">
          <span className="mono">{gitNotice}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGitNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {subTab === 'diff' && summary && !summary.isGitRepo ? (
        <div className="review-split-pane">
          <div className="muted small" style={{ padding: '1rem' }}>
            This workspace is not a git repository, so the agent's changes cannot be listed, reviewed,
            committed or merged. Run <code>git init</code> in the project&apos;s shell (or create the
            project with a repository URL) to enable review.
          </div>
        </div>
      ) : subTab === 'diff' ? (
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
                  openCount > 0
                    ? `${openCount} line comment(s) ready to send — optional summary…`
                    : 'Quick review note or click lines in diff…'
                }
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={sendingReview || (openCount === 0 && !generalNote.trim())}
                onClick={handleSendReviewToClaude}
              >
                {sendingReview
                  ? 'Sending…'
                  : `Request Changes (${openCount})`}
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
                      <label
                        className={`review-viewed${viewedByPath.has(f.path) && viewedByPath.get(f.path) !== viewedSignature(f) ? ' review-viewed-stale' : ''}`}
                        title={
                          viewedByPath.has(f.path) && viewedByPath.get(f.path) !== viewedSignature(f)
                            ? 'Changed since you marked it viewed'
                            : 'Mark as viewed'
                        }
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={viewedByPath.get(f.path) === viewedSignature(f)}
                          onChange={(e) => handleToggleViewed(f, e.target.checked)}
                        />
                        {viewedByPath.has(f.path) && viewedByPath.get(f.path) !== viewedSignature(f) ? 'changed' : 'viewed'}
                      </label>
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
                  Select a changed file to inspect its diff and attach inline review annotations.
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
            <div style={{ padding: '8px 8px 0' }}>
              <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />
            </div>
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
                    sandbox={DEMO_IFRAME_SANDBOX}
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

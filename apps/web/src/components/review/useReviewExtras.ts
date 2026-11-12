import type {
  CrossCriticResult,
  DiffFile,
  DiffScope,
  GitCommitResponse,
  GitPushResponse,
  Run,
  RunArtifact,
  RunDiffSummary,
  RunForgeStatus,
  RunPreviewStatus,
  SlopAuditReport,
} from '@emberline/protocol';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { formatAgentDisplayName } from '../RunInspector';

export function detectLanguage(filePath: string): string {
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

interface UseReviewExtrasParams {
  run: Run;
  scope: DiffScope;
  selectedFile: string | null;
  onRunUpdated?: (run: Run) => void;
  setError: (msg: string | null) => void;
  setSummary: (summary: RunDiffSummary) => void;
  clearDiffCache: () => void;
  loadSummary: (targetScope: DiffScope, keepSelection?: boolean) => Promise<void>;
  loadFile: (path: string, targetScope: DiffScope) => Promise<void>;
}

export function useReviewExtras({
  run,
  scope,
  selectedFile,
  onRunUpdated,
  setError,
  setSummary,
  clearDiffCache,
  loadSummary,
  loadFile,
}: UseReviewExtrasParams) {
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAllOnCommit, setStageAllOnCommit] = useState(true);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNotice, setGitNotice] = useState<string | null>(null);

  const [forgeStatus, setForgeStatus] = useState<RunForgeStatus | null>(null);
  const [prDrawerOpen, setPrDrawerOpen] = useState(false);
  const [prTitle, setPrTitle] = useState(run.title ?? `Changes on ${run.branch ?? 'branch'}`);
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prCreating, setPrCreating] = useState(false);

  const [previewStatus, setPreviewStatus] = useState<RunPreviewStatus | null>(null);
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);
  const [previewCmd, setPreviewCmd] = useState('');
  const [previewPort, setPreviewPort] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  const [slopAudit, setSlopAudit] = useState<SlopAuditReport | null>(null);
  const [crossCritic, setCrossCritic] = useState<CrossCriticResult | null>(null);
  const [hygieneDrawerOpen, setHygieneDrawerOpen] = useState(false);
  const [runningCritic, setRunningCritic] = useState(false);
  const [cleaningSlop, setCleaningSlop] = useState(false);

  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<RunArtifact | null>(null);

  const loadArtifacts = useCallback(async () => {
    setLoadingArtifacts(true);
    try {
      const list = await api<RunArtifact[]>(`/api/runs/${run.id}/artifacts`);
      setArtifacts(list);
      setPreviewArtifact((prev) => {
        if (prev && list.some((a) => a.path === prev.path)) return prev;
        return list.find((a) => a.kind === 'image') ?? list[0] ?? null;
      });
    } catch {
      setArtifacts([]);
    } finally {
      setLoadingArtifacts(false);
    }
  }, [run.id]);

  const loadForge = useCallback(async () => {
    try {
      setForgeStatus(await api<RunForgeStatus>(`/api/runs/${run.id}/forge`));
    } catch {
      setForgeStatus(null);
    }
  }, [run.id]);

  const loadPreview = useCallback(async () => {
    try {
      const status = await api<RunPreviewStatus>(`/api/runs/${run.id}/preview`);
      setPreviewStatus(status);
      setPreviewCmd((prev) => prev || status.command || status.detectedCommand || 'npm run dev');
    } catch {
      setPreviewStatus(null);
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
      if (!auditRes.passed && auditRes.issues.length > 0) setHygieneDrawerOpen(true);
    } catch {
      setSlopAudit(null);
    }
  }, [run.id]);

  const refreshExtras = useCallback(() => {
    void loadArtifacts();
    void loadForge();
    void loadPreview();
    void loadSlopAudit();
  }, [loadArtifacts, loadForge, loadPreview, loadSlopAudit]);

  useEffect(() => {
    refreshExtras();
  }, [refreshExtras]);

  useEffect(() => {
    if (previewStatus?.status !== 'starting') return;
    const timer = setInterval(() => void loadPreview(), 2000);
    return () => clearInterval(timer);
  }, [previewStatus?.status, loadPreview]);

  const handleAutoCleanSlop = async (customPrompt?: string | null) => {
    const promptToSend = customPrompt ?? slopAudit?.autoFixPrompt;
    if (!promptToSend) return;
    setCleaningSlop(true);
    setError(null);
    try {
      const next = await api<Run>(`/api/runs/${run.id}/prompt`, 'POST', { text: promptToSend });
      setGitNotice(`Dispatched Anti-Slop remediation prompt to ${formatAgentDisplayName(run.agent)}.`);
      onRunUpdated?.(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCleaningSlop(false);
    }
  };

  const handleRunCrossCritic = async () => {
    setRunningCritic(true);
    setHygieneDrawerOpen(true);
    setError(null);
    try {
      const res = await api<CrossCriticResult>(`/api/runs/${run.id}/cross-critic`, 'POST', {
        autoDispatchFix: false,
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
    clearDiffCache();
    try {
      const next = await api<RunDiffSummary>(`/api/runs/${run.id}/git/stage`, 'POST', {
        paths: [file.path],
        unstage,
      });
      setSummary(next);
      if (selectedFile) await loadFile(selectedFile, scope);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommit = async (e: FormEvent) => {
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

  const handleCreatePr = async (e: FormEvent) => {
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
      if (res.pullRequest) setGitNotice(`Created PR #${res.pullRequest.number}: ${res.pullRequest.title}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPrCreating(false);
    }
  };

  const handleStartPreview = async (e: FormEvent) => {
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
      setGitNotice(
        res.status === 'starting'
          ? `Preview starting in the Docker engine; it will answer on ${res.url ?? `port ${res.port}`}`
          : `Preview dev server running on ${res.url ?? `port ${res.port}`}`,
      );
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
      setPreviewStatus(await api<RunPreviewStatus>(`/api/runs/${run.id}/preview/stop`, 'POST', {}));
      setGitNotice('Stopped worktree preview dev server.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  return {
    commitMessage,
    setCommitMessage,
    stageAllOnCommit,
    setStageAllOnCommit,
    gitBusy,
    gitNotice,
    setGitNotice,
    forgeStatus,
    prDrawerOpen,
    setPrDrawerOpen,
    prTitle,
    setPrTitle,
    prBody,
    setPrBody,
    prDraft,
    setPrDraft,
    prCreating,
    previewStatus,
    previewDrawerOpen,
    setPreviewDrawerOpen,
    previewCmd,
    setPreviewCmd,
    previewPort,
    setPreviewPort,
    previewBusy,
    slopAudit,
    crossCritic,
    hygieneDrawerOpen,
    setHygieneDrawerOpen,
    runningCritic,
    cleaningSlop,
    artifacts,
    loadingArtifacts,
    previewArtifact,
    setPreviewArtifact,
    refreshExtras,
    handleAutoCleanSlop,
    handleRunCrossCritic,
    handleStageToggle,
    handleCommit,
    handlePush,
    handleCreatePr,
    handleStartPreview,
    handleStopPreview,
  };
}

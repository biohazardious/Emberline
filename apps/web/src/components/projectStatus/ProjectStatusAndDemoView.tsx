import type {
  FactoryRequestResponse,
  FactorySettings,
  Project,
  ProjectCheckpoint,
  ProjectStatusSummary,
  SystemStatus,
  Ticket,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { shouldAutoBuild } from '../../demoFreshness';
import { useApi } from '../../hooks/useApi';
import { startableCount } from '../../ticketDeps';
import { LiveBrowserStudio } from '../LiveBrowserStudio';
import { DemoStateBar } from './DemoStateBar';
import { FactoryRequestForm } from './FactoryRequestForm';
import { LiveDemoView } from './LiveDemoView';
import {
  type AttachedFilePreview,
  buildRuntimeErrorPrompt,
  type DemoRuntimeError,
  executeBuildDemo,
  executeSyncWorktree,
  isCompletedWorktreeTarget,
  parseAttachmentFiles,
  type StatusBannerMessage,
  type StudioTab,
} from './projectStatusHelpers';
import { StatusSummaryBar } from './StatusSummaryBar';
import { CheckpointsSectionView, WorktreesSectionView } from './WorktreesAndCheckpointsView';
import './project-status.css';

export function ProjectStatusAndDemoView({ project }: { project: Project }) {
  const statusPoll = useApi<ProjectStatusSummary>(`/api/projects/${project.id}/status`, 4_000);
  const ticketsPoll = useApi<Ticket[]>(`/api/projects/${project.id}/tickets`, 5_000);
  const settingsPoll = useApi<FactorySettings>('/api/factory/settings', 15_000);
  const checkpointsPoll = useApi<ProjectCheckpoint[]>(`/api/projects/${project.id}/checkpoints`, 10_000);
  const systemPoll = useApi<SystemStatus>('/api/system', 5_000);

  const [activeTab, setActiveTab] = useState<StudioTab>('factory');
  const [selectedTargetId, setSelectedTargetId] = useState<string>('main');
  const [fullscreen, setFullscreen] = useState(false);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [syncingRunId, setSyncingRunId] = useState<string>();
  const [buildingTargetId, setBuildingTargetId] = useState<string>();
  const [factoryPrompt, setFactoryPrompt] = useState('');
  const [factoryAttachments, setFactoryAttachments] = useState<AttachedFilePreview[]>([]);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [submittingFactory, setSubmittingFactory] = useState(false);
  const [startingPipeline, setStartingPipeline] = useState(false);
  const [banner, setBanner] = useState<StatusBannerMessage>();
  const [blockedSync, setBlockedSync] = useState<{ runId: string; count: number }>();
  const [missingSync, setMissingSync] = useState<{ ticketId: string }>();
  const [demoErrors, setDemoErrors] = useState<DemoRuntimeError[]>([]);
  const [quickTweakPrompt, setQuickTweakPrompt] = useState('');
  const [submittingTweak, setSubmittingTweak] = useState(false);
  const [rollingBackSha, setRollingBackSha] = useState<string>();
  const [lastBuildOutput, setLastBuildOutput] = useState<string>('');
  const [hideCompletedWorktrees, setHideCompletedWorktrees] = useState(true);

  const demoFrameRef = useRef<HTMLIFrameElement | null>(null);
  const autoBuiltTargets = useRef(new Set<string>());

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!demoFrameRef.current || ev.source !== demoFrameRef.current.contentWindow) return;
      const data = ev.data as { type?: string; message?: string; stack?: string } | undefined;
      if (data && data.type === 'emberline:demo-error' && typeof data.message === 'string') {
        setDemoErrors((prev) => [
          { message: data.message!, stack: data.stack, timestamp: new Date().toLocaleTimeString() },
          ...prev.slice(0, 4),
        ]);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const addFilesToAttachments = async (files: FileList | File[]) => {
    const added = await parseAttachmentFiles(files, factoryAttachments.length, (text) =>
      setBanner({ kind: 'err', text }),
    );
    if (added.length > 0) setFactoryAttachments((prev) => [...prev, ...added].slice(0, 10));
  };

  const summary = statusPoll.data;
  if (!summary) return null;

  const targets = summary.targets;
  const activeTarget: WorkspaceDemoTarget =
    targets.find((t) => t.id === selectedTargetId) ?? targets.find((t) => Boolean(t.demoUrl)) ?? targets[0]!;
  const playableTargets = targets.filter((t) => Boolean(t.demoUrl));
  const bestPlayableTarget = playableTargets[0] ?? targets.find((t) => t.hasBuildScript) ?? targets[0];
  const completedWorktreesCount = targets.filter(isCompletedWorktreeTarget).length;
  const visibleTargets = hideCompletedWorktrees
    ? targets.filter((t) => !isCompletedWorktreeTarget(t))
    : targets;

  const submitFactoryRequestNow = async () => {
    const trimmed =
      factoryPrompt.trim() ||
      (factoryAttachments.length > 0
        ? `Inspect the attached file(s) (${factoryAttachments.map((a) => a.name).join(', ')}) and implement the corresponding design/changes in the project.`
        : '');
    if (!trimmed || submittingFactory) return;
    setSubmittingFactory(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(`/api/projects/${project.id}/factory-request`, 'POST', {
        prompt: trimmed,
        leadPersona: 'product_owner',
        permissionMode: 'auto',
        autoDispatch,
        attachments:
          factoryAttachments.length > 0
            ? factoryAttachments.map(({ name, mimeType, dataBase64, sizeBytes }) => ({
                name,
                mimeType,
                dataBase64,
                sizeBytes,
              }))
            : undefined,
      });
      const attachedCount = factoryAttachments.length;
      setFactoryPrompt('');
      setFactoryAttachments([]);
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({
        kind: 'ok',
        text: `Factory request${attachedCount > 0 ? ` (+${attachedCount} attached file${attachedCount > 1 ? 's' : ''})` : ''} dispatched to Product Owner (${res.ticket.key}).`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingFactory(false);
    }
  };

  const dispatchCoderRequest = async (promptText: string, onSuccess: (ticketKey: string) => void) => {
    setSubmittingTweak(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(`/api/projects/${project.id}/factory-request`, 'POST', {
        prompt: promptText,
        leadPersona: 'coder',
        permissionMode: 'auto',
        autoDispatch: true,
      });
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      onSuccess(res.ticket.key);
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingTweak(false);
    }
  };

  const handleQuickDemoTweak = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = quickTweakPrompt.trim();
    if (!trimmed) return;
    void dispatchCoderRequest(`[Live Demo Quick Tweak] ${trimmed}`, (key) => {
      setQuickTweakPrompt('');
      setBanner({ kind: 'ok', text: `Quick demo tweak dispatched (${key}).` });
    });
  };

  const handleFixDemoErrorWithCoder = (errItem: DemoRuntimeError) => {
    void dispatchCoderRequest(buildRuntimeErrorPrompt(errItem), (key) => {
      setDemoErrors([]);
      setBanner({ kind: 'ok', text: `Runtime error sent to Coder (${key}).` });
    });
  };

  const handleRollbackCheckpoint = async (sha: string) => {
    if (!window.confirm(`Roll back main workspace to checkpoint ${sha.slice(0, 8)}?`)) return;
    setRollingBackSha(sha);
    setBanner(undefined);
    try {
      await api(`/api/projects/${project.id}/rollback`, 'POST', { sha });
      await checkpointsPoll.refresh();
      await statusPoll.refresh();
      setIframeNonce((n) => n + 1);
      setBanner({ kind: 'ok', text: `Rolled back main workspace to checkpoint ${sha.slice(0, 8)}.` });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setRollingBackSha(undefined);
    }
  };

  const handleRunPipeline = async () => {
    setStartingPipeline(true);
    setBanner(undefined);
    try {
      await api(`/api/projects/${project.id}/run-pipeline`, 'POST', {});
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({ kind: 'ok', text: 'Pipeline activated: ready tickets start in dependency order.' });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setStartingPipeline(false);
    }
  };

  const handleSyncToMain = async (runId: string, force = false) => {
    setSyncingRunId(runId);
    setBanner(undefined);
    setBlockedSync(undefined);
    setMissingSync(undefined);
    await executeSyncWorktree({
      projectId: project.id,
      runId,
      force,
      refreshAll: async () => {
        await statusPoll.refresh();
        await checkpointsPoll.refresh();
      },
      onMerged: () => setSelectedTargetId('main'),
      onBanner: setBanner,
      onBlocked: (count) => setBlockedSync({ runId, count }),
      onMissing: (ticketId) => setMissingSync({ ticketId }),
    });
    setSyncingRunId(undefined);
  };

  const handleMoveToDoneUnmerged = async (ticketId: string) => {
    setMissingSync(undefined);
    try {
      await api(`/api/tickets/${ticketId}`, 'PATCH', { status: 'done' });
      await statusPoll.refresh();
      setBanner({ kind: 'ok', text: 'Moved to Done without merging.' });
    } catch (e) {
      setBanner({ kind: 'err', text: errorMessage(e) });
    }
  };

  const handleBuildAndPlay = async (target: WorkspaceDemoTarget, autoOpen = true) => {
    setBuildingTargetId(target.id);
    setBanner(undefined);
    await executeBuildDemo({
      projectId: project.id,
      target,
      refreshStatus: async () => {
        await statusPoll.refresh();
        setSelectedTargetId(target.id);
        if (autoOpen) setActiveTab('demo');
      },
      onOutput: setLastBuildOutput,
      onDemoBuilt: () => {
        setIframeNonce((n) => n + 1);
        setDemoErrors([]);
      },
      onBanner: setBanner,
    });
    setBuildingTargetId(undefined);
  };

  const buildIfStale = (target: WorkspaceDemoTarget | undefined) => {
    if (!target) return;
    if (
      !shouldAutoBuild(target, {
        building: buildingTargetId !== undefined,
        alreadyStarted: autoBuiltTargets.current.has(target.id),
      })
    ) {
      return;
    }
    autoBuiltTargets.current.add(target.id);
    void handleBuildAndPlay(target, false);
  };

  const openDemoTab = (target: WorkspaceDemoTarget) => {
    if (activeTab !== 'demo') autoBuiltTargets.current.clear();
    setActiveTab('demo');
    buildIfStale(target);
  };

  const handleOpenDemo = async (target: WorkspaceDemoTarget) => {
    setSelectedTargetId(target.id);
    setDemoErrors([]);
    if (target.demoUrl) {
      openDemoTab(target);
      setIframeNonce((n) => n + 1);
      return;
    }
    if (target.hasBuildScript) {
      await handleBuildAndPlay(target, true);
      return;
    }
    setActiveTab('demo');
  };

  const allTickets = ticketsPoll.data ?? [];
  const startable = startableCount(allTickets, settingsPoll.data?.autoPickupBacklog ?? false);
  const activeOrRecentTickets = [
    ...allTickets.filter((t) => t.status === 'in_progress' || t.status === 'ready' || t.status === 'review'),
    ...allTickets.filter((t) => t.status === 'done').slice(-4),
  ].slice(0, 8);
  const checkpoints = checkpointsPoll.data ?? [];
  const mainTarget = targets.find((t) => t.kind === 'main') ?? targets[0];

  return (
    <section className="panel project-status-panel" aria-label="Project status and live demo">
      <StatusSummaryBar
        project={project}
        summary={summary}
        mainTarget={mainTarget}
        activeTarget={activeTarget}
        visibleTargetsCount={visibleTargets.length}
        checkpoints={checkpoints}
        activeOrRecentTickets={activeOrRecentTickets}
        startable={startable}
        startingPipeline={startingPipeline}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenDemoTab={openDemoTab}
        onRunPipeline={() => void handleRunPipeline()}
        blockedSync={blockedSync}
        onConfirmBlockedSync={(runId) => void handleSyncToMain(runId, true)}
        onClearBlockedSync={() => setBlockedSync(undefined)}
        missingSync={missingSync}
        onConfirmMissingSync={(ticketId) => void handleMoveToDoneUnmerged(ticketId)}
        onClearMissingSync={() => setMissingSync(undefined)}
        banner={banner}
        onClearBanner={() => setBanner(undefined)}
      />

      {activeTab === 'factory' && (
        <div className="factory-request-stack">
          <FactoryRequestForm
            project={project}
            mainTarget={mainTarget}
            prompt={factoryPrompt}
            onPromptChange={setFactoryPrompt}
            attachments={factoryAttachments}
            onAddFiles={addFilesToAttachments}
            onRemoveAttachment={(id) => setFactoryAttachments((prev) => prev.filter((a) => a.id !== id))}
            autoDispatch={autoDispatch}
            onAutoDispatchChange={setAutoDispatch}
            submitting={submittingFactory}
            onSubmitNow={submitFactoryRequestNow}
          />
          <DemoStateBar
            mainTarget={mainTarget}
            bestPlayableTarget={bestPlayableTarget}
            buildingTargetId={buildingTargetId}
            onOpenDemo={(target) => void handleOpenDemo(target)}
            onOpenBrowser={() => setActiveTab('browser')}
          />
        </div>
      )}

      {activeTab === 'demo' && (
        <LiveDemoView
          project={project}
          targets={targets}
          activeTarget={activeTarget}
          engineAvailable={systemPoll.data?.docker?.available ?? false}
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((f) => !f)}
          onCloseDemo={() => {
            setFullscreen(false);
            setActiveTab('factory');
          }}
          iframeNonce={iframeNonce}
          onBumpIframeNonce={() => setIframeNonce((n) => n + 1)}
          onSelectTarget={(nextId) => {
            setSelectedTargetId(nextId);
            setDemoErrors([]);
            buildIfStale(targets.find((t) => t.id === nextId));
          }}
          buildingTargetId={buildingTargetId}
          onBuildAndPlay={(target, autoOpen) => void handleBuildAndPlay(target, autoOpen)}
          onOpenBrowser={() => setActiveTab('browser')}
          demoFrameRef={demoFrameRef}
          demoErrors={demoErrors}
          onClearDemoErrors={() => setDemoErrors([])}
          onFixDemoError={handleFixDemoErrorWithCoder}
          quickTweakPrompt={quickTweakPrompt}
          onQuickTweakPromptChange={setQuickTweakPrompt}
          submittingTweak={submittingTweak}
          onSubmitQuickTweak={handleQuickDemoTweak}
          lastBuildOutput={lastBuildOutput}
          onClearBuildOutput={() => setLastBuildOutput('')}
        />
      )}

      {activeTab === 'browser' && (
        <LiveBrowserStudio
          key={project.id}
          project={project}
          targetId={activeTarget.id}
          onClose={() => setActiveTab('factory')}
        />
      )}

      {activeTab === 'worktrees' && (
        <WorktreesSectionView
          targets={targets}
          visibleTargets={visibleTargets}
          activeTargetId={activeTarget.id}
          completedWorktreesCount={completedWorktreesCount}
          hideCompletedWorktrees={hideCompletedWorktrees}
          onToggleHideCompleted={setHideCompletedWorktrees}
          syncingRunId={syncingRunId}
          buildingTargetId={buildingTargetId}
          onOpenDemo={(target) => void handleOpenDemo(target)}
          onBuildAndPlay={(target, autoOpen) => void handleBuildAndPlay(target, autoOpen)}
          onSyncToMain={(runId) => void handleSyncToMain(runId)}
        />
      )}

      {activeTab === 'checkpoints' && (
        <CheckpointsSectionView
          checkpoints={checkpoints}
          rollingBackSha={rollingBackSha}
          onRollback={(sha) => void handleRollbackCheckpoint(sha)}
        />
      )}
    </section>
  );
}

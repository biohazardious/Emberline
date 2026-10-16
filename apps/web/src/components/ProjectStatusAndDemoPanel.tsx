import type {
  BuildDemoResponse,
  FactoryAttachmentInput,
  FactoryRequestResponse,
  FactorySettings,
  Project,
  ProjectCheckpoint,
  ProjectStatusSummary,
  SyncWorktreeResponse,
  Ticket,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Bug,
  Clock,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  Globe,
  Hammer,
  Maximize2,
  MessageSquare,
  Minimize2,
  Package,
  Paperclip,
  Play,
  Rocket,
  RotateCcwClock,
  RotateCw,
  Settings,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { DEMO_IFRAME_SANDBOX } from '../sandbox';
import { useApi } from '../hooks/useApi';
import { startableCount } from '../ticketDeps';
import { LiveBrowserStudio } from './LiveBrowserStudio';
import { PersonaBadge } from './PersonaBadge';

function getFactoryExamples(project: Project, target?: WorkspaceDemoTarget): string[] {
  const appType = project.appType ?? 'fullstack';
  const layers = target?.detectedLayers ?? [];
  const stack = (target?.detectedStack ?? '').toLowerCase();

  if (
    appType === 'embedded_iot' ||
    layers.includes('Embedded / Hardware Firmware') ||
    stack.includes('platformio')
  ) {
    return [
      'Implement I2C / SPI bus scanner, EEPROM read/write routine & CRC verification',
      'Add non-blocking serial command CLI (115200 baud) with diagnostic status output',
      'Add PlatformIO environment targets, pinout config header, and hardware test routine',
    ];
  }

  if (
    appType === 'cli_tool' ||
    layers.includes('CLI / System Automation') ||
    stack.includes('shell')
  ) {
    return [
      'Add --dry-run mode, pre-flight kernel/ZFS checks, and automatic rollback on failure',
      'Add structured JSON/log output, strict exit codes, and systemd service/timer unit',
      'Add SHA256 artifact checksum verification and automated smoke test script',
    ];
  }

  if (
    appType === 'mobile_desktop' ||
    layers.includes('Desktop / Mobile Native') ||
    stack.includes('rust')
  ) {
    return [
      'Add persistent JSON configuration, multi-monitor window state, and system tray controls',
      'Implement smooth hardware-accelerated rendering, keyboard shortcuts, and theme presets',
      'Add typed IPC command bridge between native backend and UI layer',
    ];
  }

  if (appType === 'ai_agents') {
    return [
      'Build multi-agent DAG task router with live SSE streaming and tool-call execution logs',
      'Add per-agent token/cost telemetry ledger and automatic fallback circuit breaker',
      'Add interactive agent workflow inspector and customizable system prompt templates',
    ];
  }

  if (appType === 'api_service' || appType === 'library') {
    return [
      'Add OpenAPI schema validation, structured error middleware, and /healthz diagnostics',
      'Implement database migration runner, repository layer, and audit log endpoints',
      'Add comprehensive integration test suite and request rate-limiting',
    ];
  }

  if (appType === 'game_interactive') {
    return [
      'Add a live score counter and persistent high-score HUD overlay',
      'Modernize the visual design, color palette, and UI animations',
      'Add a game-over summary screen with a local leaderboard',
    ];
  }

  // Default: Web SaaS, Full-Stack Multi-Layer Portals, Enterprise Forms & Dashboards
  return [
    'Build a multi-step workflow form with validation, status tracking, and CSV/PDF export',
    'Add role-based dashboard view with filterable data grid and REST API integration',
    'Modernize UI layout, responsive navigation, dark theme polish, and error boundaries',
  ];
}

interface DemoRuntimeError {
  message: string;
  stack?: string;
  timestamp: string;
}

interface AttachedFilePreview extends FactoryAttachmentInput {
  id: string;
  previewDataUrl?: string;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

type StudioTab = 'factory' | 'demo' | 'browser' | 'worktrees' | 'checkpoints';

export function ProjectStatusAndDemoPanel({ project }: { project: Project }) {
  const [, navigate] = useLocation();
  const statusPoll = useApi<ProjectStatusSummary>(`/api/projects/${project.id}/status`, 4_000);
  const ticketsPoll = useApi<Ticket[]>(`/api/projects/${project.id}/tickets`, 5_000);
  const settingsPoll = useApi<FactorySettings>('/api/factory/settings', 15_000);
  const checkpointsPoll = useApi<ProjectCheckpoint[]>(`/api/projects/${project.id}/checkpoints`, 10_000);

  const [activeTab, setActiveTab] = useState<StudioTab>('factory');
  const [selectedTargetId, setSelectedTargetId] = useState<string>('main');
  const [fullscreen, setFullscreen] = useState(false);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [syncingRunId, setSyncingRunId] = useState<string>();
  const [buildingTargetId, setBuildingTargetId] = useState<string>();
  const [factoryPrompt, setFactoryPrompt] = useState('');
  const [factoryAttachments, setFactoryAttachments] = useState<AttachedFilePreview[]>([]);
  const [dragOverComposer, setDragOverComposer] = useState(false);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [submittingFactory, setSubmittingFactory] = useState(false);
  const [startingPipeline, setStartingPipeline] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string }>();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-resize the multi-line prompt textarea as text grows (starts at ~2-3 rows, expands up to 260px)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 68), 260)}px`;
  }, [factoryPrompt]);

  const addFilesToAttachments = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 10 - factoryAttachments.length);
    if (list.length === 0) return;

    const added: AttachedFilePreview[] = [];
    for (const file of list) {
      if (file.size > 15 * 1024 * 1024) {
        setBanner({
          kind: 'err',
          text: `File "${file.name}" exceeds the 15 MB per-file limit.`,
        });
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const rawBase64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
        const isImage =
          file.type.startsWith('image/') ||
          /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(file.name);
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || `pasted-image-${Date.now()}.png`,
          mimeType: file.type || 'application/octet-stream',
          dataBase64: rawBase64,
          sizeBytes: file.size,
          previewDataUrl: isImage ? dataUrl : undefined,
        });
      } catch (err) {
        setBanner({ kind: 'err', text: errorMessage(err) });
      }
    }

    if (added.length > 0) {
      setFactoryAttachments((prev) => [...prev, ...added].slice(0, 10));
    }
  };

  const removeAttachment = (id: string) => {
    setFactoryAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleComposerPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFilesToAttachments(files);
    }
  };

  const handleComposerDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragOverComposer(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void addFilesToAttachments(e.dataTransfer.files);
    }
  };

  // Demo Runtime Error Catcher + Quick Tweak + Checkpoints + Build Output Console
  const [demoErrors, setDemoErrors] = useState<DemoRuntimeError[]>([]);
  const [quickTweakPrompt, setQuickTweakPrompt] = useState('');
  const [submittingTweak, setSubmittingTweak] = useState(false);
  const [rollingBackSha, setRollingBackSha] = useState<string>();
  const [lastBuildOutput, setLastBuildOutput] = useState<string>('');
  const demoFrameRef = useRef<HTMLIFrameElement | null>(null);

  // Worktrees filter: hide completed worktrees by default to avoid clutter
  const [hideCompletedWorktrees, setHideCompletedWorktrees] = useState(true);

  // Listen for runtime errors forwarded by the injected errorBridgeScript inside the Demo iframe
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // Only trust messages from our own demo frame (sandboxed, so its origin is "null").
      if (!demoFrameRef.current || ev.source !== demoFrameRef.current.contentWindow) return;
      const data = ev.data as { type?: string; message?: string; stack?: string } | undefined;
      if (data && data.type === 'emberline:demo-error' && typeof data.message === 'string') {
        setDemoErrors((prev) => [
          {
            message: data.message!,
            stack: data.stack,
            timestamp: new Date().toLocaleTimeString(),
          },
          ...prev.slice(0, 4),
        ]);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const summary = statusPoll.data;
  if (!summary) return null;

  const targets = summary.targets;
  const activeTarget: WorkspaceDemoTarget =
    targets.find((t) => t.id === selectedTargetId) ??
    targets.find((t) => Boolean(t.demoUrl)) ??
    targets[0]!;

  const playableTargets = targets.filter((t) => Boolean(t.demoUrl));
  const bestPlayableTarget =
    playableTargets[0] ?? targets.find((t) => t.hasBuildScript) ?? targets[0];

  const isTargetCompleted = (t: WorkspaceDemoTarget) =>
    t.kind === 'worktree' && (t.runStatus === 'done' || t.runStatus === 'failed');

  const completedWorktreesCount = targets.filter(isTargetCompleted).length;
  const visibleTargets = hideCompletedWorktrees
    ? targets.filter((t) => !isTargetCompleted(t))
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
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: trimmed,
          leadPersona: 'product_owner',
          permissionMode: 'auto',
          autoDispatch,
          attachments:
            factoryAttachments.length > 0
              ? factoryAttachments.map((a) => ({
                  name: a.name,
                  mimeType: a.mimeType,
                  dataBase64: a.dataBase64,
                  sizeBytes: a.sizeBytes,
                }))
              : undefined,
        },
      );
      const attachedCount = factoryAttachments.length;
      setFactoryPrompt('');
      setFactoryAttachments([]);
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({
        kind: 'ok',
        text: `Factory request${attachedCount > 0 ? ` (+${attachedCount} attached file${attachedCount > 1 ? 's' : ''})` : ''} dispatched to Product Owner (${res.ticket.key}). PO will refine the spec, create specialist tickets (Coder, UI/UX, QA), and ${autoDispatch ? 'start each one as soon as the tickets it depends on are merged, several in parallel' : 'place them in Ready'}.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingFactory(false);
    }
  };

  const handleSubmitFactoryRequest = async (e: FormEvent) => {
    e.preventDefault();
    await submitFactoryRequestNow();
  };

  const handleQuickDemoTweak = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = quickTweakPrompt.trim();
    if (!trimmed) return;
    setSubmittingTweak(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: `[Live Demo Quick Tweak] ${trimmed}`,
          leadPersona: 'coder',
          permissionMode: 'auto',
          autoDispatch: true,
        },
      );
      setQuickTweakPrompt('');
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({
        kind: 'ok',
        text: `Quick demo tweak dispatched (${res.ticket.key}). Workspace will auto-sync when finished.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingTweak(false);
    }
  };

  const handleFixDemoErrorWithCoder = async (errItem: DemoRuntimeError) => {
    setSubmittingTweak(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: `[Runtime Error Fix] The Live Demo threw the following runtime error in the browser:\n\nError: ${errItem.message}\n${errItem.stack ? `Stack:\n\`\`\`\n${errItem.stack.slice(0, 1200)}\n\`\`\`\n` : ''}\nPlease diagnose and fix the root cause in the codebase and rebuild the bundle.`,
          leadPersona: 'coder',
          permissionMode: 'auto',
          autoDispatch: true,
        },
      );
      setDemoErrors([]);
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({
        kind: 'ok',
        text: `Runtime error sent to Coder Agent (${res.ticket.key}) for automatic self-healing.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingTweak(false);
    }
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
      setBanner({
        kind: 'ok',
        text: `Rolled back main workspace to checkpoint ${sha.slice(0, 8)}.`,
      });
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
      setBanner({
        kind: 'ok',
        text: 'Pipeline activated: Ready/Backlog tickets start in dependency order, several in parallel.',
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setStartingPipeline(false);
    }
  };

  const handleSyncToMain = async (runId: string) => {
    setSyncingRunId(runId);
    setBanner(undefined);
    try {
      const res = await api<SyncWorktreeResponse>(
        `/api/projects/${project.id}/sync-worktree`,
        'POST',
        { runId },
      );
      await statusPoll.refresh();
      await checkpointsPoll.refresh();
      if (res.ok) setSelectedTargetId('main');
      setBanner({ kind: res.ok ? 'ok' : 'err', text: res.summary });
    } catch (e) {
      setBanner({ kind: 'err', text: errorMessage(e) });
    } finally {
      setSyncingRunId(undefined);
    }
  };

  const handleBuildAndPlay = async (target: WorkspaceDemoTarget, autoOpen = true) => {
    setBuildingTargetId(target.id);
    setBanner(undefined);
    try {
      const res = await api<BuildDemoResponse>(
        `/api/projects/${project.id}/build-demo`,
        'POST',
        { targetId: target.id },
      );
      setLastBuildOutput(res.output || '');
      await statusPoll.refresh();
      setSelectedTargetId(target.id);
      if (res.ok && res.demoUrl) {
        setIframeNonce((n) => n + 1);
        setDemoErrors([]);
        if (autoOpen) setActiveTab('demo');
        setBanner({
          kind: 'ok',
          text: `Built interactive bundle (${res.demoEntryRelPath}) for ${target.label}.`,
        });
      } else if (res.ok) {
        if (autoOpen) setActiveTab('demo');
        setBanner({
          kind: 'ok',
          text: `Build & verification succeeded for ${target.label} (${target.buildCommand ?? target.detectedStack ?? 'workspace'}).`,
        });
      } else {
        if (autoOpen) setActiveTab('demo');
        setBanner({
          kind: 'err',
          text: `Build / verification failed: ${res.output.slice(-240)}`,
        });
      }
    } catch (e) {
      setBanner({ kind: 'err', text: errorMessage(e) });
    } finally {
      setBuildingTargetId(undefined);
    }
  };

  const handleOpenDemo = async (target: WorkspaceDemoTarget) => {
    setSelectedTargetId(target.id);
    setDemoErrors([]);
    if (target.demoUrl) {
      setActiveTab('demo');
      setIframeNonce((n) => n + 1);
      return;
    }
    if (target.hasBuildScript) {
      await handleBuildAndPlay(target, true);
      return;
    }
    setActiveTab('demo');
  };

  const { ticketCounts } = summary;
  const allTickets = ticketsPoll.data ?? [];
  const startable = startableCount(allTickets, settingsPoll.data?.autoPickupBacklog ?? false);
  const activeOrRecentTickets = [
    ...allTickets.filter((t) => t.status === 'in_progress' || t.status === 'ready' || t.status === 'review'),
    ...allTickets.filter((t) => t.status === 'done').slice(-4),
  ].slice(0, 8);
  const checkpoints = checkpointsPoll.data ?? [];
  const mainTarget = targets.find((t) => t.kind === 'main') ?? targets[0];

  return (
    <section className="panel" aria-label="Project status and live demo">
      {/* Top Header: Project Status & Quick Actions */}
      <div className="panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span
            className="pill pill-live"
            style={{
              borderColor: 'color-mix(in hsl, var(--ok) 45%, var(--border))',
              background: 'color-mix(in hsl, var(--ok) 12%, var(--surface))',
              color: 'var(--ok)',
              fontWeight: 600,
            }}
            title={project.name}
          >
            <span className="dot" />
            <span className="pill-text">{project.name}</span>
          </span>
          {summary.autoChainActive && (
            <span className="badge badge-soft mono">⟳ Auto-Pipeline Active</span>
          )}
          <span className="muted small">
            {summary.completionPercent}% complete · {ticketCounts.done}/{ticketCounts.total} tickets done
          </span>
        </div>

        <div className="actions">
          {(ticketCounts.ready > 0 || ticketCounts.backlog > 0) && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={startingPipeline}
              onClick={() => void handleRunPipeline()}
              title="Run Ready/Backlog tickets with their assigned personas in dependency order, several in parallel, and sync each to Main"
            >
              {startingPipeline ? (
                'Starting…'
              ) : (
                <>
                  <Zap className="icon" aria-hidden /> Run Pipeline (
                  {startable})
                </>
              )}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigate(`/projects/${project.id}/code`)}
            title="Open integrated Code Explorer & Monaco Editor"
          >
            <FileCode className="icon" aria-hidden /> Code Explorer
          </button>
          <a
            href={`/api/projects/${project.id}/export.tar.gz`}
            className="btn btn-sm"
            title="Download project workspace as .tar.gz archive"
          >
            <Package className="icon" aria-hidden /> .tar.gz
          </a>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => navigate(`/projects/${project.id}/board`)}
          >
            Kanban Board →
          </button>
        </div>
      </div>

      {/* Progress Bar & Live Factory Pipeline Stepper */}
      <div>
        <div
          style={{
            height: 6,
            borderRadius: 999,
            background: 'var(--bg-elevated)',
            overflow: 'hidden',
            marginBottom: 8,
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              width: `${summary.completionPercent}%`,
              height: '100%',
              background: 'linear-gradient(90deg, var(--ember-1), var(--ok))',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="badge">Backlog: {ticketCounts.backlog}</span>
            <span className="badge">Ready: {ticketCounts.ready}</span>
            <span className={ticketCounts.in_progress > 0 ? 'badge badge-soft' : 'badge'}>
              In Progress: {ticketCounts.in_progress}
            </span>
            <span className={ticketCounts.review > 0 ? 'badge badge-soft' : 'badge'}>
              In Review: {ticketCounts.review}
            </span>
            <span
              className="badge"
              style={
                ticketCounts.done > 0
                  ? {
                      borderColor: 'color-mix(in hsl, var(--ok) 45%, var(--border))',
                      color: 'var(--ok)',
                    }
                  : undefined
              }
            >
              Done: {ticketCounts.done}
            </span>
          </div>

          {activeOrRecentTickets.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                overflowX: 'auto',
                padding: '4px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
              }}
              title="Live Specialist Persona Pipeline Stepper"
            >
              <span className="mono muted" style={{ fontSize: '0.68rem' }}>
                Pipeline:
              </span>
              {activeOrRecentTickets.map((t, idx) => {
                const icon =
                  t.status === 'done'
                    ? '✓'
                    : t.status === 'in_progress'
                      ? '●'
                      : t.status === 'review'
                        ? '◐'
                        : '○';
                const color =
                  t.status === 'done'
                    ? 'var(--ok)'
                    : t.status === 'in_progress'
                      ? 'var(--ember-2)'
                      : t.status === 'review'
                        ? 'var(--warn)'
                        : 'var(--muted)';
                return (
                  <span
                    key={t.id}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    title={`${t.key}: ${t.title} (${t.status})`}
                  >
                    {idx > 0 && <span className="muted">→</span>}
                    <span className="mono" style={{ color, fontWeight: 600, fontSize: '0.72rem' }}>
                      {icon} {t.key}
                    </span>
                    <PersonaBadge persona={t.persona} />
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Studio Sub-Navigation Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderBottom: '1px solid var(--border)',
          paddingBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <div className="segmented" role="tablist" aria-label="Project studio sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'factory'}
            className={activeTab === 'factory' ? 'active' : ''}
            onClick={() => setActiveTab('factory')}
          >
            <Zap className="icon" aria-hidden /> AI Factory Prompt
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'demo'}
            className={activeTab === 'demo' ? 'active' : ''}
            onClick={() => setActiveTab('demo')}
          >
            <Play className="icon" aria-hidden /> Preview &amp; Build
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'browser'}
            className={activeTab === 'browser' ? 'active' : ''}
            onClick={() => setActiveTab('browser')}
          >
            <Globe className="icon" aria-hidden /> Live Browser
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'worktrees'}
            className={activeTab === 'worktrees' ? 'active' : ''}
            onClick={() => setActiveTab('worktrees')}
          >
            <GitBranch className="icon" aria-hidden /> Worktrees ({visibleTargets.length}/{targets.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'checkpoints'}
            className={activeTab === 'checkpoints' ? 'active' : ''}
            onClick={() => setActiveTab('checkpoints')}
          >
            <Clock className="icon" aria-hidden /> Checkpoints ({checkpoints.length})
          </button>
        </div>

        <span
          className="badge mono hide-sm"
          title="Host bind-mount directory mapped to container /workspaces"
        >
          {summary.hostBindHint} <ArrowLeftRight className="icon" aria-hidden />{' '}
          {summary.workspaceRoot}
        </span>
      </div>

      {banner && (
        <div
          className={`banner ${banner.kind === 'ok' ? 'banner-ok' : 'banner-error'}`}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setBanner(undefined)}
            aria-label="Close"
          >
            <X className="icon" aria-hidden />
          </button>
        </div>
      )}

      {/* TAB 1: AI Factory Prompt + Compact Main Workspace Card */}
      {activeTab === 'factory' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <form
            onSubmit={(e) => void handleSubmitFactoryRequest(e)}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!dragOverComposer) setDragOverComposer(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOverComposer(false);
            }}
            onDrop={handleComposerDrop}
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-sm)',
              background: dragOverComposer
                ? 'color-mix(in hsl, var(--ember-1) 10%, var(--surface-2))'
                : 'var(--surface-2)',
              border: dragOverComposer
                ? '1px dashed var(--ember-1)'
                : '1px solid color-mix(in hsl, var(--ember-1) 35%, var(--border))',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              transition: 'border-color 140ms ease, background 140ms ease',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '0.8rem', color: 'var(--ember-2)' }}>
                  <Zap className="icon" aria-hidden /> Ask AI Factory (PO Orchestrator → Specialist
                  Personas)
                </strong>
                <PersonaBadge persona="product_owner" />
                <span className="muted small">→ delegates to</span>
                <PersonaBadge persona="coder" />
                <PersonaBadge persona="ui_ux" />
                <PersonaBadge persona="qa" />
              </div>
              <label
                className="small muted"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoDispatch}
                  onChange={(e) => setAutoDispatch(e.target.checked)}
                />
                Auto-dispatch &amp; sync specialist tickets in dependency order (parallel when independent)
              </label>
            </div>

            {/* Gemini / Claude style multi-line composer container */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-0)',
                border: '1px solid var(--border-strong)',
              }}
            >
              {/* Attached files / images preview strip */}
              {factoryAttachments.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    paddingBottom: 6,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {factoryAttachments.map((att) => (
                    <div
                      key={att.id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px 4px 6px',
                        borderRadius: 'var(--radius-xs)',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-strong)',
                        maxWidth: 260,
                      }}
                    >
                      {att.previewDataUrl ? (
                        <img
                          src={att.previewDataUrl}
                          alt={att.name}
                          style={{
                            width: 32,
                            height: 32,
                            objectFit: 'cover',
                            borderRadius: 4,
                            border: '1px solid var(--border)',
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 4,
                            background: 'var(--surface-1)',
                            border: '1px solid var(--border)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '0.95rem',
                            flexShrink: 0,
                          }}
                        >
                          <FileText className="icon" aria-hidden />
                        </span>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          minWidth: 0,
                          lineHeight: 1.2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: '0.73rem',
                            fontWeight: 600,
                            color: 'var(--text-0)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={att.name}
                        >
                          {att.name}
                        </span>
                        <span className="muted mono" style={{ fontSize: '0.65rem' }}>
                          {formatFileSize(att.sizeBytes)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => removeAttachment(att.id)}
                        title="Remove attachment"
                        aria-label="Remove attachment"
                        style={{ padding: '1px 5px', fontSize: '0.72rem', marginLeft: 2 }}
                      >
                        <X className="icon" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <textarea
                ref={textareaRef}
                rows={2}
                value={factoryPrompt}
                onChange={(e) => setFactoryPrompt(e.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!submittingFactory && (factoryPrompt.trim() || factoryAttachments.length > 0)) {
                      void submitFactoryRequestNow();
                    }
                  }
                }}
                placeholder='Describe a feature, bug fix, or UI change… (Shift+Enter for new line, Enter to delegate, paste or drop screenshots/files directly)'
                style={{
                  width: '100%',
                  minHeight: 54,
                  maxHeight: 240,
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--text-0)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '0.88rem',
                  lineHeight: 1.5,
                  padding: 0,
                  overflowY: 'auto',
                }}
              />

              {/* Composer bottom action bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                  paddingTop: 6,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.json,.md,.txt,.csv,.svg,.html,.css,.ts,.tsx,.js,.pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        void addFilesToAttachments(e.target.files);
                        e.target.value = '';
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach reference images, UI mockups, sprites, JSON specs, or logs (or drag & drop / Ctrl+V paste)"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: '0.75rem',
                    }}
                  >
                    <Paperclip className="icon" aria-hidden /> Attach Files / Images
                    {factoryAttachments.length > 0 && (
                      <span className="badge badge-accent" style={{ fontSize: '0.65rem' }}>
                        {factoryAttachments.length}/10
                      </span>
                    )}
                  </button>
                  <span className="muted" style={{ fontSize: '0.7rem' }}>
                    Drop files, <span className="mono">Ctrl+V</span> screenshot,{' '}
                    <span className="mono">Shift+Enter</span> newline
                  </span>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    submittingFactory ||
                    (!factoryPrompt.trim() && factoryAttachments.length === 0)
                  }
                >
                  {submittingFactory ? (
                    'Delegating…'
                  ) : (
                    <>
                      <Rocket className="icon" aria-hidden /> Delegate to AI Factory
                    </>
                  )}
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
              }}
            >
              <span className="muted small">Quick examples:</span>
              {getFactoryExamples(project, mainTarget).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="chip-btn"
                  onClick={() => setFactoryPrompt(ex)}
                >
                  + {ex}
                </button>
              ))}
            </div>
          </form>

          {mainTarget && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="badge badge-soft mono">MAIN WORKSPACE</span>
                <span className="mono small">{mainTarget.workspacePath}</span>
                <span className="muted small">· {mainTarget.fileCount} files</span>
                {mainTarget.detectedStack && (
                  <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                    <Settings className="icon" aria-hidden /> {mainTarget.detectedStack}
                  </span>
                )}
                {mainTarget.detectedLayers?.map((layer) => (
                  <span
                    key={layer}
                    className="badge"
                    style={{
                      fontSize: '0.66rem',
                      borderColor: 'color-mix(in hsl, var(--ember-1) 35%, var(--border))',
                    }}
                  >
                    {layer}
                  </span>
                ))}
                {mainTarget.demoEntryRelPath ? (
                  <span className="small" style={{ color: 'var(--ok)' }}>
                    ● Bundle ready (<span className="mono">{mainTarget.demoEntryRelPath}</span>)
                  </span>
                ) : mainTarget.buildCommand ? (
                  <span className="muted mono small" title="Detected build / verification command">
                    cmd: {mainTarget.buildCommand}
                  </span>
                ) : null}
              </div>
              <div className="actions">
                {bestPlayableTarget && (bestPlayableTarget.demoUrl || bestPlayableTarget.hasBuildScript) && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={buildingTargetId === bestPlayableTarget.id}
                    onClick={() => void handleOpenDemo(bestPlayableTarget)}
                  >
                    {buildingTargetId === bestPlayableTarget.id ? (
                      'Building…'
                    ) : bestPlayableTarget.demoUrl ? (
                      <>
                        <Play className="icon" aria-hidden /> Open Live Preview
                      </>
                    ) : (
                      <>
                        <Hammer className="icon" aria-hidden /> Build &amp; Verify
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setActiveTab('browser')}
                >
                  <Globe className="icon" aria-hidden /> Open Live Browser Studio
                </button>
                {mainTarget.hasBuildScript && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={buildingTargetId === mainTarget.id}
                    onClick={() => void handleBuildAndPlay(mainTarget, false)}
                    title={mainTarget.buildCommand ? `Run ${mainTarget.buildCommand}` : 'Run build'}
                  >
                    {buildingTargetId === mainTarget.id ? (
                      'Building…'
                    ) : mainTarget.demoUrl ? (
                      <>
                        <Hammer className="icon" aria-hidden /> Rebuild Bundle
                      </>
                    ) : (
                      <>
                        <Hammer className="icon" aria-hidden /> Run Build / Check
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Embedded Live Preview & Universal Build / Verification Console */}
      {activeTab === 'demo' && (
        <div>
          {activeTarget.demoUrl ? (
            <div
              style={
                fullscreen
                  ? {
                      position: 'fixed',
                      inset: 16,
                      zIndex: 1000,
                      background: 'var(--bg)',
                      border: '1px solid var(--ember-1)',
                      borderRadius: 'var(--radius)',
                      display: 'flex',
                      flexDirection: 'column',
                      boxShadow: '0 24px 64px rgba(0,0,0,0.75)',
                    }
                  : {
                      border: '1px solid var(--ember-1)',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      background: 'var(--bg)',
                    }
              }
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 12px',
                  background: 'var(--bg-elevated)',
                  borderBottom: '1px solid var(--border)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--ok)' }}>
                    ● Live Interactive Preview
                  </span>
                  <select
                    className="input"
                    value={activeTarget.id}
                    onChange={(e) => {
                      setSelectedTargetId(e.target.value);
                      setIframeNonce((n) => n + 1);
                      setDemoErrors([]);
                    }}
                    style={{ width: 'auto', maxWidth: 'min(320px, 100%)', fontSize: '0.78rem', padding: '4px 8px' }}
                  >
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} {t.demoEntryRelPath ? `(${t.demoEntryRelPath})` : `(${t.detectedStack ?? 'no bundle'})`}
                      </option>
                    ))}
                  </select>
                  <span className="mono muted small">{activeTarget.demoEntryRelPath}</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setDemoErrors([]);
                      setIframeNonce((n) => n + 1);
                    }}
                  >
                    <RotateCw className="icon" aria-hidden /> Reload
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setFullscreen((f) => !f)}
                  >
                    {fullscreen ? (
                      <>
                        <Minimize2 className="icon" aria-hidden /> Exit Fullscreen
                      </>
                    ) : (
                      <>
                        <Maximize2 className="icon" aria-hidden /> Fullscreen
                      </>
                    )}
                  </button>
                  <a
                    href={activeTarget.demoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    <ExternalLink className="icon" aria-hidden /> New Tab
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setFullscreen(false);
                      setActiveTab('factory');
                    }}
                  >
                    <X className="icon" aria-hidden /> Close
                  </button>
                </div>
              </div>

              {demoErrors.length > 0 && (
                <div
                  className="banner banner-error"
                  style={{
                    borderRadius: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong>
                      <Bug className="icon" aria-hidden /> Runtime Error Detected in Live Preview ({demoErrors[0]!.timestamp}):
                    </strong>
                    <div
                      className="mono small"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={demoErrors[0]!.message}
                    >
                      {demoErrors[0]!.message}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={submittingTweak}
                      onClick={() => void handleFixDemoErrorWithCoder(demoErrors[0]!)}
                    >
                      <Wrench className="icon" aria-hidden /> Fix Error with Coder Agent
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setDemoErrors([])}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              <form
                onSubmit={(e) => void handleQuickDemoTweak(e)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  background: 'var(--surface-2)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="mono muted small">
                  <MessageSquare className="icon" aria-hidden /> Quick Live Tweak:
                </span>
                <input
                  type="text"
                  className="input"
                  value={quickTweakPrompt}
                  onChange={(e) => setQuickTweakPrompt(e.target.value)}
                  placeholder='Type an instant UI, API, or logic tweak (e.g. "Add CSV export button to table" or "Refine form validation")…'
                  style={{ width: 'auto', flex: 1, fontSize: '0.78rem', padding: '4px 8px' }}
                />
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={submittingTweak || !quickTweakPrompt.trim()}
                >
                  {submittingTweak ? (
                    'Sending…'
                  ) : (
                    <>
                      <Sparkles className="icon" aria-hidden /> Apply Tweak
                    </>
                  )}
                </button>
              </form>

              <iframe
                ref={demoFrameRef}
                key={`${activeTarget.id}-${iframeNonce}`}
                src={`${activeTarget.demoUrl}?v=${iframeNonce}`}
                sandbox={DEMO_IFRAME_SANDBOX}
                title={`Live Preview - ${activeTarget.label}`}
                style={{
                  width: '100%',
                  height: fullscreen ? '100%' : 520,
                  flex: fullscreen ? 1 : undefined,
                  border: 'none',
                  background: 'var(--surface)',
                }}
              />
            </div>
          ) : (
            <div
              style={{
                padding: '16px 18px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '0.88rem' }}>
                    <Wrench className="icon" aria-hidden /> Workspace Build, Verification &amp;
                    Architecture Console
                  </strong>
                  <select
                    className="input"
                    value={activeTarget.id}
                    onChange={(e) => setSelectedTargetId(e.target.value)}
                    style={{ width: 'auto', maxWidth: 'min(320px, 100%)', fontSize: '0.78rem', padding: '4px 8px' }}
                  >
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} ({t.detectedStack ?? `${t.fileCount} files`})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="actions">
                  {activeTarget.hasBuildScript && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={buildingTargetId === activeTarget.id}
                      onClick={() => void handleBuildAndPlay(activeTarget, true)}
                    >
                      {buildingTargetId === activeTarget.id ? (
                        'Running Build / Verification…'
                      ) : (
                        <>
                          <Hammer className="icon" aria-hidden />{' '}
                          {`Run Build & Verify${activeTarget.buildCommand ? ` (${activeTarget.buildCommand})` : ''}`}
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setActiveTab('browser')}
                  >
                    <Globe className="icon" aria-hidden /> Live Browser Studio
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate(`/projects/${project.id}/code`)}
                  >
                    <FileCode className="icon" aria-hidden /> Code Explorer
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-xs)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                }}
              >
                <span className="muted small">Detected Stack:</span>
                <span className="badge mono">{activeTarget.detectedStack ?? 'Polyglot / Custom'}</span>
                {activeTarget.buildCommand && (
                  <>
                    <span className="muted small">Build / Check Command:</span>
                    <span className="badge badge-soft mono">{activeTarget.buildCommand}</span>
                  </>
                )}
                {activeTarget.detectedLayers && activeTarget.detectedLayers.length > 0 && (
                  <>
                    <span className="muted small">Layers:</span>
                    {activeTarget.detectedLayers.map((layer) => (
                      <span key={layer} className="badge" style={{ fontSize: '0.7rem' }}>
                        {layer}
                      </span>
                    ))}
                  </>
                )}
              </div>

              <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                This workspace target does not expose a static HTML bundle yet (common for{' '}
                <strong>Backend APIs, CLI / System Automation, Desktop &amp; Mobile Apps, Embedded / ESP32 Firmware</strong>,
                or unbuilt web projects). Use <strong>
                  <Hammer className="icon" aria-hidden /> Run Build &amp; Verify
                </strong> above to compile or syntax-check the
                project, or open <strong>
                  <Globe className="icon" aria-hidden /> Live Browser Studio
                </strong> to inspect any running web server URL.
              </p>

              {lastBuildOutput && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="mono muted small">Last Build / Compiler Verification Output:</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setLastBuildOutput('')}
                    >
                      Clear Log
                    </button>
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-xs)',
                      background: 'var(--bg-0)',
                      border: '1px solid var(--border-strong)',
                      fontSize: '0.74rem',
                      lineHeight: 1.45,
                      maxHeight: 280,
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {lastBuildOutput}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Live Browser Studio */}
      {activeTab === 'browser' && (
        <LiveBrowserStudio
          project={project}
          targetId={activeTarget.id}
          onClose={() => setActiveTab('factory')}
        />
      )}

      {/* TAB 4: Workspaces & Agent Worktrees */}
      {activeTab === 'worktrees' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span className="muted small">
              Showing {visibleTargets.length} of {targets.length} workspace targets.
            </span>
            {completedWorktreesCount > 0 && (
              <label
                className="small"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                }}
              >
                <input
                  type="checkbox"
                  checked={hideCompletedWorktrees}
                  onChange={() => setHideCompletedWorktrees((v) => !v)}
                />
                <span>Hide Completed Worktrees ({completedWorktreesCount})</span>
              </label>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
              gap: 10,
            }}
          >
            {visibleTargets.map((target) => {
              const isSelected = target.id === activeTarget.id;
              const isSyncing = syncingRunId === target.id;
              const isBuilding = buildingTargetId === target.id;

              return (
                <div
                  key={target.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-2)',
                    border: isSelected ? '1px solid var(--ember-1)' : '1px solid var(--border)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span className="badge badge-soft mono">
                          {target.kind === 'main' ? 'MAIN' : target.ticketKey ?? 'WORKTREE'}
                        </span>
                        {target.persona && <PersonaBadge persona={target.persona} />}
                      </div>
                      <span className="mono muted small">{target.fileCount} files</span>
                    </div>

                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '0.84rem',
                        marginBottom: 3,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={target.label}
                    >
                      {target.label}
                    </div>

                    <div
                      className="mono muted small"
                      style={{
                        marginBottom: 6,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={target.workspacePath}
                    >
                      {target.workspacePath}
                    </div>

                    {(target.detectedStack || (target.detectedLayers && target.detectedLayers.length > 0)) && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                        {target.detectedStack && (
                          <span className="badge mono" style={{ fontSize: '0.66rem' }}>
                            <Settings className="icon" aria-hidden /> {target.detectedStack}
                          </span>
                        )}
                        {target.detectedLayers?.map((layer) => (
                          <span key={layer} className="badge" style={{ fontSize: '0.64rem' }}>
                            {layer}
                          </span>
                        ))}
                      </div>
                    )}

                    {target.demoEntryRelPath ? (
                      <div className="small" style={{ color: 'var(--ok)', marginBottom: 6 }}>
                        ● Interactive bundle: <span className="mono">{target.demoEntryRelPath}</span>
                      </div>
                    ) : target.hasBuildScript ? (
                      <div className="small" style={{ color: 'var(--warn)', marginBottom: 6 }}>
                        ◐ Build / Check ready (<span className="mono">{target.buildCommand ?? 'build'}</span>)
                      </div>
                    ) : null}

                    {target.topFiles.length > 0 && (
                      <div
                        className="mono muted small"
                        style={{
                          lineHeight: 1.45,
                          padding: '5px 7px',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          maxHeight: 54,
                          overflowY: 'auto',
                        }}
                      >
                        {target.topFiles.slice(0, 8).join(' · ')}
                        {target.topFiles.length > 8 ? ` +${target.topFiles.length - 8} more` : ''}
                      </div>
                    )}
                  </div>

                  <div className="actions" style={{ marginTop: 4 }}>
                    {(target.demoUrl || target.hasBuildScript) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={isBuilding}
                        onClick={() => void handleOpenDemo(target)}
                      >
                        {isBuilding ? (
                          'Building…'
                        ) : target.demoUrl ? (
                          <>
                            <Play className="icon" aria-hidden /> Open Preview
                          </>
                        ) : (
                          <>
                            <Hammer className="icon" aria-hidden /> Build &amp; Verify
                          </>
                        )}
                      </button>
                    )}
                    {target.hasBuildScript && target.demoUrl && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isBuilding}
                        onClick={() => void handleBuildAndPlay(target, false)}
                      >
                        {isBuilding ? (
                          'Building…'
                        ) : (
                          <>
                            <Hammer className="icon" aria-hidden /> Rebuild
                          </>
                        )}
                      </button>
                    )}
                    {target.kind === 'worktree' && target.exists && target.branch && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isSyncing}
                        onClick={() => void handleSyncToMain(target.id)}
                        title="Copy/sync this worktree's files & compiled artifacts into the Main Project Workspace on host"
                      >
                        {isSyncing ? (
                          'Syncing…'
                        ) : (
                          <>
                            <ArrowLeftRight className="icon" aria-hidden /> Sync to Main
                          </>
                        )}
                      </button>
                    )}
                    {target.kind === 'worktree' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => navigate(`/runs/${target.id}/review`)}
                      >
                        Diff →
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 5: Git Checkpoints & 1-Click Rollback */}
      {activeTab === 'checkpoints' && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: '0.82rem' }}>
              <Clock className="icon" aria-hidden /> Workspace Git Checkpoints ({checkpoints.length})
            </strong>
          </div>
          {checkpoints.length === 0 ? (
            <p className="muted small">No commits recorded yet in main workspace.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
              {checkpoints.map((cp, index) => (
                <div
                  key={cp.sha}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    fontSize: '0.78rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span className="badge mono">{cp.shortSha}</span>
                    {index === 0 && <span className="badge badge-soft mono">HEAD</span>}
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cp.subject}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono muted small">
                      {new Date(cp.createdAt).toLocaleString()}
                    </span>
                    {index > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={rollingBackSha === cp.sha}
                        onClick={() => void handleRollbackCheckpoint(cp.sha)}
                      >
                        {rollingBackSha === cp.sha ? (
                          'Rolling back…'
                        ) : (
                          <>
                            <RotateCcwClock className="icon" aria-hidden /> Rollback here
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

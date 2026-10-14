import type {
  BuildDemoResponse,
  FactoryRequestResponse,
  Project,
  ProjectCheckpoint,
  ProjectStatusSummary,
  SyncWorktreeResponse,
  Ticket,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { usePoll } from '../hooks/usePoll';
import { LiveBrowserStudio } from './LiveBrowserStudio';
import { PersonaBadge } from './PersonaBadge';

const FACTORY_EXAMPLES = [
  'Add a live score counter and persistent high-score HUD overlay',
  'Modernize the visual design, color palette, and UI animations',
  'Add a game-over summary screen with a local leaderboard',
] as const;

interface DemoRuntimeError {
  message: string;
  stack?: string;
  timestamp: string;
}

export function ProjectStatusAndDemoPanel({ project }: { project: Project }) {
  const [, navigate] = useLocation();
  const statusPoll = usePoll(
    () => api<ProjectStatusSummary>(`/api/projects/${project.id}/status`),
    4_000,
  );
  const ticketsPoll = usePoll(
    () => api<Ticket[]>(`/api/projects/${project.id}/tickets`),
    5_000,
  );
  const checkpointsPoll = usePoll(
    () => api<ProjectCheckpoint[]>(`/api/projects/${project.id}/checkpoints`),
    10_000,
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string>('main');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [syncingRunId, setSyncingRunId] = useState<string>();
  const [buildingTargetId, setBuildingTargetId] = useState<string>();
  const [factoryPrompt, setFactoryPrompt] = useState('');
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [submittingFactory, setSubmittingFactory] = useState(false);
  const [startingPipeline, setStartingPipeline] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string }>();

  // Faz F9: Demo Runtime Error Catcher + Quick Tweak + Checkpoints
  const [demoErrors, setDemoErrors] = useState<DemoRuntimeError[]>([]);
  const [quickTweakPrompt, setQuickTweakPrompt] = useState('');
  const [submittingTweak, setSubmittingTweak] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [rollingBackSha, setRollingBackSha] = useState<string>();

  // Faz F11: Live Browser / Shared Chromium CDP Studio
  const [viewportOpen, setViewportOpen] = useState(false);

  // Listen for runtime errors forwarded by the injected errorBridgeScript inside the Demo iframe
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
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

  const handleSubmitFactoryRequest = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = factoryPrompt.trim();
    if (!trimmed) return;
    setSubmittingFactory(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: trimmed,
          leadPersona: 'product_owner',
          permissionMode: 'acceptEdits',
          autoDispatch,
        },
      );
      setFactoryPrompt('');
      await statusPoll.refresh();
      await ticketsPoll.refresh();
      setBanner({
        kind: 'ok',
        text: `Factory request dispatched to Product Owner (${res.ticket.key}). PO will refine the spec, create specialist tickets (Coder, UI/UX, QA), and ${autoDispatch ? 'auto-dispatch them sequentially' : 'place them in Ready'}.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setSubmittingFactory(false);
    }
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
          permissionMode: 'acceptEdits',
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
          permissionMode: 'acceptEdits',
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
        text: 'Sequential multi-persona pipeline activated for Ready/Backlog tickets.',
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
      setSelectedTargetId('main');
      setBanner({ kind: 'ok', text: res.summary });
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
      await statusPoll.refresh();
      if (res.ok && res.demoUrl) {
        setSelectedTargetId(target.id);
        setIframeNonce((n) => n + 1);
        setDemoErrors([]);
        if (autoOpen) setPreviewOpen(true);
        setBanner({
          kind: 'ok',
          text: `Demo built (${res.demoEntryRelPath}) for ${target.label}.`,
        });
      } else {
        setBanner({
          kind: 'err',
          text: `Build finished without a detected HTML entrypoint: ${res.output.slice(-240)}`,
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
      setPreviewOpen(true);
      setIframeNonce((n) => n + 1);
      return;
    }
    if (target.hasBuildScript) {
      await handleBuildAndPlay(target, true);
    }
  };

  const { ticketCounts } = summary;
  const pipelineTickets = (ticketsPoll.data ?? []).slice(0, 10);
  const checkpoints = checkpointsPoll.data ?? [];

  return (
    <section className="panel" aria-label="Project status and live demo">
      {/* Top Header: Project Status & Quick Demo Launch */}
      <div className="panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            className="pill pill-live"
            style={{
              borderColor: 'color-mix(in hsl, var(--ok) 45%, var(--border))',
              background: 'color-mix(in hsl, var(--ok) 12%, var(--surface))',
              color: 'var(--ok)',
              fontWeight: 600,
            }}
          >
            <span className="dot" />
            Project Status &amp; Live Demo
          </span>
          {summary.autoChainActive && (
            <span className="badge badge-soft mono">⟳ Multi-Persona Auto-Pipeline Active</span>
          )}
          <span
            className="badge mono"
            title="Host bind-mount directory mapped to container /workspaces"
          >
            Host Mount: {summary.hostBindHint} ↔ {summary.workspaceRoot}
          </span>
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
              title="Sequentially run Ready/Backlog tickets across their assigned personas and sync each to Main"
            >
              {startingPipeline
                ? 'Starting…'
                : `⚡ Run Pipeline (${ticketCounts.ready || ticketCounts.backlog})`}
            </button>
          )}
          {bestPlayableTarget && (bestPlayableTarget.demoUrl || bestPlayableTarget.hasBuildScript) && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={buildingTargetId === bestPlayableTarget.id}
              onClick={() => void handleOpenDemo(bestPlayableTarget)}
            >
              {buildingTargetId === bestPlayableTarget.id
                ? 'Building Demo…'
                : previewOpen
                  ? '↻ Refresh Live Demo'
                  : `▶ Launch Live Demo (${bestPlayableTarget.ticketKey ?? (bestPlayableTarget.kind === 'main' ? 'Main' : 'Worktree')})`}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigate(`/projects/${project.id}/code`)}
            title="Open integrated Code Explorer & Monaco Editor"
          >
            ◫ Code Explorer
          </button>
          <button
            type="button"
            className={viewportOpen ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setViewportOpen((v) => !v)}
            title="Open shared Live Browser Studio (Playwright MCP + Chromium CDP stream)"
          >
            🌐 Live Browser
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setCheckpointsOpen((v) => !v)}
            title="View Git checkpoints & roll back with 1 click"
          >
            🕓 Checkpoints ({checkpoints.length})
          </button>
          <a
            href={`/api/projects/${project.id}/export.tar.gz`}
            className="btn btn-sm"
            title="Download project workspace as .tar.gz archive"
          >
            📦 .tar.gz
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

          {/* Live Factory Pipeline Stepper */}
          {pipelineTickets.length > 0 && (
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
              {pipelineTickets.map((t, idx) => {
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

      {/* Autonomous AI Factory Request Bar (PO -> Coder / UI-UX / QA Delegation) */}
      <form
        onSubmit={(e) => void handleSubmitFactoryRequest(e)}
        style={{
          padding: '12px 14px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-2)',
          border: '1px solid color-mix(in hsl, var(--ember-1) 35%, var(--border))',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
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
              ⚡ Ask AI Factory (PO Orchestrator → Specialist Personas)
            </strong>
            <PersonaBadge persona="product_owner" />
            <span className="muted small">→ spawns &amp; delegates tickets to</span>
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
            Auto-dispatch &amp; sync specialist tickets sequentially
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="input"
            value={factoryPrompt}
            onChange={(e) => setFactoryPrompt(e.target.value)}
            placeholder='Describe a feature or change (e.g. "Add a score counter and high-score HUD" or "Redesign the main screen") — PO will refine & delegate to specialists…'
            style={{
              width: 'auto',
              flex: '1 1 360px',
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submittingFactory || !factoryPrompt.trim()}
          >
            {submittingFactory ? 'Delegating…' : '🚀 Delegate to AI Factory'}
          </button>
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
          {FACTORY_EXAMPLES.map((ex) => (
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
          >
            ✕
          </button>
        </div>
      )}

      {/* Checkpoints & 1-Click Rollback Drawer (Faz F9) */}
      {checkpointsOpen && (
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
              🕓 Workspace Git Checkpoints ({checkpoints.length})
            </strong>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setCheckpointsOpen(false)}
            >
              ✕ Close
            </button>
          </div>
          {checkpoints.length === 0 ? (
            <p className="muted small">No commits recorded yet in main workspace.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 190, overflowY: 'auto' }}>
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
                    {index === 0 && (
                      <span className="badge badge-soft mono">HEAD</span>
                    )}
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
                        {rollingBackSha === cp.sha ? 'Rolling back…' : '⏪ Rollback here'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Live Browser Studio Drawer (Faz F11) */}
      {viewportOpen && (
        <LiveBrowserStudio
          project={project}
          targetId={activeTarget.id}
          onClose={() => setViewportOpen(false)}
        />
      )}

      {/* Embedded Live Demo & Preview Player */}
      {previewOpen && activeTarget.demoUrl && (
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
                style={{ width: 'auto', fontSize: '0.78rem', padding: '4px 8px' }}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} {t.demoEntryRelPath ? `(${t.demoEntryRelPath})` : '(no bundle)'}
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
                ↻ Reload
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setFullscreen((f) => !f)}
              >
                {fullscreen ? '🗗 Exit Fullscreen' : '⛶ Fullscreen'}
              </button>
              <a
                href={activeTarget.demoUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
              >
                ↗ New Tab
              </a>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setFullscreen(false);
                  setPreviewOpen(false);
                }}
              >
                ✕ Close
              </button>
            </div>
          </div>

          {/* Live Demo Runtime Error Catcher Banner (Faz F9) */}
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
                  🐛 Runtime Error Detected in Live Demo ({demoErrors[0]!.timestamp}):
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
                  🔧 Fix Error with Coder Agent
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

          {/* Quick Demo Tweak Bar (Faz F9) */}
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
            <span className="mono muted small">💬 Quick Demo Tweak:</span>
            <input
              type="text"
              className="input"
              value={quickTweakPrompt}
              onChange={(e) => setQuickTweakPrompt(e.target.value)}
              placeholder='Type an instant change while playing (e.g. "Make jump physics gentler" or "Add sound effect on score")…'
              style={{ width: 'auto', flex: 1, fontSize: '0.78rem', padding: '4px 8px' }}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={submittingTweak || !quickTweakPrompt.trim()}
            >
              {submittingTweak ? 'Sending…' : '✨ Apply Tweak'}
            </button>
          </form>

          <iframe
            key={`${activeTarget.id}-${iframeNonce}`}
            src={`${activeTarget.demoUrl}?v=${iframeNonce}`}
            title={`Live Demo - ${activeTarget.label}`}
            style={{
              width: '100%',
              height: fullscreen ? '100%' : 520,
              flex: fullscreen ? 1 : undefined,
              border: 'none',
              background: '#fff',
            }}
          />
        </div>
      )}

      {/* Workspace & Agent Worktrees Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 10,
        }}
      >
        {targets.map((target) => {
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
                border: isSelected
                  ? '1px solid var(--ember-1)'
                  : '1px solid var(--border)',
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

                {target.demoEntryRelPath ? (
                  <div
                    className="small"
                    style={{
                      color: 'var(--ok)',
                      marginBottom: 6,
                    }}
                  >
                    ● Playable bundle: <span className="mono">{target.demoEntryRelPath}</span>
                  </div>
                ) : target.hasBuildScript ? (
                  <div className="small" style={{ color: 'var(--warn)', marginBottom: 6 }}>
                    ◐ Build script ready (<span className="mono">npm run build</span>)
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
                    {isBuilding
                      ? 'Building…'
                      : target.demoUrl
                        ? '▶ Play Demo'
                        : '🔨 Build & Play'}
                  </button>
                )}
                {target.hasBuildScript && target.demoUrl && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isBuilding}
                    onClick={() => void handleBuildAndPlay(target, false)}
                  >
                    {isBuilding ? 'Building…' : '🔨 Rebuild'}
                  </button>
                )}
                {target.kind === 'worktree' && target.fileCount > 2 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isSyncing}
                    onClick={() => void handleSyncToMain(target.id)}
                    title="Copy/sync this worktree's files & compiled bundle into the Main Project Workspace on host"
                  >
                    {isSyncing ? 'Syncing…' : '⇄ Sync to Main'}
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
    </section>
  );
}

import type {
  BuildDemoResponse,
  FactoryRequestResponse,
  Project,
  ProjectStatusSummary,
  SyncWorktreeResponse,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { usePoll } from '../hooks/usePoll';
import { PersonaBadge } from './PersonaBadge';

const FACTORY_EXAMPLES = [
  'Oyuna score counter ve en yüksek skor (high score) göstergesi ekle',
  'Oyundaki görsel tasarımı, renk paletini ve HUD arayüzünü modernleştir',
  'Oyun bittiğinde skor kaydetme ekranı ve liderlik tablosu (leaderboard) ekle',
] as const;

export function ProjectStatusAndDemoPanel({ project }: { project: Project }) {
  const [, navigate] = useLocation();
  const statusPoll = usePoll(
    () => api<ProjectStatusSummary>(`/api/projects/${project.id}/status`),
    4_000,
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

  const summary = statusPoll.data;
  if (!summary) return null;

  const targets = summary.targets;
  const activeTarget: WorkspaceDemoTarget =
    targets.find((t) => t.id === selectedTargetId) ??
    targets.find((t) => Boolean(t.demoUrl)) ??
    targets[0]!;

  const playableTargets = targets.filter((t) => Boolean(t.demoUrl));
  const bestPlayableTarget = playableTargets[0] ?? targets.find((t) => t.hasBuildScript) ?? targets[0];

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

  const handleRunPipeline = async () => {
    setStartingPipeline(true);
    setBanner(undefined);
    try {
      await api(`/api/projects/${project.id}/run-pipeline`, 'POST', {});
      await statusPoll.refresh();
      setBanner({
        kind: 'ok',
        text: 'Sequential multi-persona pipeline activated for Ready tickets.',
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

  return (
    <section
      style={{
        marginBottom: 20,
        padding: '16px 18px',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
      }}
    >
      {/* Top Header: Project Status & Quick Demo Launch */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 9px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              background: 'rgba(16, 185, 129, 0.14)',
              color: '#34d399',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            ◈ Project Status & Live Demo
          </span>
          {summary.autoChainActive && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                background: 'rgba(59, 130, 246, 0.16)',
                color: '#60a5fa',
                border: '1px solid rgba(59, 130, 246, 0.35)',
              }}
            >
              ⟳ Multi-Persona Auto-Pipeline Active
            </span>
          )}
          <span
            className="mono"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
            title="Host bind-mount directory mapped to container /workspaces"
          >
            Host Mount: {summary.hostBindHint} ↔ {summary.workspaceRoot}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {summary.completionPercent}% complete · {ticketCounts.done}/{ticketCounts.total} tickets done
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {ticketCounts.ready > 0 && (
            <button
              type="button"
              className="ghost"
              style={{
                fontSize: 12,
                padding: '5px 10px',
                borderColor: 'rgba(59, 130, 246, 0.4)',
                color: '#60a5fa',
              }}
              disabled={startingPipeline}
              onClick={() => void handleRunPipeline()}
              title="Sequentially run all Ready tickets across their assigned personas and sync each to Main"
            >
              {startingPipeline ? 'Starting…' : `⚡ Run Ready Pipeline (${ticketCounts.ready})`}
            </button>
          )}
          {bestPlayableTarget && (bestPlayableTarget.demoUrl || bestPlayableTarget.hasBuildScript) && (
            <button
              type="button"
              className="primary"
              style={{ fontSize: 12, padding: '6px 12px' }}
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
          {activeTarget.demoUrl && (
            <a
              href={activeTarget.demoUrl}
              target="_blank"
              rel="noreferrer"
              className="btn"
              style={{
                fontSize: 12,
                padding: '5px 10px',
                textDecoration: 'none',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
              }}
            >
              ↗ Open Demo in New Tab
            </a>
          )}
          <button
            type="button"
            className="ghost"
            style={{ fontSize: 12, padding: '5px 10px' }}
            onClick={() => navigate(`/projects/${project.id}/board`)}
          >
            Kanban Board →
          </button>
        </div>
      </div>

      {/* Progress Bar & Ticket Pipeline Pills */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            height: 6,
            borderRadius: 999,
            background: 'var(--bg-elevated)',
            overflow: 'hidden',
            marginBottom: 8,
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div
            style={{
              width: `${summary.completionPercent}%`,
              height: '100%',
              background: 'linear-gradient(90deg, var(--accent), #10b981)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
          <span className="badge">Backlog: {ticketCounts.backlog}</span>
          <span className="badge">Ready: {ticketCounts.ready}</span>
          <span
            className="badge"
            style={
              ticketCounts.in_progress > 0
                ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                : undefined
            }
          >
            In Progress: {ticketCounts.in_progress}
          </span>
          <span
            className="badge"
            style={
              ticketCounts.review > 0
                ? { borderColor: '#f59e0b', color: '#fbbf24' }
                : undefined
            }
          >
            In Review: {ticketCounts.review}
          </span>
          <span
            className="badge"
            style={
              ticketCounts.done > 0
                ? { borderColor: '#10b981', color: '#34d399' }
                : undefined
            }
          >
            Done: {ticketCounts.done}
          </span>
        </div>
      </div>

      {/* Autonomous AI Factory Request Bar (PO -> Coder / UI-UX / QA Delegation) */}
      <form
        onSubmit={(e) => void handleSubmitFactoryRequest(e)}
        style={{
          marginBottom: 14,
          padding: '12px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-elevated)',
          border: '1px solid rgba(245, 158, 11, 0.28)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24' }}>
              ⚡ Ask AI Factory (PO Orchestrator → Specialist Personas)
            </span>
            <PersonaBadge persona="product_owner" />
            <span className="muted" style={{ fontSize: 11 }}>
              → spawns &amp; delegates tickets to
            </span>
            <PersonaBadge persona="coder" />
            <PersonaBadge persona="ui_ux" />
            <PersonaBadge persona="qa" />
          </div>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              cursor: 'pointer',
              color: 'var(--text-secondary)',
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
            value={factoryPrompt}
            onChange={(e) => setFactoryPrompt(e.target.value)}
            placeholder='Describe what you want (e.g. "Oyuna score counter ekle" or "Oyundaki tasarımı değiştir") — PO will refine & delegate to UI/UX, Backend & QA…'
            style={{
              flex: '1 1 360px',
              fontSize: 12.5,
              padding: '8px 11px',
            }}
          />
          <button
            type="submit"
            className="primary"
            disabled={submittingFactory || !factoryPrompt.trim()}
            style={{ fontSize: 12, padding: '8px 14px', whiteSpace: 'nowrap' }}
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
            marginTop: 8,
          }}
        >
          <span className="muted" style={{ fontSize: 10.5 }}>
            Quick examples:
          </span>
          {FACTORY_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="ghost"
              style={{ fontSize: 10.5, padding: '2px 7px' }}
              onClick={() => setFactoryPrompt(ex)}
            >
              + {ex}
            </button>
          ))}
        </div>
      </form>

      {banner && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            background:
              banner.kind === 'ok' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${banner.kind === 'ok' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
            color: banner.kind === 'ok' ? '#34d399' : '#f87171',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            className="ghost"
            style={{ fontSize: 11, padding: '2px 6px' }}
            onClick={() => setBanner(undefined)}
          >
            ✕
          </button>
        </div>
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
                  background: '#090b10',
                  border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius-lg)',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.75)',
                }
              : {
                  marginBottom: 16,
                  border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  background: '#090b10',
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
              borderBottom: '1px solid var(--border-subtle)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#34d399' }}>
                ● Live Interactive Preview
              </span>
              <select
                value={activeTarget.id}
                onChange={(e) => {
                  setSelectedTargetId(e.target.value);
                  setIframeNonce((n) => n + 1);
                }}
                style={{ fontSize: 12, padding: '3px 8px' }}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} {t.demoEntryRelPath ? `(${t.demoEntryRelPath})` : '(no bundle)'}
                  </option>
                ))}
              </select>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {activeTarget.demoEntryRelPath}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className="ghost"
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setIframeNonce((n) => n + 1)}
              >
                ↻ Reload
              </button>
              <button
                type="button"
                className="ghost"
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setFullscreen((f) => !f)}
              >
                {fullscreen ? '🗗 Exit Fullscreen' : '⛶ Fullscreen'}
              </button>
              <a
                href={activeTarget.demoUrl}
                target="_blank"
                rel="noreferrer"
                className="ghost"
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  textDecoration: 'none',
                  color: 'var(--text-primary)',
                }}
              >
                ↗ New Tab
              </a>
              <button
                type="button"
                className="ghost"
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => {
                  setFullscreen(false);
                  setPreviewOpen(false);
                }}
              >
                ✕ Close
              </button>
            </div>
          </div>
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
                padding: '11px 13px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                border: isSelected
                  ? '1px solid var(--accent)'
                  : '1px solid var(--border-subtle)',
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
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        padding: '1px 6px',
                        borderRadius: 4,
                        background:
                          target.kind === 'main'
                            ? 'rgba(59, 130, 246, 0.16)'
                            : 'rgba(168, 85, 247, 0.16)',
                        color: target.kind === 'main' ? '#60a5fa' : '#c084fc',
                      }}
                    >
                      {target.kind === 'main' ? 'MAIN' : target.ticketKey ?? 'WORKTREE'}
                    </span>
                    {target.persona && <PersonaBadge persona={target.persona} />}
                  </div>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {target.fileCount} files
                  </span>
                </div>

                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 12.5,
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
                  className="mono muted"
                  style={{
                    fontSize: 10.5,
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
                    style={{
                      fontSize: 11,
                      color: '#34d399',
                      marginBottom: 6,
                    }}
                  >
                    ● Playable bundle: <span className="mono">{target.demoEntryRelPath}</span>
                  </div>
                ) : target.hasBuildScript ? (
                  <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 6 }}>
                    ◐ Build script ready (<span className="mono">npm run build</span>)
                  </div>
                ) : null}

                {target.topFiles.length > 0 && (
                  <div
                    className="mono muted"
                    style={{
                      fontSize: 10.5,
                      lineHeight: 1.45,
                      padding: '5px 7px',
                      borderRadius: 4,
                      background: 'rgba(0,0,0,0.2)',
                      maxHeight: 54,
                      overflowY: 'auto',
                    }}
                  >
                    {target.topFiles.slice(0, 8).join(' · ')}
                    {target.topFiles.length > 8 ? ` +${target.topFiles.length - 8} more` : ''}
                  </div>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                  marginTop: 4,
                }}
              >
                {(target.demoUrl || target.hasBuildScript) && (
                  <button
                    type="button"
                    className="primary"
                    style={{ fontSize: 11, padding: '4px 9px' }}
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
                    className="ghost"
                    style={{ fontSize: 11, padding: '4px 8px' }}
                    disabled={isBuilding}
                    onClick={() => void handleBuildAndPlay(target, false)}
                  >
                    {isBuilding ? 'Building…' : '🔨 Rebuild'}
                  </button>
                )}
                {target.kind === 'worktree' && target.fileCount > 2 && (
                  <button
                    type="button"
                    className="ghost"
                    style={{
                      fontSize: 11,
                      padding: '4px 8px',
                      borderColor: 'rgba(59, 130, 246, 0.35)',
                      color: '#60a5fa',
                    }}
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
                    className="ghost"
                    style={{ fontSize: 11, padding: '4px 8px' }}
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

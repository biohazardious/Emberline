import type {
  BrowserActionBody,
  BrowserConsoleEntry,
  BrowserUrlResponse,
  BrowserViewportSnapshot,
  BuildDemoResponse,
  FactoryRequestResponse,
  Project,
  SystemStatus,
} from '@emberline/protocol';
import { type FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  Circle,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  RotateCw,
  Square,
  Target,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { type PreviewLike, choosePrimaryView, qaRequestPrompt, resolveRunnerBrowserUrl } from '../containerPreview';
import { useApi } from '../hooks/useApi';
import { PersonaBadge } from './PersonaBadge';
import { previewApiPath } from './PreviewAndBuildView';

const QUICK_KEYS = [
  { label: 'Space', key: 'Space' },
  { label: 'Enter ↵', key: 'Enter' },
  { label: 'Esc', key: 'Escape' },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '←', key: 'ArrowLeft' },
  { label: '→', key: 'ArrowRight' },
  { label: 'Tab', key: 'Tab' },
  { label: '⌫', key: 'Backspace' },
] as const;

export function LiveBrowserStudio({
  project,
  targetId = 'main',
  onClose,
}: {
  project: Project;
  targetId?: string;
  onClose?: () => void;
}) {
  const [, navigate] = useLocation();
  const [snap, setSnap] = useState<BrowserViewportSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [liveFollow, setLiveFollow] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [sideTab, setSideTab] = useState<'activity' | 'console'>('activity');
  const [urlInput, setUrlInput] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [typeInput, setTypeInput] = useState('');
  const [clickMarker, setClickMarker] = useState<{ xPct: number; yPct: number; id: number } | null>(
    null,
  );
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'info'; text: string }>();
  // Shared with the shell's poll: whether the Docker engine can run container previews.
  const systemPoll = useApi<SystemStatus>('/api/system', 5_000);
  const [launchingQa, setLaunchingQa] = useState(false);

  const inFlightRef = useRef(false);

  const fetchSnapshot = useCallback(
    async (silent = false) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (!silent) setLoading(true);
      try {
        const res = await api<BrowserViewportSnapshot>(
          `/api/projects/${project.id}/browser-viewport?targetId=${encodeURIComponent(targetId)}`,
        );
        setSnap(res);
        if (!editingUrl && res.targetUrl) {
          setUrlInput(res.targetUrl);
        }
      } catch (err) {
        if (!silent) setBanner({ kind: 'err', text: errorMessage(err) });
      } finally {
        inFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    },
    [project.id, targetId, editingUrl],
  );

  useEffect(() => {
    void fetchSnapshot(false);
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!liveFollow) return;
    const intervalMs = snap?.agentActive || snap?.playtestActive ? 750 : 1_400;
    const timer = setInterval(() => {
      void fetchSnapshot(true);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [liveFollow, snap?.agentActive, snap?.playtestActive, fetchSnapshot]);

  const sendAction = async (body: BrowserActionBody) => {
    setActing(true);
    try {
      const res = await api<BrowserViewportSnapshot>(
        `/api/projects/${project.id}/browser-action`,
        'POST',
        { ...body, targetId },
      );
      setSnap(res);
      if (res.targetUrl) setUrlInput(res.targetUrl);
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setActing(false);
    }
  };

  const handleNavigateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setEditingUrl(false);
    await sendAction({ action: 'navigate', url: trimmed });
  };

  /**
   * The target's URL as the runner's browser reaches it (`browser-url`). A target with a container
   * preview gets it started first, and this waits until it answers; otherwise the static demo is
   * built first. Null, with the reason in the banner, when there is nothing to open.
   */
  const targetBrowserUrl = async (): Promise<string | null> => {
    const path = previewApiPath(project.id, { id: targetId, kind: targetId === 'main' ? 'main' : 'worktree' });
    const first = await api<PreviewLike>(path).catch(() => undefined);
    const container =
      choosePrimaryView(
        { kind: targetId === 'main' ? 'main' : 'worktree', exists: true },
        first,
        systemPoll.data?.docker.available ?? false,
      ) === 'container';
    if (container && first?.status !== 'running') {
      setBanner({ kind: 'info', text: 'Starting the container preview; the browser opens it once it answers…' });
    }
    const res = await resolveRunnerBrowserUrl({
      container,
      status: () => api<PreviewLike>(path),
      start: () => api<PreviewLike>(`${path}/start`, 'POST', {}),
      buildStatic: async () => {
        await api<BuildDemoResponse>(`/api/projects/${project.id}/build-demo`, 'POST', { targetId });
      },
      browserUrl: () =>
        api<BrowserUrlResponse>(`/api/projects/${project.id}/browser-url?target=${encodeURIComponent(targetId)}`),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      describeError: errorMessage,
    });
    setBanner(res.message ? { kind: res.problem ? 'err' : 'info', text: res.message } : undefined);
    return res.url;
  };

  const handleOpenProjectDemo = async () => {
    setActing(true);
    setBanner(undefined);
    try {
      const url = await targetBrowserUrl();
      if (!url) return;
      setEditingUrl(false);
      setUrlInput(url);
      await sendAction({ action: 'navigate', url });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setActing(false);
    }
  };

  const handleTogglePlaytest = async () => {
    setBanner(undefined);
    const isRunning = Boolean(snap?.playtestActive);
    if (isRunning) {
      await sendAction({ action: 'stop_playtest' });
      return;
    }
    setLiveFollow(true);
    setSideTab('activity');
    setActing(true);
    let url: string | null;
    try {
      url = await targetBrowserUrl();
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
      return;
    } finally {
      setActing(false);
    }
    if (!url) return;
    await sendAction({ action: 'start_playtest', url });
    setBanner({
      kind: 'ok',
      text: 'Browser Auto-Interact started! Watch the viewport and Agent Activity stream in real time.',
    });
  };

  const handleCanvasClick = async (e: MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const x = Math.round(relX * 1280);
    const y = Math.round(relY * 720);
    setClickMarker({ xPct: relX * 100, yPct: relY * 100, id: Date.now() });
    await sendAction({ action: 'click', x, y, button: 'left' });
  };

  const handleTypeSubmit = async (e: FormEvent, submitKey = false) => {
    e.preventDefault();
    if (!typeInput) return;
    const text = typeInput;
    setTypeInput('');
    await sendAction({ action: 'type', text, submit: submitKey });
  };

  const handleRunQaBrowserCheck = async () => {
    setLaunchingQa(true);
    setBanner(undefined);
    try {
      // Show the person the target meanwhile; the QA run opens its own work with the `preview` tool.
      const url = await targetBrowserUrl().catch(() => null);
      if (url) await sendAction({ action: 'navigate', url }).catch(() => null);
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: qaRequestPrompt(),
          leadPersona: 'qa',
          permissionMode: 'auto',
          autoDispatch: true,
        },
      );
      setLiveFollow(true);
      setSideTab('activity');
      setBanner({
        kind: 'ok',
        text: `QA Agent (${res.ticket.key}) dispatched to inspect and verify the application in this Live Browser! Watch the viewport and Agent Activity feed.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setLaunchingQa(false);
    }
  };

  const handleFixConsoleError = async (entry: BrowserConsoleEntry) => {
    setLaunchingQa(true);
    setBanner(undefined);
    try {
      const res = await api<FactoryRequestResponse>(
        `/api/projects/${project.id}/factory-request`,
        'POST',
        {
          prompt: `[Live Browser Console Error Fix] The shared Live Browser reported the following error on ${snap?.targetUrl ?? 'the active page'}:\n\n\`\`\`\n${entry.text}\n\`\`\`\n\nPlease diagnose and fix the root cause in the codebase and run \`npm run build\`.`,
          leadPersona: 'coder',
          permissionMode: 'auto',
          autoDispatch: true,
        },
      );
      setBanner({
        kind: 'ok',
        text: `Console error sent to Coder Agent (${res.ticket.key}) for self-healing.`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setLaunchingQa(false);
    }
  };

  const tabs = snap?.tabs ?? [];
  const consoleLogs = snap?.consoleLogs ?? [];
  const agentActions = snap?.agentActions ?? [];
  const errorCount = consoleLogs.filter((c) => c.level === 'error').length;

  return (
    <div
      style={
        fullscreen
          ? {
              position: 'fixed',
              inset: 14,
              zIndex: 1100,
              background: 'var(--bg)',
              border: '1px solid var(--ember-1)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8)',
              overflow: 'hidden',
            }
          : {
              border: '1px solid color-mix(in hsl, var(--ember-1) 45%, var(--border))',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }
      }
    >
      {/* Top Status & Action Header */}
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
          <span
            className="pill pill-live"
            style={
              snap?.agentActive
                ? {
                    borderColor: 'var(--ember-1)',
                    background: 'color-mix(in hsl, var(--ember-1) 18%, var(--surface))',
                    color: 'var(--ember-2)',
                    fontWeight: 600,
                  }
                : {
                    borderColor: 'color-mix(in hsl, var(--ok) 45%, var(--border))',
                    background: 'color-mix(in hsl, var(--ok) 12%, var(--surface))',
                    color: 'var(--ok)',
                    fontWeight: 600,
                  }
            }
          >
            <span className="dot" />
            {snap?.agentActive ? (
              <>
                <Zap className="icon" aria-hidden /> Agent Driving Browser
              </>
            ) : snap?.available ? (
              '● Live Browser (Shared CDP · 1280×720)'
            ) : (
              '○ Starting Live Browser…'
            )}
          </span>

          {snap?.pageTitle && (
            <span
              className="small"
              style={{
                fontWeight: 600,
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={snap.pageTitle}
            >
              {snap.pageTitle}
            </span>
          )}
        </div>

        <div className="actions">
          <button
            type="button"
            className={liveFollow ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setLiveFollow((v) => !v)}
            title="Continuously stream the shared Chromium viewport so you can watch agent actions in real time"
          >
            {liveFollow ? (
              <>
                <Circle
                  className="icon"
                  fill="currentColor"
                  style={{ color: 'var(--danger)' }}
                  aria-hidden
                />{' '}
                Live Follow: ON
              </>
            ) : (
              <>
                <Pause className="icon" aria-hidden /> Live Follow: Paused
              </>
            )}
          </button>
          <button
            type="button"
            className={snap?.playtestActive ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary'}
            disabled={acting}
            onClick={() => void handleTogglePlaytest()}
            title="Autonomously interact with the active page inside the shared browser"
          >
            {snap?.playtestActive ? (
              <>
                <Square className="icon" aria-hidden /> Stop Auto-Interact
              </>
            ) : (
              <>
                <Bot className="icon" aria-hidden /> Auto-Interact
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={acting}
            onClick={() => void handleOpenProjectDemo()}
            title="Open this target in the shared browser: its container preview when it has one (started if needed), else its static build"
          >
            <Target className="icon" aria-hidden /> Open Project Demo
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={launchingQa}
            onClick={() => void handleRunQaBrowserCheck()}
            title="Dispatch the QA Agent to open and interact with the app in this Live Browser while you watch"
          >
            {launchingQa ? (
              'Dispatching…'
            ) : (
              <>
                <Bot className="icon" aria-hidden /> Run QA Browser Check
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || acting}
            onClick={() => void fetchSnapshot(false)}
          >
            <Camera className="icon" aria-hidden /> Snapshot
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
          {onClose && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setFullscreen(false);
                onClose();
              }}
            >
              <X className="icon" aria-hidden /> Close
            </button>
          )}
        </div>
      </div>

      {/* Browser Tabs Bar */}
      {tabs.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            background: 'var(--bg)',
            borderBottom: '1px solid var(--border)',
            overflowX: 'auto',
          }}
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
                background: tab.active ? 'var(--surface-2)' : 'transparent',
                border: tab.active ? '1px solid var(--ember-1)' : '1px solid var(--border)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                maxWidth: 220,
                flexShrink: 0,
              }}
              onClick={() => void sendAction({ action: 'select_tab', tabId: tab.id })}
              title={tab.url}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: tab.active ? 600 : 400,
                }}
              >
                {tab.title || tab.url || 'New Tab'}
              </span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void sendAction({ action: 'close_tab', tabId: tab.id });
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '0.72rem',
                  }}
                  title="Close tab"
                  aria-label="Close tab"
                >
                  <X className="icon" aria-hidden />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void sendAction({ action: 'new_tab', url: 'about:blank' })}
            style={{ padding: '2px 8px', fontSize: '0.75rem' }}
            title="Open new browser tab"
          >
            + Tab
          </button>
        </div>
      )}

      {/* Browser Address Bar & Navigation Controls */}
      <form
        onSubmit={(e) => void handleNavigateSubmit(e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          disabled={acting}
          onClick={() => void sendAction({ action: 'back' })}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft className="icon" aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={acting}
          onClick={() => void sendAction({ action: 'forward' })}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight className="icon" aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={acting}
          onClick={() => void sendAction({ action: 'reload' })}
          title="Reload current tab"
          aria-label="Reload current tab"
        >
          <RotateCw className="icon" aria-hidden />
        </button>
        <input
          type="text"
          className="input mono"
          value={urlInput}
          onFocus={() => setEditingUrl(true)}
          onBlur={() => setEditingUrl(false)}
          onChange={(e) => setUrlInput(e.target.value)}
          aria-label="Address as the runner's browser sees it"
          placeholder="Address as the runner sees it, e.g. http://localhost:5173"
          style={{
            flex: 1,
            width: 'auto',
            fontSize: '0.78rem',
            padding: '5px 10px',
          }}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={acting}>
          Go →
        </button>
      </form>

      {banner && (
        <div
          className={`banner browser-target-notice ${banner.kind === 'ok' ? 'banner-ok' : banner.kind === 'info' ? 'banner-info' : 'banner-error'}`}
          role={banner.kind === 'err' ? 'alert' : 'status'}
          style={{
            borderRadius: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
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

      {/* Main Split: Interactive Viewport Canvas (Left) + Agent Activity & Console (Right) */}
      <div
        className="browser-studio-grid"
        style={{
          display: 'grid',
          flex: fullscreen ? 1 : undefined,
          minHeight: fullscreen ? 0 : 480,
        }}
      >
        {/* Left Column: Interactive Viewport + Keyboard Bar */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: '#050608',
            borderRight: '1px solid var(--border)',
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 10,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {snap?.imageDataUrl ? (
              <div
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  maxWidth: '100%',
                  maxHeight: fullscreen ? 'calc(100vh - 210px)' : 480,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
                }}
              >
                <img
                  src={snap.imageDataUrl}
                  alt="Shared Live Browser Viewport"
                  onClick={(e) => void handleCanvasClick(e)}
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    maxHeight: fullscreen ? 'calc(100vh - 210px)' : 480,
                    cursor: 'crosshair',
                    userSelect: 'none',
                  }}
                  title="Click anywhere on the viewport to send a real mouse click at (x, y) inside Chromium"
                />
                {clickMarker && (
                  <span
                    key={clickMarker.id}
                    style={{
                      position: 'absolute',
                      left: `${clickMarker.xPct}%`,
                      top: `${clickMarker.yPct}%`,
                      width: 22,
                      height: 22,
                      marginLeft: -11,
                      marginTop: -11,
                      borderRadius: '50%',
                      border: '2px solid var(--ember-2)',
                      background: 'color-mix(in srgb, var(--ember-1) 25%, transparent)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="muted small" style={{ padding: 24, textAlign: 'center' }}>
                {loading
                  ? 'Connecting to shared Chromium CDP instance inside runner…'
                  : snap?.message ?? 'No browser frame available yet.'}
              </div>
            )}
          </div>

          {/* Interactive Keyboard & Game Control Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '7px 10px',
              background: 'var(--bg-elevated)',
              borderTop: '1px solid var(--border)',
              flexWrap: 'wrap',
            }}
          >
            <form
              onSubmit={(e) => void handleTypeSubmit(e, true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 240px' }}
            >
              <input
                type="text"
                className="input"
                value={typeInput}
                onChange={(e) => setTypeInput(e.target.value)}
                placeholder="Type text into focused browser element…"
                style={{ width: 'auto', flex: 1, fontSize: '0.76rem', padding: '4px 8px' }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={acting || !typeInput}
                onClick={(e) => void handleTypeSubmit(e as unknown as FormEvent, false)}
              >
                Type
              </button>
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={acting || !typeInput}
              >
                Type + ↵
              </button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span className="mono muted" style={{ fontSize: '0.68rem', marginRight: 2 }}>
                Keys:
              </span>
              {QUICK_KEYS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  className="chip-btn mono"
                  disabled={acting}
                  onClick={() => void sendAction({ action: 'key', key: k.key })}
                  style={{ fontSize: '0.72rem', padding: '3px 7px' }}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Live Agent Browser Activity & Console Logs */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--surface)',
            minHeight: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
            }}
          >
            <button
              type="button"
              onClick={() => setSideTab('activity')}
              style={{
                flex: 1,
                padding: '8px 10px',
                border: 'none',
                borderBottom:
                  sideTab === 'activity' ? '2px solid var(--ember-1)' : '2px solid transparent',
                background: 'transparent',
                color: sideTab === 'activity' ? 'var(--text)' : 'var(--muted)',
                fontWeight: 600,
                fontSize: '0.76rem',
                cursor: 'pointer',
              }}
            >
              <Bot className="icon" aria-hidden /> Agent Actions ({agentActions.length})
            </button>
            <button
              type="button"
              onClick={() => setSideTab('console')}
              style={{
                flex: 1,
                padding: '8px 10px',
                border: 'none',
                borderBottom:
                  sideTab === 'console' ? '2px solid var(--ember-1)' : '2px solid transparent',
                background: 'transparent',
                color: sideTab === 'console' ? 'var(--text)' : 'var(--muted)',
                fontWeight: 600,
                fontSize: '0.76rem',
                cursor: 'pointer',
              }}
            >
              <Monitor className="icon" aria-hidden /> Console ({consoleLogs.length})
              {errorCount > 0 && (
                <span
                  className="badge"
                  style={{
                    marginLeft: 6,
                    borderColor: 'var(--danger)',
                    color: 'var(--danger)',
                    fontSize: '0.68rem',
                  }}
                >
                  {errorCount} err
                </span>
              )}
            </button>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: fullscreen ? 'calc(100vh - 170px)' : 460,
            }}
          >
            {sideTab === 'activity' ? (
              agentActions.length === 0 ? (
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  <p style={{ margin: '0 0 8px' }}>
                    No Playwright MCP browser tool calls recorded for this project yet.
                  </p>
                  <p style={{ margin: 0 }}>
                    Every agent run connects to this exact shared Chromium instance via{' '}
                    <span className="mono">--cdp-endpoint http://127.0.0.1:9222</span>. Click{' '}
                    <strong>
                      <Bot className="icon" aria-hidden /> Run QA Browser Check
                    </strong> above to watch an agent navigate and
                    test your app live!
                  </p>
                </div>
              ) : (
                agentActions.map((act) => (
                  <div
                    key={act.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      fontSize: '0.76rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <PersonaBadge persona={act.persona} />
                        <span className="mono" style={{ fontWeight: 600, color: 'var(--ember-2)' }}>
                          {act.toolName}
                        </span>
                      </div>
                      {act.runId !== 'live-browser' && act.runId !== 'playwright-script' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          style={{ padding: '1px 6px', fontSize: '0.68rem' }}
                          onClick={() => navigate(`/runs/${act.runId}`)}
                        >
                          Terminal →
                        </button>
                      )}
                    </div>
                    <div
                      className="mono muted"
                      style={{
                        fontSize: '0.72rem',
                        wordBreak: 'break-word',
                      }}
                    >
                      {act.summary}
                    </div>
                    <div className="mono muted" style={{ fontSize: '0.66rem' }}>
                      {new Date(act.timestamp).toLocaleTimeString()} ·{' '}
                      {act.runTitle ?? act.runId.slice(0, 8)}
                    </div>
                  </div>
                ))
              )
            ) : consoleLogs.length === 0 ? (
              <div className="muted small">
                No console output captured yet from the active browser tab.
              </div>
            ) : (
              consoleLogs.map((entry, idx) => {
                const isErr = entry.level === 'error';
                const isWarn = entry.level === 'warn';
                return (
                  <div
                    key={`${entry.timestamp}-${idx}`}
                    style={{
                      padding: '7px 9px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-2)',
                      border: isErr
                        ? '1px solid color-mix(in hsl, var(--danger) 55%, var(--border))'
                        : isWarn
                          ? '1px solid color-mix(in hsl, var(--warn) 55%, var(--border))'
                          : '1px solid var(--border)',
                      fontSize: '0.74rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontWeight: 600,
                          fontSize: '0.68rem',
                          color: isErr
                            ? 'var(--danger)'
                            : isWarn
                              ? 'var(--warn)'
                              : 'var(--muted)',
                        }}
                      >
                        [{entry.level.toUpperCase()}] {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      {isErr && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ padding: '1px 6px', fontSize: '0.68rem' }}
                          disabled={launchingQa}
                          onClick={() => void handleFixConsoleError(entry)}
                        >
                          <Wrench className="icon" aria-hidden /> Fix with Coder
                        </button>
                      )}
                    </div>
                    <div className="mono" style={{ wordBreak: 'break-word', fontSize: '0.72rem' }}>
                      {entry.text}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

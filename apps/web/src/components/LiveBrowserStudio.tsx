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
import { X } from 'lucide-react';
import { type FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import {
  type LiveBanner,
  type PreviewLike,
  bannerAfterSnapshot,
  choosePrimaryView,
  FOLLOW_AGENT,
  liveBrowserNote,
  offersFollow,
  playtestRefusalBanner,
  playtestStartBanner,
  qaRequestPrompt,
  resolveRunnerBrowserUrl,
} from '../containerPreview';
import { useApi } from '../hooks/useApi';
import { LiveBrowserSidePanel } from './liveBrowser/LiveBrowserSidePanel';
import { type BrowserDeviceSize, LiveBrowserToolbar } from './liveBrowser/LiveBrowserToolbar';
import { LiveBrowserViewport } from './liveBrowser/LiveBrowserViewport';
import { previewApiPath } from './PreviewAndBuildView';
import './liveBrowser/live-browser.css';

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
  const [deviceSize, setDeviceSize] = useState<BrowserDeviceSize>('desktop');
  const [panelOpen, setPanelOpen] = useState(false);
  const [sideTab, setSideTab] = useState<'activity' | 'console'>('activity');
  const [urlInput, setUrlInput] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [typeInput, setTypeInput] = useState('');
  const [clickMarker, setClickMarker] = useState<{ xPct: number; yPct: number; id: number } | null>(null);
  const [banner, setBanner] = useState<LiveBanner>();
  const systemPoll = useApi<SystemStatus>('/api/system', 5_000);
  const [launchingQa, setLaunchingQa] = useState(false);

  const inFlightRef = useRef(false);
  const prevErrorCountRef = useRef(0);

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
        setBanner((b) => bannerAfterSnapshot(b, res));
        if (!editingUrl && res.targetUrl) {
          setUrlInput(res.targetUrl);
        }
        const nextErrCount = (res.consoleLogs ?? []).filter((c) => c.level === 'error').length;
        if (nextErrCount > prevErrorCountRef.current) {
          setPanelOpen(true);
          setSideTab('console');
        }
        prevErrorCountRef.current = nextErrCount;
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

  const sendAction = async (body: BrowserActionBody): Promise<BrowserViewportSnapshot | null> => {
    setActing(true);
    try {
      const res = await api<BrowserViewportSnapshot>(`/api/projects/${project.id}/browser-action`, 'POST', {
        ...body,
        targetId,
      });
      setSnap(res);
      if (res.targetUrl) setUrlInput(res.targetUrl);
      const refusal = playtestRefusalBanner(res);
      if (refusal) setBanner(refusal);
      return res;
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
      return null;
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

  const targetBrowserUrl = async (): Promise<string | null> => {
    const path = previewApiPath(project.id, {
      id: targetId,
      kind: targetId === 'main' ? 'main' : 'worktree',
    });
    const first = await api<PreviewLike>(path).catch(() => undefined);
    const container =
      choosePrimaryView(
        { kind: targetId === 'main' ? 'main' : 'worktree', exists: true },
        first,
        systemPoll.data?.docker.available ?? false,
      ) === 'container';
    if (container && first?.status !== 'running') {
      setBanner({
        kind: 'info',
        text: 'Starting the container preview; the browser opens it once it answers…',
      });
    }
    const res = await resolveRunnerBrowserUrl({
      container,
      status: () => api<PreviewLike>(path),
      start: () => api<PreviewLike>(`${path}/start`, 'POST', {}),
      buildStatic: async () => {
        await api<BuildDemoResponse>(`/api/projects/${project.id}/build-demo`, 'POST', { targetId });
      },
      browserUrl: () =>
        api<BrowserUrlResponse>(
          `/api/projects/${project.id}/browser-url?target=${encodeURIComponent(targetId)}`,
        ),
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
    setPanelOpen(true);
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
    const res = await sendAction({ action: 'start_playtest', url });
    if (res) setBanner(playtestStartBanner(res));
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
      const url = await targetBrowserUrl().catch(() => null);
      if (url) await sendAction({ action: 'navigate', url }).catch(() => null);
      const res = await api<FactoryRequestResponse>(`/api/projects/${project.id}/factory-request`, 'POST', {
        prompt: qaRequestPrompt(),
        leadPersona: 'qa',
        permissionMode: 'auto',
        autoDispatch: true,
      });
      setLiveFollow(true);
      setSideTab('activity');
      setPanelOpen(true);
      setBanner({
        kind: 'ok',
        text:
          targetId === 'main'
            ? `QA Agent (${res.ticket.key}) dispatched to verify the application in this live browser.`
            : `QA Agent (${res.ticket.key}) dispatched. Its run previews its own fresh worktree from main.`,
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
      const res = await api<FactoryRequestResponse>(`/api/projects/${project.id}/factory-request`, 'POST', {
        prompt: `[Live Browser Console Error Fix] The shared Live Browser reported the following error on ${snap?.targetUrl ?? 'the active page'}:\n\n\`\`\`\n${entry.text}\n\`\`\`\n\nPlease diagnose and fix the root cause in the codebase and run \`npm run build\`.`,
        leadPersona: 'coder',
        permissionMode: 'auto',
        autoDispatch: true,
      });
      setBanner({
        kind: 'ok',
        text: `Console error sent to Coder Agent (${res.ticket.key}).`,
      });
    } catch (err) {
      setBanner({ kind: 'err', text: errorMessage(err) });
    } finally {
      setLaunchingQa(false);
    }
  };

  const consoleLogs = snap?.consoleLogs ?? [];
  const agentActions = snap?.agentActions ?? [];
  const errorCount = consoleLogs.filter((c) => c.level === 'error').length;

  const handleToggleSidePanel = (tab: 'activity' | 'console') => {
    if (panelOpen && sideTab === tab) {
      setPanelOpen(false);
    } else {
      setSideTab(tab);
      setPanelOpen(true);
    }
  };

  return (
    <div className={fullscreen ? 'live-browser-shell-fullscreen' : 'live-browser-shell'}>
      <LiveBrowserToolbar
        snap={snap}
        loading={loading}
        acting={acting}
        launchingQa={launchingQa}
        liveFollow={liveFollow}
        fullscreen={fullscreen}
        deviceSize={deviceSize}
        panelOpen={panelOpen}
        sideTab={sideTab}
        errorCount={errorCount}
        urlInput={urlInput}
        onUrlInputChange={setUrlInput}
        onEditingUrlChange={setEditingUrl}
        onNavigateSubmit={(e) => void handleNavigateSubmit(e)}
        onBack={() => void sendAction({ action: 'back' })}
        onForward={() => void sendAction({ action: 'forward' })}
        onReload={() => void sendAction({ action: 'reload' })}
        onSelectTab={(tabId) => void sendAction({ action: 'select_tab', tabId })}
        onCloseTab={(tabId) => void sendAction({ action: 'close_tab', tabId })}
        onNewTab={() => void sendAction({ action: 'new_tab', url: 'about:blank' })}
        onToggleLiveFollow={() => setLiveFollow((v) => !v)}
        onTogglePlaytest={() => void handleTogglePlaytest()}
        onOpenProjectDemo={() => void handleOpenProjectDemo()}
        onRunQaCheck={() => void handleRunQaBrowserCheck()}
        onRefreshSnapshot={() => void fetchSnapshot(false)}
        onChangeDeviceSize={setDeviceSize}
        onToggleSidePanel={handleToggleSidePanel}
        onToggleFullscreen={() => setFullscreen((f) => !f)}
        onClose={
          onClose
            ? () => {
                setFullscreen(false);
                onClose();
              }
            : undefined
        }
      />

      <FollowingNote
        snap={snap}
        acting={acting}
        onFollow={() => void sendAction({ action: 'follow_agent' })}
      />

      {banner && (
        <div
          className={`banner browser-target-notice ${banner.kind === 'ok' ? 'banner-ok' : banner.kind === 'info' ? 'banner-info' : 'banner-error'}`}
          role={banner.kind === 'err' ? 'alert' : 'status'}
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

      <div className={`browser-studio-grid${panelOpen ? ' browser-studio-grid-with-panel' : ''}`}>
        <LiveBrowserViewport
          snap={snap}
          loading={loading}
          acting={acting}
          deviceSize={deviceSize}
          clickMarker={clickMarker}
          typeInput={typeInput}
          onTypeInputChange={setTypeInput}
          onCanvasClick={(e) => void handleCanvasClick(e)}
          onTypeSubmit={(e, submitKey) => void handleTypeSubmit(e, submitKey)}
          onPressKey={(key) => void sendAction({ action: 'key', key })}
        />

        {panelOpen && (
          <LiveBrowserSidePanel
            sideTab={sideTab}
            onChangeSideTab={setSideTab}
            onClosePanel={() => setPanelOpen(false)}
            agentActions={agentActions}
            consoleLogs={consoleLogs}
            errorCount={errorCount}
            launchingQa={launchingQa}
            onOpenTerminal={(runId) => navigate(`/runs/${runId}`)}
            onFixConsoleError={(entry) => void handleFixConsoleError(entry)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The line above the viewport while an agent uses the browser. The live region holds the note only;
 * the "Follow it" button sits beside it, so a screen reader does not announce it with every poll.
 */
export function FollowingNote({
  snap,
  acting,
  onFollow,
}: {
  snap: Pick<BrowserViewportSnapshot, 'following' | 'canFollow'> | null;
  acting: boolean;
  onFollow: () => void;
}) {
  const note = liveBrowserNote(snap);
  if (!note) return null;
  return (
    <div className="browser-following-row">
      <p className="muted small browser-following-note" role="status">
        {note}
      </p>
      {offersFollow(snap) && (
        <button type="button" className="btn btn-sm" disabled={acting} onClick={onFollow}>
          {FOLLOW_AGENT}
        </button>
      )}
    </div>
  );
}

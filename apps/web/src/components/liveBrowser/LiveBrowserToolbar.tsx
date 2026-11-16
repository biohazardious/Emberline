import type { BrowserTabInfo, BrowserViewportSnapshot } from '@emberline/protocol';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  Download,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Play,
  RotateCw,
  Smartphone,
  Square,
  Tablet,
  Target,
  X,
  Zap,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';

export type BrowserDeviceSize = 'desktop' | 'tablet' | 'mobile';

export interface LiveBrowserToolbarProps {
  snap: BrowserViewportSnapshot | null;
  loading: boolean;
  acting: boolean;
  launchingQa: boolean;
  liveFollow: boolean;
  fullscreen: boolean;
  deviceSize: BrowserDeviceSize;
  panelOpen: boolean;
  sideTab: 'activity' | 'console';
  errorCount: number;
  urlInput: string;
  onUrlInputChange: (next: string) => void;
  onEditingUrlChange: (editing: boolean) => void;
  onNavigateSubmit: (e: FormEvent) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onToggleLiveFollow: () => void;
  onTogglePlaytest: () => void;
  onOpenProjectDemo: () => void;
  onRunQaCheck: () => void;
  onRefreshSnapshot: () => void;
  onChangeDeviceSize: (size: BrowserDeviceSize) => void;
  onToggleSidePanel: (tab: 'activity' | 'console') => void;
  onToggleFullscreen: () => void;
  onClose?: () => void;
}

export function LiveBrowserToolbar({
  snap,
  loading,
  acting,
  launchingQa,
  liveFollow,
  fullscreen,
  deviceSize,
  panelOpen,
  sideTab,
  errorCount,
  urlInput,
  onUrlInputChange,
  onEditingUrlChange,
  onNavigateSubmit,
  onBack,
  onForward,
  onReload,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleLiveFollow,
  onTogglePlaytest,
  onOpenProjectDemo,
  onRunQaCheck,
  onRefreshSnapshot,
  onChangeDeviceSize,
  onToggleSidePanel,
  onToggleFullscreen,
  onClose,
}: LiveBrowserToolbarProps) {
  const tabs: BrowserTabInfo[] = snap?.tabs ?? [];
  const consoleCount = snap?.consoleLogs?.length ?? 0;
  const activityCount = snap?.agentActions?.length ?? 0;

  const menuItems: MoreMenuItem[] = [
    {
      id: 'open-demo',
      label: 'Open project demo',
      description: 'Start preview or build static demo',
      icon: <Target className="icon" aria-hidden />,
      disabled: acting,
      onSelect: onOpenProjectDemo,
    },
    {
      id: 'playtest',
      label: snap?.playtestActive ? 'Stop playtest' : 'Start playtest',
      description: 'Autonomously interact with the active page',
      icon: snap?.playtestActive ? (
        <Square className="icon" aria-hidden />
      ) : (
        <Bot className="icon" aria-hidden />
      ),
      disabled: acting,
      onSelect: onTogglePlaytest,
    },
    {
      id: 'qa-check',
      label: launchingQa ? 'Dispatching QA…' : 'Run QA check',
      description: 'Dispatch QA agent to verify this app',
      icon: <Bot className="icon" aria-hidden />,
      disabled: launchingQa,
      onSelect: onRunQaCheck,
    },
    {
      id: 'snapshot',
      label: 'Take screenshot',
      description: 'Refresh viewport frame now',
      icon: <Camera className="icon" aria-hidden />,
      disabled: loading || acting,
      onSelect: onRefreshSnapshot,
    },
    {
      id: 'download-screenshot',
      label: 'Download screenshot',
      icon: <Download className="icon" aria-hidden />,
      href: snap?.imageDataUrl ?? undefined,
      disabled: !snap?.imageDataUrl,
    },
    {
      id: 'console',
      label: panelOpen && sideTab === 'console' ? 'Hide console' : `Show console (${consoleCount})`,
      description: errorCount > 0 ? `${errorCount} error(s) recorded` : undefined,
      icon: <Monitor className="icon" aria-hidden />,
      onSelect: () => onToggleSidePanel('console'),
    },
    {
      id: 'activity',
      label: panelOpen && sideTab === 'activity' ? 'Hide activity' : `Show activity (${activityCount})`,
      icon: <Bot className="icon" aria-hidden />,
      onSelect: () => onToggleSidePanel('activity'),
    },
    {
      id: 'device-desktop',
      label: deviceSize === 'desktop' ? 'Resize desktop (active)' : 'Resize desktop',
      description: '1280×720 viewport',
      icon: <Monitor className="icon" aria-hidden />,
      onSelect: () => onChangeDeviceSize('desktop'),
    },
    {
      id: 'device-tablet',
      label: deviceSize === 'tablet' ? 'Resize tablet (active)' : 'Resize tablet',
      description: '768 px width',
      icon: <Tablet className="icon" aria-hidden />,
      onSelect: () => onChangeDeviceSize('tablet'),
    },
    {
      id: 'device-mobile',
      label: deviceSize === 'mobile' ? 'Resize phone (active)' : 'Resize phone',
      description: '390 px width',
      icon: <Smartphone className="icon" aria-hidden />,
      onSelect: () => onChangeDeviceSize('mobile'),
    },
    {
      id: 'live-follow',
      label: liveFollow ? 'Pause live stream' : 'Resume live stream',
      icon: liveFollow ? <Pause className="icon" aria-hidden /> : <Play className="icon" aria-hidden />,
      onSelect: onToggleLiveFollow,
    },
    {
      id: 'fullscreen',
      label: fullscreen ? 'Exit fullscreen' : 'Enter fullscreen',
      icon: fullscreen ? (
        <Minimize2 className="icon" aria-hidden />
      ) : (
        <Maximize2 className="icon" aria-hidden />
      ),
      onSelect: onToggleFullscreen,
    },
  ];

  return (
    <>
      {tabs.length > 0 && (
        <div className="live-browser-tabs">
          {tabs.map((tab) => {
            const isActive = tab.active && !snap?.following;
            return (
              <div
                key={tab.id}
                className={`live-browser-tab${isActive ? ' live-browser-tab-active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
              >
                <span className="live-browser-tab-title">{tab.title || tab.url || 'New tab'}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="live-browser-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    aria-label="Close tab"
                  >
                    <X className="icon" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn-sm btn-ghost live-browser-new-tab"
            onClick={onNewTab}
            aria-label="Open tab"
          >
            Open tab
          </button>
        </div>
      )}

      <form onSubmit={onNavigateSubmit} className="browser-address-row">
        <span
          className={`pill pill-live live-browser-status-pill ${
            snap?.agentActive ? 'live-browser-status-pill-agent' : 'live-browser-status-pill-ready'
          }`}
        >
          <span className="dot" />
          {snap?.agentActive ? (
            <>
              <Zap className="icon" aria-hidden /> Agent active
            </>
          ) : snap?.available ? (
            'Ready'
          ) : (
            'Starting…'
          )}
        </span>

        <button type="button" className="btn btn-sm" disabled={acting} onClick={onBack} aria-label="Back">
          <ArrowLeft className="icon" aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={acting}
          onClick={onForward}
          aria-label="Forward"
        >
          <ArrowRight className="icon" aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={acting}
          onClick={onReload}
          aria-label="Reload current tab"
        >
          <RotateCw className="icon" aria-hidden />
        </button>

        <input
          type="text"
          className="input mono browser-address-input"
          value={urlInput}
          onFocus={() => onEditingUrlChange(true)}
          onBlur={() => onEditingUrlChange(false)}
          onChange={(e) => onUrlInputChange(e.target.value)}
          aria-label="Address as the runner's browser sees it"
          placeholder="http://localhost:5173"
        />

        <button type="submit" className="btn btn-sm btn-primary" disabled={acting}>
          Go
        </button>

        {snap?.playtestActive && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={acting}
            onClick={onTogglePlaytest}
          >
            <Square className="icon" aria-hidden /> Stop playtest
          </button>
        )}

        <MoreMenu items={menuItems} ariaLabel="Browser tools" />

        {onClose && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            aria-label="Close live browser"
          >
            <X className="icon" aria-hidden />
          </button>
        )}
      </form>
    </>
  );
}

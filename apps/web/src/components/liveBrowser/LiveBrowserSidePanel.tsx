import type { BrowserAgentAction, BrowserConsoleEntry } from '@emberline/protocol';
import { Bot, Monitor, Wrench, X } from 'lucide-react';
import { PersonaBadge } from '../PersonaBadge';

export interface LiveBrowserSidePanelProps {
  sideTab: 'activity' | 'console';
  onChangeSideTab: (tab: 'activity' | 'console') => void;
  onClosePanel: () => void;
  agentActions: BrowserAgentAction[];
  consoleLogs: BrowserConsoleEntry[];
  errorCount: number;
  launchingQa: boolean;
  onOpenTerminal: (runId: string) => void;
  onFixConsoleError: (entry: BrowserConsoleEntry) => void;
}

export function LiveBrowserSidePanel({
  sideTab,
  onChangeSideTab,
  onClosePanel,
  agentActions,
  consoleLogs,
  errorCount,
  launchingQa,
  onOpenTerminal,
  onFixConsoleError,
}: LiveBrowserSidePanelProps) {
  return (
    <div className="live-browser-side-panel">
      <div className="live-browser-side-header">
        <div className="live-browser-side-tabs" role="tablist" aria-label="Browser inspector">
          <button
            type="button"
            role="tab"
            aria-selected={sideTab === 'activity'}
            className="live-browser-side-tab"
            onClick={() => onChangeSideTab('activity')}
          >
            <Bot className="icon" aria-hidden /> Activity ({agentActions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sideTab === 'console'}
            className="live-browser-side-tab"
            onClick={() => onChangeSideTab('console')}
          >
            <Monitor className="icon" aria-hidden /> Console ({consoleLogs.length})
            {errorCount > 0 && <span className="badge live-browser-side-err-badge">{errorCount} err</span>}
          </button>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClosePanel} aria-label="Hide panel">
          <X className="icon" aria-hidden />
        </button>
      </div>

      <div className="live-browser-side-body">
        {sideTab === 'activity' ? (
          agentActions.length === 0 ? (
            <div className="muted small">
              No browser tool calls recorded yet. Open More and choose Run QA check to watch an agent verify
              the app.
            </div>
          ) : (
            agentActions.map((act) => (
              <div key={act.id} className="live-browser-log-card">
                <div className="live-browser-log-head">
                  <div className="live-browser-log-title">
                    <PersonaBadge persona={act.persona} />
                    <span className="mono live-browser-tool-name">{act.toolName}</span>
                  </div>
                  {act.runId !== 'live-browser' && act.runId !== 'playwright-script' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onOpenTerminal(act.runId)}
                    >
                      Open terminal
                    </button>
                  )}
                </div>
                <div className="mono muted live-browser-log-text">{act.summary}</div>
                <div className="mono muted live-browser-log-meta">
                  {new Date(act.timestamp).toLocaleTimeString()} · {act.runTitle ?? act.runId.slice(0, 8)}
                </div>
              </div>
            ))
          )
        ) : consoleLogs.length === 0 ? (
          <div className="muted small">No console output captured yet from the active tab.</div>
        ) : (
          consoleLogs.map((entry, idx) => {
            const isErr = entry.level === 'error';
            const isWarn = entry.level === 'warn';
            const cardClass = isErr
              ? 'live-browser-log-card live-browser-log-card-err'
              : isWarn
                ? 'live-browser-log-card live-browser-log-card-warn'
                : 'live-browser-log-card';
            const levelClass = isErr
              ? 'live-browser-level-err'
              : isWarn
                ? 'live-browser-level-warn'
                : 'live-browser-level-info';

            return (
              <div key={`${entry.timestamp}-${idx}`} className={cardClass}>
                <div className="live-browser-log-head">
                  <span className={`mono ${levelClass}`}>
                    [{entry.level.toUpperCase()}] {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  {isErr && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={launchingQa}
                      onClick={() => onFixConsoleError(entry)}
                    >
                      <Wrench className="icon" aria-hidden /> Fix error
                    </button>
                  )}
                </div>
                <div className="mono live-browser-log-text">{entry.text}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

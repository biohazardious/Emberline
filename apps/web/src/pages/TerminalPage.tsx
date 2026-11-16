import type { TerminalInfo } from '@emberline/protocol';
import { ArrowLeft, GitCompareArrows, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { ErrorBoundary, ViewErrorBanner } from '../components/ErrorBoundary';
import { RunStatePill } from '../components/RunStatePill';
import { type ConnectionState, TerminalView } from '../components/TerminalView';
import { useRuns } from '../hooks/liveData';
import { useGoBack } from '../hooks/navigation';
import { useApi } from '../hooks/useApi';
import '../components/runInspector/run-inspector.css';

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  exited: 'exited',
};

export function TerminalPage({ id }: { id: string }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const terminals = useApi<TerminalInfo[]>('/api/terminals', 5_000);
  const info = terminals.data?.find((t) => t.id === id);
  const { runs } = useRuns();
  const run = info?.runId ? runs?.find((r) => r.id === info.runId) : undefined;

  const goBack = useGoBack();

  return (
    <div className="terminal-page">
      <header className="terminal-head">
        <button type="button" className="icon-btn" aria-label="Back to the previous page" onClick={goBack}>
          <ArrowLeft className="icon" aria-hidden />
        </button>
        <h1 className="terminal-title">{info?.title ?? 'Terminal'}</h1>
        {run ? (
          <RunStatePill
            state={run.state}
            cancelled={run.cancelled}
            autoRetry={run.autoRetry}
            handedOffTo={run.handedOffTo}
          />
        ) : null}
        <span className={`pill pill-${state}`}>
          <span className="dot" />
          {STATE_LABEL[state]}
        </span>
        <div className="terminal-head-actions">
          {run?.worktreePath && (
            <Link href={`/runs/${run.id}/review`} className="icon-btn" aria-label="Open review">
              <GitCompareArrows className="icon" aria-hidden />
            </Link>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh terminal metadata"
            onClick={() => void terminals.refresh()}
          >
            <RotateCw className="icon" aria-hidden />
          </button>
        </div>
      </header>
      {Boolean(terminals.error && !terminals.data) && (
        <ViewErrorBanner
          compact
          label="Could not load terminal metadata"
          error={terminals.error}
          onRetry={terminals.refresh}
        />
      )}
      <ErrorBoundary resetKey={id}>
        <TerminalView terminalId={id} onStateChange={setState} />
      </ErrorBoundary>
    </div>
  );
}

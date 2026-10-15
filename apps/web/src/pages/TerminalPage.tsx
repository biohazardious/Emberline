import type { TerminalInfo } from '@emberline/protocol';
import { useState } from 'react';
import { RunStatePill } from '../components/RunStatePill';
import { type ConnectionState, TerminalView } from '../components/TerminalView';
import { useApi } from '../hooks/useApi';
import { useRuns } from '../hooks/liveData';
import { useGoBack } from '../hooks/navigation';

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
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Back to the previous page" onClick={goBack}>
          ← Back
        </button>
        <h1 className="terminal-title">{info?.title ?? 'Terminal'}</h1>
        {run?.branch && <span className="badge badge-soft mono hide-sm">{run.branch}</span>}
        {run && <RunStatePill state={run.state} cancelled={run.cancelled} />}
        <span className={`pill pill-${state}`}>
          <span className="dot" />
          {STATE_LABEL[state]}
        </span>
      </header>
      <TerminalView terminalId={id} onStateChange={setState} />
    </div>
  );
}

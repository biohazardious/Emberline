import type { TerminalInfo } from '@emberline/protocol';
import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../api';
import { RunStatePill } from '../components/RunStatePill';
import { type ConnectionState, TerminalView } from '../components/TerminalView';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  exited: 'exited',
};

export function TerminalPage({ id }: { id: string }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const terminals = usePoll(() => api<TerminalInfo[]>('/api/terminals'), 5_000);
  const info = terminals.data?.find((t) => t.id === id);
  const { runs } = useRuns();
  const run = info?.runId ? runs?.find((r) => r.id === info.runId) : undefined;

  return (
    <div className="terminal-page">
      <header className="terminal-head">
        <Link href="/" className="btn btn-ghost btn-sm" aria-label="Back to dashboard">
          ← Back
        </Link>
        <h1 className="terminal-title">{info?.title ?? 'Terminal'}</h1>
        {run?.branch && <span className="badge badge-soft mono hide-sm">{run.branch}</span>}
        {run && <RunStatePill state={run.state} />}
        <span className={`pill pill-${state}`}>
          <span className="dot" />
          {STATE_LABEL[state]}
        </span>
      </header>
      <TerminalView terminalId={id} onStateChange={setState} />
    </div>
  );
}

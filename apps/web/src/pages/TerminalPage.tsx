import type { TerminalInfo } from '@emberline/protocol';
import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../api';
import { type ConnectionState, TerminalView } from '../components/TerminalView';
import { usePoll } from '../hooks/usePoll';

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

  return (
    <div className="terminal-page">
      <header className="terminal-head">
        <Link href="/" className="btn btn-ghost btn-sm" aria-label="Back to dashboard">
          ← Back
        </Link>
        <h1 className="terminal-title">{info?.title ?? 'Terminal'}</h1>
        <span className={`pill pill-${state}`}>
          <span className="dot" />
          {STATE_LABEL[state]}
        </span>
      </header>
      <TerminalView terminalId={id} onStateChange={setState} />
    </div>
  );
}

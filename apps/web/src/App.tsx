import { useEffect, useState } from 'react';

type CoreStatus =
  | { kind: 'checking' }
  | { kind: 'online'; version: string; uptimeSeconds: number }
  | { kind: 'offline' };

const MILESTONES = [
  { id: 'M0', title: 'Monorepo scaffold', done: true },
  { id: 'M1', title: 'ptyd — persistent PTY holder', done: true },
  { id: 'M2', title: 'Core + web terminal', done: false },
  { id: 'M3', title: 'Claude adapter + hooks', done: false },
  { id: 'M4', title: 'Ticket board', done: false },
  { id: 'M5', title: 'Quota scheduler + auto-resume', done: false },
  { id: 'M6', title: 'Diff review + compose deploy', done: false },
];

function useCoreStatus(): CoreStatus {
  const [status, setStatus] = useState<CoreStatus>({ kind: 'checking' });
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { version: string; uptimeSeconds: number };
        if (!cancelled) setStatus({ kind: 'online', ...body });
      } catch {
        if (!cancelled) setStatus({ kind: 'offline' });
      }
    };
    void check();
    const timer = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

export function App() {
  const status = useCoreStatus();
  const doneCount = MILESTONES.filter((m) => m.done).length;

  return (
    <main className="shell">
      <div className="glow" aria-hidden="true" />
      <header className="hero">
        <span className="brand-mark" aria-hidden="true" />
        <h1>Emberline</h1>
        <p className="tagline">Tickets in, commits out — AI coding agents on your own server and subscription.</p>
        <div id="core-status" className={`status status-${status.kind}`}>
          <span className="dot" />
          {status.kind === 'checking' && 'Checking core…'}
          {status.kind === 'online' && `Core online · v${status.version} · up ${status.uptimeSeconds}s`}
          {status.kind === 'offline' && 'Core offline — run `pnpm --filter @emberline/core dev`'}
        </div>
      </header>

      <section className="card" aria-labelledby="roadmap-title">
        <div className="card-head">
          <h2 id="roadmap-title">MVP roadmap</h2>
          <span className="progress-label">
            {doneCount}/{MILESTONES.length}
          </span>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={doneCount} aria-valuemax={MILESTONES.length}>
          <div className="progress-fill" style={{ width: `${(doneCount / MILESTONES.length) * 100}%` }} />
        </div>
        <ol className="milestones">
          {MILESTONES.map((m) => (
            <li key={m.id} className={m.done ? 'done' : ''}>
              <span className="milestone-id">{m.id}</span>
              <span>{m.title}</span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="notice">
        One installation = one user = your own Claude subscription. Not affiliated with Anthropic.
      </footer>
    </main>
  );
}

import type { Project, Run, SchedulerState, TerminalInfo } from '@emberline/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../api';

interface CommandItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  badge?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
  projects,
  runs,
  scheduler,
  onInspectRun,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  runs: Run[];
  scheduler: SchedulerState | undefined;
  onInspectRun: (runId: string) => void;
  onLogout: () => void;
}) {
  const [, navigate] = useLocation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback for browsers without <dialog closedby="any"> support (per modern-web-guidance).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onDialogClose = () => onClose();
    dialog.addEventListener('close', onDialogClose);

    const onBackdropClick = (event: MouseEvent) => {
      if ('closedBy' in HTMLDialogElement.prototype) return;
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    };
    dialog.addEventListener('click', onBackdropClick);
    return () => {
      dialog.removeEventListener('close', onDialogClose);
      dialog.removeEventListener('click', onBackdropClick);
    };
  }, [onClose]);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [
      {
        id: 'nav-overview',
        group: 'Navigation',
        label: 'Go to Workbench Overview',
        meta: 'Projects, runs, terminals & quota',
        badge: 'G O',
        run: () => navigate('/'),
      },
      {
        id: 'nav-fleet',
        group: 'Navigation',
        label: 'Go to Fleet Multiplexer',
        meta: 'Live side-by-side agent terminal grid',
        badge: 'G F',
        run: () => navigate('/fleet'),
      },
    ];

    for (const p of projects) {
      list.push({
        id: `board-${p.id}`,
        group: 'Project Boards',
        label: `Board · ${p.name}`,
        meta: p.repoUrl ?? p.path,
        badge: p.slug,
        run: () => navigate(`/projects/${p.id}/board`),
      });
    }

    for (const r of runs.slice(0, 12)) {
      const proj = projectById.get(r.projectId)?.name ?? 'Project';
      const title = r.title ?? (r.prompt ? r.prompt.slice(0, 48) : `${proj} run`);
      list.push({
        id: `run-${r.id}`,
        group: r.state === 'waiting_input' ? 'Needs Your Attention' : 'Agent Runs',
        label: `Inspect · ${title}`,
        meta: `${proj}${r.branch ? ` · ${r.branch}` : ''}`,
        badge: r.state,
        run: () => onInspectRun(r.id),
      });
      if (r.terminalId) {
        list.push({
          id: `run-term-${r.id}`,
          group: 'Agent Runs',
          label: `Terminal · ${title}`,
          meta: r.branch ?? proj,
          badge: 'PTY',
          run: () => navigate(`/terminals/${r.terminalId}`),
        });
      }
    }

    list.push(
      {
        id: 'act-new-claude',
        group: 'Quick Actions',
        label: 'Start Interactive Claude Terminal',
        meta: 'Opens a new Claude Code CLI session in the runner',
        badge: 'claude',
        run: async () => {
          const t = await api<TerminalInfo>('/api/terminals', 'POST', { kind: 'claude' });
          navigate(`/terminals/${t.id}`);
        },
      },
      {
        id: 'act-new-shell',
        group: 'Quick Actions',
        label: 'Open New Shell Terminal',
        meta: 'Interactive bash session in /workspaces',
        badge: 'shell',
        run: async () => {
          const t = await api<TerminalInfo>('/api/terminals', 'POST', { kind: 'shell' });
          navigate(`/terminals/${t.id}`);
        },
      },
    );

    if (scheduler?.window) {
      list.push({
        id: 'act-quota-resume',
        group: 'Quota Scheduler',
        label: 'Resume Quota Window Now',
        meta: 'Override rate-limit timer and dispatch paused runs immediately',
        badge: 'quota',
        run: async () => {
          await api('/api/scheduler/resume', 'POST');
        },
      });
    }

    for (const n of [1, 2, 3, 4]) {
      list.push({
        id: `act-concurrency-${n}`,
        group: 'Quota Scheduler',
        label: `Set Max Parallel Runs to ${n}`,
        meta: scheduler?.maxConcurrentRuns === n ? 'Current setting' : 'Update scheduler concurrency',
        badge: `${n}x`,
        run: async () => {
          await api('/api/scheduler', 'PATCH', { maxConcurrentRuns: n });
        },
      });
    }

    list.push({
      id: 'act-logout',
      group: 'Account',
      label: 'Sign out of Emberline',
      run: () => onLogout(),
    });

    return list;
  }, [projects, runs, projectById, scheduler, navigate, onInspectRun, onLogout]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        (item.meta?.toLowerCase().includes(q) ?? false) ||
        (item.badge?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const execute = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    void item.run();
  };

  return (
    <dialog
      ref={dialogRef}
      id="command-palette"
      className="cmd-dialog"
      closedby="any"
      aria-label="Command palette"
    >
      <div className="cmd-box">
        <header className="cmd-head">
          <span className="cmd-icon mono" aria-hidden="true">
            ⌘K
          </span>
          <input
            ref={inputRef}
            id="cmd-input"
            className="cmd-input"
            placeholder="Jump to board, fleet, run, or trigger an action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                execute(filtered[activeIndex]);
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </header>
        <ul className="cmd-list" role="listbox">
          {filtered.length === 0 && <li className="cmd-empty muted">No matching commands.</li>}
          {filtered.map((item, idx) => (
            <li
              key={item.id}
              role="option"
              aria-selected={idx === activeIndex}
              className={`cmd-item${idx === activeIndex ? ' active' : ''}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => execute(item)}
            >
              <span className="cmd-group mono">{item.group}</span>
              <span className="cmd-label">{item.label}</span>
              {item.meta && <span className="cmd-meta mono">{item.meta}</span>}
              {item.badge && <span className="badge mono">{item.badge}</span>}
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}

import type { Project, Run, SchedulerState, TerminalInfo } from '@emberline/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { toastError } from '../toast';

interface CommandItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  badge?: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
  projects,
  runs,
  scheduler,
  dockerEnabled = false,
  onInspectRun,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  runs: Run[];
  scheduler: SchedulerState | undefined;
  dockerEnabled?: boolean;
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
        label: 'Overview',
        meta: 'Projects, runs, terminals and quota',
        badge: 'G O',
        keywords: 'go to workbench factory overview dashboard',
        run: () => navigate('/'),
      },
      {
        id: 'nav-inbox',
        group: 'Navigation',
        label: 'Inbox',
        meta: 'Runs that need you, across all projects',
        badge: 'G I',
        keywords: 'go to inbox attention',
        run: () => navigate('/inbox'),
      },
      {
        id: 'nav-fleet',
        group: 'Navigation',
        label: 'Fleet',
        meta: 'Live side-by-side agent terminal grid',
        badge: 'G F',
        keywords: 'go to fleet multiplexer terminals',
        run: () => navigate('/fleet'),
      },
      ...(dockerEnabled
        ? [
            {
              id: 'nav-docker',
              group: 'Navigation',
              label: 'Docker',
              meta: 'Compose projects and container previews',
              badge: 'G D',
              keywords: 'go to docker engine compose containers',
              run: () => navigate('/docker'),
            },
          ]
        : []),
      {
        id: 'nav-settings',
        group: 'Navigation',
        label: 'Settings',
        meta: 'Auto-pilot, AI providers, theme and quota',
        badge: 'G S',
        keywords: 'go to factory settings control center',
        run: () => navigate('/settings'),
      },
    ];

    for (const p of projects) {
      list.push(
        {
          id: `board-${p.id}`,
          group: 'Projects',
          label: `Board · ${p.name}`,
          meta: p.repoUrl ?? p.path,
          badge: p.slug,
          keywords: 'kanban board tickets',
          run: () => navigate(`/projects/${p.id}/board`),
        },
        {
          id: `roadmap-${p.id}`,
          group: 'Projects',
          label: `Roadmap · ${p.name}`,
          meta: p.path,
          badge: 'roadmap',
          keywords: 'roadmap brainstorm studio milestones',
          run: () => navigate(`/projects/${p.id}/roadmap`),
        },
        {
          id: `code-${p.id}`,
          group: 'Projects',
          label: `Code · ${p.name}`,
          meta: p.path,
          badge: 'code',
          keywords: 'code explorer files editor',
          run: () => navigate(`/projects/${p.id}/code`),
        },
        {
          id: `outputs-${p.id}`,
          group: 'Projects',
          label: `Build outputs · ${p.name}`,
          meta: p.path,
          badge: 'outputs',
          keywords: 'build outputs artifacts',
          run: () => navigate(`/projects/${p.id}/outputs`),
        },
        {
          id: `browser-${p.id}`,
          group: 'Projects',
          label: `Live browser · ${p.name}`,
          meta: p.path,
          badge: 'browser',
          keywords: 'live browser studio preview',
          run: () => navigate(`/projects/${p.id}/browser`),
        },
        {
          id: `proj-settings-${p.id}`,
          group: 'Projects',
          label: `Project settings · ${p.name}`,
          meta: p.path,
          badge: 'settings',
          keywords: 'project settings repository',
          run: () => navigate(`/projects/${p.id}/settings`),
        },
      );
    }

    for (const r of runs.slice(0, 12)) {
      const proj = projectById.get(r.projectId)?.name ?? 'Project';
      const title = r.title ?? (r.prompt ? r.prompt.slice(0, 48) : `${proj} run`);
      list.push({
        id: `run-${r.id}`,
        group: r.state === 'waiting_input' || r.attention ? 'Needs attention' : 'Agent runs',
        label: `Inspect · ${title}`,
        meta: `${proj}${r.branch ? ` · ${r.branch}` : ''}`,
        badge: r.state,
        run: () => onInspectRun(r.id),
      });
      if (r.terminalId) {
        list.push({
          id: `run-term-${r.id}`,
          group: 'Agent runs',
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
        group: 'Quick actions',
        label: 'New Claude terminal',
        meta: 'Opens a new Claude Code CLI session in the runner',
        badge: 'claude',
        keywords: 'start interactive claude terminal',
        run: async () => {
          const t = await api<TerminalInfo>('/api/terminals', 'POST', { kind: 'claude' });
          navigate(`/terminals/${t.id}`);
        },
      },
      {
        id: 'act-new-shell',
        group: 'Quick actions',
        label: 'New shell terminal',
        meta: 'Interactive bash session in /workspaces',
        badge: 'shell',
        keywords: 'open new shell terminal bash',
        run: async () => {
          const t = await api<TerminalInfo>('/api/terminals', 'POST', { kind: 'shell' });
          navigate(`/terminals/${t.id}`);
        },
      },
    );

    if (scheduler?.window) {
      list.push({
        id: 'act-quota-resume',
        group: 'Quota scheduler',
        label: 'Resume quota window',
        meta: 'Override rate-limit timer and dispatch paused runs immediately',
        badge: 'quota',
        keywords: 'resume quota window now',
        run: async () => {
          await api('/api/scheduler/resume', 'POST');
        },
      });
    }

    for (const n of [1, 2, 3, 4]) {
      list.push({
        id: `act-concurrency-${n}`,
        group: 'Quota scheduler',
        label: `Set parallel runs to ${n}`,
        meta: scheduler?.maxConcurrentRuns === n ? 'Current setting' : 'Update scheduler concurrency',
        badge: `${n}x`,
        keywords: 'set max parallel runs concurrency',
        run: async () => {
          await api('/api/scheduler', 'PATCH', { maxConcurrentRuns: n });
        },
      });
    }

    list.push({
      id: 'act-logout',
      group: 'Account',
      label: 'Sign out',
      keywords: 'sign out of emberline logout',
      run: () => onLogout(),
    });

    return list;
  }, [projects, runs, projectById, scheduler, dockerEnabled, navigate, onInspectRun, onLogout]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((item) => {
      const haystack = [item.label, item.group, item.meta ?? '', item.badge ?? '', item.keywords ?? '']
        .join(' ')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const execute = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    Promise.resolve(item.run()).catch((e: unknown) => {
      toastError(errorMessage(e));
    });
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
            placeholder="Jump to board, roadmap, fleet, run, or trigger an action…"
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

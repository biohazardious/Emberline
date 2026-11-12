import type { AgentPersona, PermissionMode, Project, Run, Ticket, TicketStatus } from '@emberline/protocol';
import { issueHref } from '../../issueImport';

export const COLUMNS: { status: TicketStatus; label: string; hint: string }[] = [
  { status: 'backlog', label: 'Backlog', hint: 'Ideas and not-yet-ready work' },
  { status: 'ready', label: 'Ready', hint: 'Specified and ready to hand to an agent' },
  {
    status: 'in_progress',
    label: 'In progress',
    hint: 'Drop here to dispatch agent (or monitor active run)',
  },
  { status: 'review', label: 'Review', hint: 'Agent finished its turn; review or send a follow-up' },
  { status: 'done', label: 'Done', hint: 'Accepted; runs never move tickets out of here' },
];

export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;

export const POSITION_STEP = 1024;

export const byPosition = (a: Ticket, b: Ticket) => a.position - b.position;

/** Position that slots a ticket in front of `beforeId` (or at the end) of an ordered column. */
export function slotPosition(column: Ticket[], beforeId: string | null): number {
  const index = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
  const next = index === -1 ? undefined : column[index];
  const prev = index === -1 ? column.at(-1) : column[index - 1];
  if (prev && next) return (prev.position + next.position) / 2;
  if (next) return next.position - POSITION_STEP;
  if (prev) return prev.position + POSITION_STEP;
  return POSITION_STEP;
}

export interface DropTarget {
  status: TicketStatus;
  beforeId: string | null;
}

export const DRAWER_VIEWS = ['details', 'review', 'terminal', 'events'] as const;
export type DrawerView = (typeof DRAWER_VIEWS)[number];

export interface BoardCtx {
  pid: string;
  proj: Project | undefined;
  tickets: Ticket[] | undefined;
  cols: Map<TicketStatus, Ticket[]>;
  runs: Map<string, Run>;
  auto: boolean;
  flipAuto: () => void;
  demo: boolean;
  flipDemo: () => void;
  openBp: () => void;
  openImp: () => void;
  back: () => void;
  patch: (t: Ticket) => void;
  err: string | undefined;
  setErr: (m: string | undefined) => void;
  blocked: { ticket: Ticket; target: DropTarget; count: number } | undefined;
  missing: { ticket: Ticket; target: DropTarget } | undefined;
  clrBlocked: () => void;
  clrMissing: () => void;
  move: (t: Ticket, d: DropTarget, opts?: { force?: boolean; skipMerge?: boolean }) => Promise<void>;
  open: (id: string) => void;
}

export interface DrawerCtx {
  t: Ticket;
  all: Ticket[];
  run: Run | undefined;
  title: string;
  setTitle: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  prio: number;
  setPrio: (v: number) => void;
  persona: AgentPersona;
  setPersona: (v: AgentPersona) => void;
  mode: PermissionMode;
  setMode: (v: PermissionMode) => void;
  follow: string;
  setFollow: (v: string) => void;
  view: DrawerView;
  setView: (v: DrawerView) => void;
  dirty: boolean;
  busy: string | undefined;
  setBusy: (v: string | undefined) => void;
  confirm: boolean;
  save: () => Promise<void>;
  start: () => void;
  send: () => Promise<void>;
  runAct: (name: 'resume' | 'stop') => Promise<void>;
  changed: (t: Ticket) => void;
  move: (s: TicketStatus) => void;
  discard: () => Promise<void>;
  accept: (opts?: { force?: boolean }) => Promise<void>;
}

/** The issue a ticket was imported from: `#123` linking to it, its labels, whether it is closed or needs triage. */
export function IssueChips({ external }: { external: Ticket['external'] }) {
  if (!external) return null;
  const href = issueHref(external.url);
  return (
    <div className="card-issue">
      {href ? (
        <a
          className="badge badge-soft mono issue-chip"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the issue"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          #{external.number}
        </a>
      ) : (
        <span className="badge badge-soft mono">#{external.number}</span>
      )}
      {external.triage && (
        <span
          className="badge badge-warn"
          title="Label sync imported this from an author who is not in Trusted authors. Automatic dispatch skips it until you move or edit it."
        >
          needs triage
        </span>
      )}
      {external.state === 'closed' && <span className="badge badge-soft">closed</span>}
      {external.labels.map((l) => (
        <span key={l} className="badge badge-soft card-issue-label">
          {l}
        </span>
      ))}
    </div>
  );
}

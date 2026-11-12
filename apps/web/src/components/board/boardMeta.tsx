import type {
  AgentPersona,
  BulkTicketResult,
  PermissionMode,
  Project,
  Run,
  Ticket,
  TicketStatus,
} from '@emberline/protocol';
import type { BoardFilter } from '../../boardFilter';
import type { ConflictHoldFallback } from '../../holdRecovery';
import type { BoardSelectionState } from '../../hooks/useBoardSelection';
import type { SyncResolvingNotice } from '../../syncResolution';

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
  allCols: Map<TicketStatus, Ticket[]>;
  visCols: Map<TicketStatus, Ticket[]>;
  colCounts: Map<TicketStatus, number>;
  runs: Map<string, Run>;
  auto: boolean;
  flipAuto: () => void;
  demo: boolean;
  flipDemo: () => void;
  canSeed: boolean;
  bulk: BoardSelectionState;
  onBulkApplied: (result: BulkTicketResult) => void;
  filter: BoardFilter;
  filterActive: boolean;
  filteredShown: number;
  updateFilter: (next: BoardFilter) => void;
  openBp: () => void;
  openImp: () => void;
  back: () => void;
  patch: (t: Ticket) => void;
  err: string | undefined;
  setErr: (m: string | undefined) => void;
  blocked: { ticket: Ticket; target: DropTarget; count: number } | undefined;
  missing: { ticket: Ticket; target: DropTarget } | undefined;
  resolving?: SyncResolvingNotice | undefined;
  clrBlocked: () => void;
  clrMissing: () => void;
  clrResolving?: () => void;
  move: (t: Ticket, d: DropTarget, opts?: { force?: boolean; skipMerge?: boolean }) => Promise<void>;
  open: (id: string) => void;
}

export interface DrawerCtx {
  t: Ticket;
  all: Ticket[];
  run: Run | undefined;
  conflictFallback?: ConflictHoldFallback | null;
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

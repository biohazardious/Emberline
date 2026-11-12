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
  projectId: string;
  project: Project | undefined;
  tickets: Ticket[] | undefined;
  allColumns: Map<TicketStatus, Ticket[]>;
  visibleColumns: Map<TicketStatus, Ticket[]>;
  columnCounts: Map<TicketStatus, number>;
  latestRun: Map<string, Run>;
  autoStart: boolean;
  toggleAutoStart: () => void;
  demoPanelOpen: boolean;
  toggleDemoPanel: () => void;
  canSeed: boolean;
  bulkSelection: BoardSelectionState;
  onBulkApplied: (result: BulkTicketResult) => void;
  filter: BoardFilter;
  filterActive: boolean;
  filteredCount: number;
  updateFilter: (next: BoardFilter) => void;
  openBlueprint: () => void;
  openImport: () => void;
  goBack: () => void;
  patchTicket: (ticket: Ticket) => void;
  error: string | undefined;
  setError: (message: string | undefined) => void;
  blockedDrop: { ticket: Ticket; target: DropTarget; count: number } | undefined;
  missingDrop: { ticket: Ticket; target: DropTarget } | undefined;
  resolvingNotice?: SyncResolvingNotice | undefined;
  clearBlockedDrop: () => void;
  clearMissingDrop: () => void;
  clearResolvingNotice?: () => void;
  moveTicket: (
    ticket: Ticket,
    target: DropTarget,
    opts?: { force?: boolean; skipMerge?: boolean },
  ) => Promise<void>;
  openTicket: (id: string) => void;
}

export interface DrawerCtx {
  ticket: Ticket;
  allTickets: Ticket[];
  run: Run | undefined;
  conflictFallback?: ConflictHoldFallback | null;
  title: string;
  setTitle: (value: string) => void;
  body: string;
  setBody: (value: string) => void;
  priority: number;
  setPriority: (value: number) => void;
  persona: AgentPersona;
  setPersona: (value: AgentPersona) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (value: PermissionMode) => void;
  followUp: string;
  setFollowUp: (value: string) => void;
  viewTab: DrawerView;
  setViewTab: (value: DrawerView) => void;
  dirty: boolean;
  busyAction: string | undefined;
  setBusyAction: (value: string | undefined) => void;
  confirmStart: boolean;
  save: () => Promise<void>;
  startRun: () => void;
  sendFollowUp: () => Promise<void>;
  runAction: (name: 'resume' | 'stop') => Promise<void>;
  onChanged: (ticket: Ticket) => void;
  onMove: (status: TicketStatus) => void;
  onDiscard: () => Promise<void>;
  onAccept: (opts?: { force?: boolean }) => Promise<void>;
}

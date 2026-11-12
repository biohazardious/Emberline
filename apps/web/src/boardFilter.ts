import type { AgentPersona, Run, Ticket } from '@emberline/protocol';

export const BOARD_PERSONAS: readonly AgentPersona[] = [
  'coder',
  'product_owner',
  'architect',
  'ui_ux',
  'dba',
  'qa',
  'security',
];

export const BOARD_PRIORITIES = [0, 1, 2, 3] as const;

export interface BoardFilter {
  query: string;
  personas: AgentPersona[];
  priorities: number[];
  onlyBlocked: boolean;
  onlyActiveRun: boolean;
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
  query: '',
  personas: [],
  priorities: [],
  onlyBlocked: false,
  onlyActiveRun: false,
};

export function isBoardFilterActive(filter: BoardFilter): boolean {
  return (
    filter.query.trim() !== '' ||
    filter.personas.length > 0 ||
    filter.priorities.length > 0 ||
    filter.onlyBlocked ||
    filter.onlyActiveRun
  );
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function isTicketBlocked(ticket: Ticket): boolean {
  return ticket.blockedBy.length > 0 || (ticket.completion?.blockers.length ?? 0) > 0;
}

export function isRunLive(run: Run | undefined): boolean {
  return Boolean(run && !run.endedAt && run.state !== 'done' && run.state !== 'failed');
}

/**
 * True when the ticket satisfies persona, priority, blocked/live toggles, and every search term
 * matches its key, title, body, imported issue metadata, or linked run branch/provider.
 */
export function ticketMatchesBoardFilter(ticket: Ticket, run: Run | undefined, filter: BoardFilter): boolean {
  if (filter.personas.length > 0 && !filter.personas.includes(ticket.persona)) return false;
  if (filter.priorities.length > 0 && !filter.priorities.includes(ticket.priority)) return false;
  if (filter.onlyBlocked && !isTicketBlocked(ticket)) return false;
  if (filter.onlyActiveRun && !isRunLive(run)) return false;

  const words = queryTerms(filter.query);
  if (words.length === 0) return true;

  const haystack = [
    ticket.key,
    ticket.title,
    ticket.body,
    ticket.persona,
    ticket.external ? `#${ticket.external.number}` : '',
    ticket.external ? ticket.external.labels.join(' ') : '',
    run?.branch ?? '',
    run?.agent ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return words.every((word) => haystack.includes(word));
}

export function filterBoardTickets(
  tickets: readonly Ticket[],
  latestRunByTicket: ReadonlyMap<string, Run>,
  filter: BoardFilter,
): { tickets: Ticket[]; shown: number; total: number } {
  if (!isBoardFilterActive(filter)) {
    const copy = [...tickets];
    return { tickets: copy, shown: copy.length, total: copy.length };
  }
  const matched = tickets.filter((t) => ticketMatchesBoardFilter(t, latestRunByTicket.get(t.id), filter));
  return { tickets: matched, shown: matched.length, total: tickets.length };
}

export function countBoardPersonas(tickets: readonly Ticket[]): Record<AgentPersona, number> {
  const counts: Record<AgentPersona, number> = {
    coder: 0,
    product_owner: 0,
    architect: 0,
    ui_ux: 0,
    dba: 0,
    qa: 0,
    security: 0,
  };
  for (const ticket of tickets) counts[ticket.persona] += 1;
  return counts;
}

export function countBoardFlags(
  tickets: readonly Ticket[],
  latestRunByTicket: ReadonlyMap<string, Run>,
): { blocked: number; activeRun: number } {
  let blocked = 0;
  let activeRun = 0;
  for (const ticket of tickets) {
    if (isTicketBlocked(ticket)) blocked += 1;
    if (isRunLive(latestRunByTicket.get(ticket.id))) activeRun += 1;
  }
  return { blocked, activeRun };
}

/** Parse a stored board filter safely; invalid shapes fall back to showing all tickets. */
export function parseBoardFilter(raw: string | null): BoardFilter {
  if (!raw) return EMPTY_BOARD_FILTER;
  try {
    const parsed = JSON.parse(raw) as Partial<BoardFilter>;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      personas: Array.isArray(parsed.personas)
        ? parsed.personas.filter((p): p is AgentPersona => BOARD_PERSONAS.includes(p))
        : [],
      priorities: Array.isArray(parsed.priorities)
        ? parsed.priorities.filter((n): n is number =>
            BOARD_PRIORITIES.includes(n as (typeof BOARD_PRIORITIES)[number]),
          )
        : [],
      onlyBlocked: Boolean(parsed.onlyBlocked),
      onlyActiveRun: Boolean(parsed.onlyActiveRun),
    };
  } catch {
    return EMPTY_BOARD_FILTER;
  }
}

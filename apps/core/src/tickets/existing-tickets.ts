/**
 * The project's other tickets, for a planning (`product_owner`) run's first prompt: the planner
 * checks them before it writes new ones, so one change never gets two tickets.
 */

/** The section's size at most (within the run prompt limit). */
export const EXISTING_TICKETS_MAX = 4_000;

const HEADING = [
  '## Existing tickets',
  'Check these before you write new tickets. A change one of them already covers (open or done) gets no second ticket: leave it, or name its key in `dependsOn`.',
].join('\n');

/** Open tickets first (the ones being worked on before the waiting ones), done ones last. */
const OPEN_FIRST: Record<string, number> = {
  in_progress: 0,
  review: 1,
  ready: 2,
  backlog: 3,
  done: 4,
};

export interface ExistingTicket {
  key: string;
  title: string;
  /** A TicketStatus as stored. */
  status: string;
}

/** Open tickets first, then done ones, one line each; cut to `max` (whole lines, with a count of the rest). */
export function existingTicketsSection(rows: readonly ExistingTicket[], max = EXISTING_TICKETS_MAX): string {
  if (rows.length === 0) return '';
  const rank = (status: string) => OPEN_FIRST[status] ?? Object.keys(OPEN_FIRST).length;
  const ordered = [...rows].sort((a, b) => rank(a.status) - rank(b.status));
  const lines: string[] = [];
  let size = HEADING.length;
  for (const [i, row] of ordered.entries()) {
    const line = `- ${row.key} [${row.status.replace('_', ' ')}] ${row.title.replace(/\s+/g, ' ').trim()}`;
    const more = `- … and ${ordered.length - i} more`;
    // Room for this line and, unless it is the last, for the "… and N more" line after it.
    const reserve = i === ordered.length - 1 ? 0 : 1 + more.length;
    if (size + 1 + line.length + reserve > max) {
      if (size + 1 + more.length <= max) lines.push(more);
      break;
    }
    lines.push(line);
    size += 1 + line.length;
  }
  return lines.length > 0 ? [HEADING, ...lines].join('\n') : '';
}

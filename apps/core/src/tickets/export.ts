import {
  TICKET_EXPORT_COLUMNS,
  type Ticket,
  type TicketExport,
  type TicketExportRow,
  TicketStatus,
  type TicketStatusCounts,
} from '@emberline/protocol';

export interface ExportProject {
  id: string;
  name: string;
  slug: string;
}

export function statusCounts(tickets: readonly Pick<Ticket, 'status'>[]): TicketStatusCounts {
  const counts: TicketStatusCounts = { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 };
  for (const ticket of tickets) counts[ticket.status] += 1;
  return counts;
}

/**
 * The board as a self-contained document. `tickets` is the whole board (counts cover all of it);
 * `statuses` picks the exported columns, an empty list meaning every column. Rows follow the board:
 * column order, then position inside the column.
 */
export function buildTicketExport(
  project: ExportProject,
  tickets: readonly Ticket[],
  statuses: readonly TicketStatus[],
  now: Date,
): TicketExport {
  const covered = statuses.length > 0 ? [...statuses] : [...TicketStatus.options];
  const keyById = new Map(tickets.map((t) => [t.id, t.key]));
  const column = (status: TicketStatus) => TicketStatus.options.indexOf(status);
  const rows = tickets
    .filter((t) => covered.includes(t.status))
    .sort((a, b) => column(a.status) - column(b.status) || a.position - b.position)
    .map((t): TicketExportRow => ({
      key: t.key,
      title: t.title,
      status: t.status,
      priority: t.priority,
      persona: t.persona,
      depth: t.depth,
      dependsOn: t.dependsOn.map((id) => keyById.get(id) ?? id),
      blockedBy: t.blockedBy.map((b) => b.key),
      completionSummary: t.completion?.summary ?? null,
      completionBlockers: t.completion?.blockers ?? [],
      issueUrl: t.external?.url ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      body: t.body,
    }));
  const counts = statusCounts(tickets);
  return {
    project: { id: project.id, name: project.name, slug: project.slug },
    exportedAt: now.toISOString(),
    statuses: covered,
    counts,
    doneRatio: tickets.length === 0 ? 0 : counts.done / tickets.length,
    tickets: rows,
  };
}

/** Spreadsheet apps run a cell that starts like a formula; a leading quote keeps it text. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | readonly string[]): string {
  const text = value === null ? '' : Array.isArray(value) ? value.join('; ') : String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV (CRLF rows, a header row) with a UTF-8 byte-order mark so Excel reads it as UTF-8. */
export function ticketExportCsv(doc: TicketExport): string {
  const lines = [
    TICKET_EXPORT_COLUMNS.join(','),
    ...doc.tickets.map((row) => TICKET_EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `emberline-<slug>-tickets-<yyyy-mm-dd>.<ext>`. */
export function ticketExportFileName(doc: TicketExport, ext: 'csv' | 'json'): string {
  return `emberline-${doc.project.slug}-tickets-${doc.exportedAt.slice(0, 10)}.${ext}`;
}

import type { Ticket } from '@emberline/protocol';

type Blocker = Ticket['blockedBy'][number];

/** Badge text for a card that waits on other tickets, or undefined when nothing blocks it. */
export function waitingLabel(blockedBy: readonly Blocker[]): string | undefined {
  if (blockedBy.length === 0) return undefined;
  const [only] = blockedBy;
  return blockedBy.length === 1 && only ? `⏳ waiting for ${only.key}` : `⏳ waiting for ${blockedBy.length} tickets`;
}

/** Hover text listing each blocker with its title and status. */
export function waitingTitle(blockedBy: readonly Blocker[]): string {
  return blockedBy.map((b) => `${b.key} ${b.title} (${b.status.replace('_', ' ')})`).join('\n');
}

/**
 * Tickets that may be added as a dependency of `ticket`: not itself, not already a dependency,
 * and not a ticket that (transitively) depends on it, since that would close a cycle.
 */
export function dependencyCandidates(ticket: Ticket, all: readonly Ticket[]): Ticket[] {
  const dependents = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) {
      if (dependents.has(t.id) || t.id === ticket.id) continue;
      if (t.dependsOn.includes(ticket.id) || t.dependsOn.some((d) => dependents.has(d))) {
        dependents.add(t.id);
        grew = true;
      }
    }
  }
  return all.filter((t) => t.id !== ticket.id && !dependents.has(t.id) && !ticket.dependsOn.includes(t.id));
}

/**
 * What dropping `ticket` into In progress does: `start` an agent (auto-start on, nothing running),
 * `confirm` first when it still waits for other tickets (the drawer asks, like its Start button),
 * or just `move` it.
 */
export function dropIntoInProgress(
  ticket: Pick<Ticket, 'status' | 'blockedBy'>,
  opts: { autoStart: boolean; hasLiveRun: boolean },
): 'start' | 'confirm' | 'move' {
  if (ticket.status === 'in_progress' || !opts.autoStart || opts.hasLiveRun) return 'move';
  return ticket.blockedBy.length > 0 ? 'confirm' : 'start';
}

import { type AgentPersona, normalizeTicketRef, type Ticket, type TicketStatus } from '@emberline/protocol';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { ticketDependencies, tickets } from '../db/schema.js';
import { HttpError } from '../errors.js';

/** Default execution tiers: lower tiers run first when a batch states no dependencies. */
export const DEPENDENCY_TIERS: Record<AgentPersona, 0 | 1 | 2> = {
  architect: 0,
  dba: 0,
  coder: 1,
  ui_ux: 1,
  product_owner: 1,
  qa: 2,
  security: 2,
};

export interface BatchTicket {
  id: string;
  key: string;
  persona: AgentPersona;
  ref?: string;
  dependsOn?: string[];
}

/** `ticketId` waits for `dependsOnId`. */
export interface Edge {
  ticketId: string;
  dependsOnId: string;
}

export interface DroppedDependency {
  ticketId: string;
  ref: string;
  reason: 'unknown' | 'self' | 'cycle' | 'duplicate_ref';
}

/** True when adding `candidate` to `edges` would let a ticket (transitively) depend on itself. */
export function wouldCreateCycle(edges: Edge[], candidate: Edge): boolean {
  if (candidate.ticketId === candidate.dependsOnId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.ticketId);
    if (list) list.push(e.dependsOnId);
    else adjacency.set(e.ticketId, [e.dependsOnId]);
  }
  // The candidate closes a cycle when the new dependency already (transitively) depends on the ticket.
  const seen = new Set<string>();
  const stack = [candidate.dependsOnId];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === candidate.ticketId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(adjacency.get(node) ?? []));
  }
  return false;
}

/** Tier 1 waits for tier 0, tier 2 for tier 1 (or tier 0 when tier 1 is absent). A single tier gets no edges. */
export function defaultTierEdges(batch: Pick<BatchTicket, 'id' | 'persona'>[]): Edge[] {
  const byTier: string[][] = [[], [], []];
  for (const ticket of batch) byTier[DEPENDENCY_TIERS[ticket.persona]]?.push(ticket.id);
  const edges: Edge[] = [];
  for (const ticket of batch) {
    const tier = DEPENDENCY_TIERS[ticket.persona];
    if (tier === 0) continue;
    const below = (tier === 2 && (byTier[1]?.length ?? 0) > 0 ? byTier[1] : byTier[0]) ?? [];
    for (const dependsOnId of below) edges.push({ ticketId: ticket.id, dependsOnId });
  }
  return edges;
}

/** Trimmed, lowercased, whitespace collapsed, trailing `.`/`:` removed: the key two drafts or tickets are "the same title" by. */
export function normalizeTicketTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.:]+$/, '')
    .trimEnd();
}

/**
 * Turns a batch's declared refs/keys into edges. Unknown and self references and edges that would
 * close a cycle (also through `existingEdges`) are dropped, as are repeated refs (the first wins);
 * every other edge is kept.
 */
export function resolveBatchDependencies(
  batch: BatchTicket[],
  projectKeys: Map<string, string>,
  existingEdges: Edge[],
): { edges: Edge[]; dropped: DroppedDependency[] } {
  const refs = new Map<string, string>();
  const accepted: Edge[] = [];
  const dropped: DroppedDependency[] = [];
  // Two drafts whose refs normalize alike are indistinguishable as targets: the first keeps the ref.
  for (const ticket of batch) {
    if (!ticket.ref) continue;
    const key = normalizeTicketRef(ticket.ref) ?? ticket.ref.toLowerCase();
    if (refs.has(key)) dropped.push({ ticketId: ticket.id, ref: ticket.ref, reason: 'duplicate_ref' });
    else refs.set(key, ticket.id);
  }
  if (!batch.some((ticket) => (ticket.dependsOn?.length ?? 0) > 0)) {
    return { edges: defaultTierEdges(batch), dropped };
  }
  for (const ticket of batch) {
    for (const ref of ticket.dependsOn ?? []) {
      // A ref the schema rewrote (`brand_assets` → `brand-assets`) is still found under its old spelling.
      const dependsOnId =
        refs.get(ref.toLowerCase()) ??
        refs.get(normalizeTicketRef(ref) ?? '') ??
        projectKeys.get(ref.toUpperCase());
      if (!dependsOnId) {
        dropped.push({ ticketId: ticket.id, ref, reason: 'unknown' });
        continue;
      }
      if (dependsOnId === ticket.id) {
        dropped.push({ ticketId: ticket.id, ref, reason: 'self' });
        continue;
      }
      if (accepted.some((e) => e.ticketId === ticket.id && e.dependsOnId === dependsOnId)) continue;
      const edge = { ticketId: ticket.id, dependsOnId };
      if (wouldCreateCycle([...existingEdges, ...accepted], edge)) {
        dropped.push({ ticketId: ticket.id, ref, reason: 'cycle' });
        continue;
      }
      accepted.push(edge);
    }
  }
  // Everything declared was unusable: the batch is as good as undeclared, so use the default tiers.
  if (accepted.length === 0) return { edges: defaultTierEdges(batch), dropped };
  return { edges: accepted, dropped };
}

/** A ticket's dependencies: every ticket it waits for, and those of them not `done` yet. */
export interface TicketDependencies {
  dependsOn: string[];
  blockedBy: Ticket['blockedBy'];
}

/** Dependencies of the given tickets with one query; `blockedBy` holds those not yet `done`. */
export function loadDependencies(db: Db, ids: string[]): Map<string, TicketDependencies> {
  const result = new Map<string, TicketDependencies>();
  for (const id of ids) result.set(id, { dependsOn: [], blockedBy: [] });
  if (ids.length === 0) return result;
  const rows = db
    .select({
      ticketId: ticketDependencies.ticketId,
      id: tickets.id,
      key: tickets.key,
      title: tickets.title,
      status: tickets.status,
    })
    .from(ticketDependencies)
    .innerJoin(tickets, eq(tickets.id, ticketDependencies.dependsOnId))
    .where(inArray(ticketDependencies.ticketId, ids))
    .orderBy(asc(ticketDependencies.createdAt), asc(tickets.number))
    .all();
  for (const r of rows) {
    const entry = result.get(r.ticketId);
    if (!entry) continue;
    entry.dependsOn.push(r.id);
    if (r.status !== 'done') {
      entry.blockedBy.push({ id: r.id, key: r.key, title: r.title, status: r.status as TicketStatus });
    }
  }
  return result;
}

/** Every dependency edge between the project's tickets. */
export function projectEdges(db: Db, projectId: string): Edge[] {
  return db
    .select({ ticketId: ticketDependencies.ticketId, dependsOnId: ticketDependencies.dependsOnId })
    .from(ticketDependencies)
    .innerJoin(tickets, eq(tickets.id, ticketDependencies.ticketId))
    .where(eq(tickets.projectId, projectId))
    .all();
}

/** The tickets that wait for `id`. */
export function dependentIds(db: Db, id: string): string[] {
  return db
    .select({ ticketId: ticketDependencies.ticketId })
    .from(ticketDependencies)
    .where(eq(ticketDependencies.dependsOnId, id))
    .all()
    .map((r) => r.ticketId);
}

/** Of `ids`, those blocked in `before` that nothing blocks any more. */
export function unblockedSince(
  db: Db,
  ids: string[],
  before: ReadonlyMap<string, Pick<TicketDependencies, 'blockedBy'>>,
): string[] {
  const after = loadDependencies(db, ids);
  return ids.filter(
    (id) => (before.get(id)?.blockedBy.length ?? 0) > 0 && after.get(id)?.blockedBy.length === 0,
  );
}

/**
 * Replaces a ticket's dependency set with the tickets `refs` name (ids or keys of the project);
 * validates everything (unknown refs: 400, cycles: 409) before writing anything.
 */
export function replaceDependencies(
  db: Db,
  current: { id: string; projectId: string },
  refs: string[],
): void {
  const siblings = db.select().from(tickets).where(eq(tickets.projectId, current.projectId)).all();
  const ids = new Set<string>();
  for (const ref of refs) {
    const hit =
      siblings.find((t) => t.id === ref) ?? siblings.find((t) => t.key.toUpperCase() === ref.toUpperCase());
    if (!hit) throw new HttpError(400, 'unknown_dependency', `no ticket "${ref}" in this project`);
    ids.add(hit.id);
  }
  const others = projectEdges(db, current.projectId).filter((e) => e.ticketId !== current.id);
  const accepted: Edge[] = [];
  for (const dependsOnId of ids) {
    const edge = { ticketId: current.id, dependsOnId };
    if (wouldCreateCycle([...others, ...accepted], edge)) {
      throw new HttpError(
        409,
        'dependency_cycle',
        'a ticket cannot depend on itself, directly or through other tickets',
      );
    }
    accepted.push(edge);
  }
  const now = new Date();
  db.transaction((tx) => {
    tx.delete(ticketDependencies).where(eq(ticketDependencies.ticketId, current.id)).run();
    if (accepted.length > 0) {
      tx.insert(ticketDependencies)
        .values(accepted.map((e) => ({ ...e, createdAt: now })))
        .run();
    }
  });
}

/** A ticket an agent's tickets file created, with the draft's declared ref and dependencies. */
export interface CreatedDraft {
  draft: { ref?: string; dependsOn?: string[] };
  ticket: Pick<Ticket, 'id' | 'key' | 'persona'>;
}

/** What {@link storeDraftDependencies} stored and dropped, with the project's keys to name them by. */
export interface StoredDraftDependencies {
  edges: Edge[];
  dropped: DroppedDependency[];
  keyById: Map<string, string>;
}

/**
 * Resolves a batch's refs/keys (or the default tiers) against the project and stores the edges.
 * The project's keys include the batch's own tickets: a skipped draft's dependents point at an
 * earlier draft's key.
 */
export function storeDraftDependencies(
  db: Db,
  projectId: string,
  created: readonly CreatedDraft[],
): StoredDraftDependencies {
  const projectKeys = new Map<string, string>();
  for (const r of db
    .select({ id: tickets.id, key: tickets.key })
    .from(tickets)
    .where(eq(tickets.projectId, projectId))
    .all()) {
    projectKeys.set(r.key.toUpperCase(), r.id);
  }
  const { edges, dropped } = resolveBatchDependencies(
    created.map(({ draft, ticket }) => ({
      id: ticket.id,
      key: ticket.key,
      persona: ticket.persona,
      ...(draft.ref ? { ref: draft.ref } : {}),
      ...(draft.dependsOn ? { dependsOn: draft.dependsOn } : {}),
    })),
    projectKeys,
    projectEdges(db, projectId),
  );
  if (edges.length > 0) {
    const now = new Date();
    db.insert(ticketDependencies)
      .values(edges.map((e) => ({ ticketId: e.ticketId, dependsOnId: e.dependsOnId, createdAt: now })))
      .onConflictDoNothing()
      .run();
  }
  const keyById = new Map<string, string>(created.map((c) => [c.ticket.id, c.ticket.key]));
  for (const r of db
    .select({ id: tickets.id, key: tickets.key })
    .from(tickets)
    .where(eq(tickets.projectId, projectId))
    .all()) {
    keyById.set(r.id, r.key);
  }
  return { edges, dropped, keyById };
}

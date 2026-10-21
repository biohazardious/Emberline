import { type AgentPersona, normalizeTicketRef } from '@emberline/protocol';

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
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.:]+$/, '').trimEnd();
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
        refs.get(ref.toLowerCase()) ?? refs.get(normalizeTicketRef(ref) ?? '') ?? projectKeys.get(ref.toUpperCase());
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

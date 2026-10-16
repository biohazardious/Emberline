import type { AgentPersona } from '@emberline/protocol';

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
  reason: 'unknown' | 'self' | 'cycle';
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

/**
 * Turns a batch's declared refs/keys into edges. Unknown and self references and edges that would
 * close a cycle (also through `existingEdges`) are dropped; every other edge is kept.
 */
export function resolveBatchDependencies(
  batch: BatchTicket[],
  projectKeys: Map<string, string>,
  existingEdges: Edge[],
): { edges: Edge[]; dropped: DroppedDependency[] } {
  if (!batch.some((ticket) => (ticket.dependsOn?.length ?? 0) > 0)) {
    return { edges: defaultTierEdges(batch), dropped: [] };
  }
  const refs = new Map<string, string>();
  for (const ticket of batch) if (ticket.ref) refs.set(ticket.ref.toLowerCase(), ticket.id);

  const accepted: Edge[] = [];
  const dropped: DroppedDependency[] = [];
  for (const ticket of batch) {
    for (const ref of ticket.dependsOn ?? []) {
      const dependsOnId = refs.get(ref.toLowerCase()) ?? projectKeys.get(ref.toUpperCase());
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
  return { edges: accepted, dropped };
}

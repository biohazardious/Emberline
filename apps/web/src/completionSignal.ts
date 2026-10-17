import type { RunEvent } from '@emberline/protocol';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

/** The text under a completion-signal event in the run timeline: its summary and the blockers it raised. */
export function completionEventText(type: string, payload: unknown): string | undefined {
  if (type !== 'ticket_complete' && type !== 'completion_blocked') return undefined;
  const rec = (payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (type === 'ticket_complete' && typeof rec.summary === 'string' && rec.summary) parts.push(rec.summary);
  const blockers = strings(rec.blockers);
  if (blockers.length > 0) parts.push(`Blockers:\n${blockers.map((b) => `- ${b}`).join('\n')}`);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** The blockers of the run's latest `ticket_complete` signal (empty when none or none were raised). */
export function latestCompletionBlockers(events: RunEvent[]): string[] {
  let latest: RunEvent | undefined;
  for (const e of events) if (e.type === 'ticket_complete' && (!latest || e.id > latest.id)) latest = e;
  return latest ? strings((latest.payload as Record<string, unknown> | null)?.blockers) : [];
}

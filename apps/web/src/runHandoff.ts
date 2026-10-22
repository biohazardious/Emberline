import type { Run } from '@emberline/protocol';

/**
 * The runs list right after `predecessor` was handed off to `successor`, so the views update before
 * the event stream does. The stream may already have delivered both runs while the request was in
 * flight: entries it updated are newer than the copies held by the caller and are kept as they are.
 */
export function withHandoff(list: Run[], predecessor: Run, successor: Run, now = new Date()): Run[] {
  const current = list.find((r) => r.id === predecessor.id) ?? predecessor;
  const ended: Run = current.handedOffTo
    ? current
    : {
        ...current,
        state: 'done',
        handedOffTo: successor.id,
        endedAt: current.endedAt ?? now.toISOString(),
        resumable: false,
      };
  const next = list.map((r) => (r.id === ended.id ? ended : r));
  if (!next.some((r) => r.id === ended.id)) next.unshift(ended);
  return next.some((r) => r.id === successor.id) ? next : [successor, ...next];
}

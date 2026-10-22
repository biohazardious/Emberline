import type { Run } from '@emberline/protocol';
import { dismissable, pendingAttention, pruneSeen, type SeenMap } from '../attention';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const SEEN_KEY = 'emberline.attention.seen';
const BASE_TITLE = 'Emberline';

/** Short sentence for a desktop notification title. */
export function attentionReason(run: Run): string {
  switch (run.attention?.reason) {
    case 'permission':
      return 'needs your permission';
    case 'question':
      return 'needs your input';
    case 'blocked':
      return 'is blocked';
    case 'held':
      return 'is held for you';
    case 'stalled':
      return 'looks stalled';
    case 'rate_limited':
      return 'hit a usage limit';
    default:
      return 'failed';
  }
}

function readSeen(): SeenMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>;
    // The old format keyed by run id with a state timestamp string: those entries match no occurrence.
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'number'),
    ) as SeenMap;
  } catch {
    return {};
  }
}

function writeSeen(seen: SeenMap): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable: acknowledgements last for this page only.
  }
}

/** True when the browser can show desktop notifications (secure contexts only: HTTPS or localhost). */
export const notificationsSupported = () => typeof Notification !== 'undefined' && window.isSecureContext;

/**
 * Runs that need the user (server-computed `run.attention`), oldest first, minus the failures and
 * rate limits already dismissed. Keeps the tab title and favicon badge in sync and raises a desktop
 * notification when a run newly needs attention while the tab is in the background.
 */
export function useAttention(
  runs: Run[] | undefined,
  onOpen: (run: Run) => void,
): { items: Run[]; count: number; seen: SeenMap; dismiss: (run: Run) => void } {
  const [seen, setSeen] = useState<SeenMap>(readSeen);
  const items = useMemo(() => pendingAttention(runs ?? [], seen), [runs, seen]);

  const dismiss = useCallback((run: Run) => {
    const attention = run.attention;
    if (!attention || !dismissable(attention.reason)) return;
    setSeen((prev) => {
      const next = { ...prev, [attention.occurrence]: Date.now() };
      writeSeen(next);
      return next;
    });
  }, []);

  // Forget acknowledgements of occurrences that are gone (only once runs have loaded).
  useEffect(() => {
    if (!runs) return;
    setSeen((prev) => {
      const next = pruneSeen(prev, runs);
      if (Object.keys(next).length === Object.keys(prev).length) return prev;
      writeSeen(next);
      return next;
    });
  }, [runs]);

  const count = items.length;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    setFaviconBadge(count > 0);
  }, [count]);

  // Desktop notifications for runs that just gained an attention occurrence.
  const known = useRef<Set<string> | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!runs) return;
    const previous = known.current;
    known.current = new Set(runs.flatMap((run) => (run.attention ? [run.attention.occurrence] : [])));
    if (!previous || !notificationsSupported() || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    for (const run of runs) {
      const attention = run.attention;
      if (!attention || previous.has(attention.occurrence) || seen[attention.occurrence] !== undefined)
        continue;
      const note = new Notification(`${run.title ?? 'Agent run'} ${attentionReason(run)}`, {
        body:
          attention.reason === 'failed'
            ? 'Open Emberline to see what went wrong.'
            : 'Open Emberline to respond.',
        tag: run.id,
        icon: '/favicon.svg',
      });
      note.onclick = () => {
        window.focus();
        openRef.current(run);
        note.close();
      };
    }
    // `seen` only gates dismissed occurrences; the effect must run on new runs, not on dismissals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  return { items, count, seen, dismiss };
}

let originalIcon: string | null = null;
let badgedIcon: string | null = null;

/** Adds (or removes) a dot on the SVG favicon. */
function setFaviconBadge(on: boolean): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  originalIcon ??= link.href;
  if (!on) {
    link.href = originalIcon;
    return;
  }
  if (badgedIcon) {
    link.href = badgedIcon;
    return;
  }
  void fetch(originalIcon)
    .then((res) => res.text())
    .then((svg) => {
      const dot = '<circle cx="80%" cy="20%" r="20%" fill="#ef4444" stroke="#fff" stroke-width="3%"/>';
      badgedIcon = `data:image/svg+xml,${encodeURIComponent(svg.replace(/<\/svg>\s*$/, `${dot}</svg>`))}`;
      link.href = badgedIcon;
    })
    .catch(() => undefined);
}

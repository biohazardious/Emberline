import type { Run } from '@emberline/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const SEEN_KEY = 'emberline.attention.seen';
/** Failures older than this are history, not something to act on. */
const FAILED_RECENT_MS = 24 * 60 * 60_000;
const BASE_TITLE = 'Emberline';

/** States in which a run needs a human: an answer, a fix, or awareness of a paused quota. */
export function needsAttention(run: Run, now = Date.now()): boolean {
  // A fresh session reports waiting_input until its first prompt lands: not a person's turn yet.
  if (run.state === 'waiting_input') return run.lastEvent !== 'SessionStart';
  if (run.state === 'rate_limited') return true;
  if (run.state === 'failed' && !run.cancelled)
    return now - Date.parse(run.stateChangedAt) < FAILED_RECENT_MS;
  return false;
}

export function attentionReason(run: Run): string {
  if (run.state === 'waiting_input') return 'needs your input';
  if (run.state === 'rate_limited') return 'hit a usage limit';
  return 'failed';
}

function readSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable: acknowledgements last for this page only.
  }
}

/** True when the browser can show desktop notifications (secure contexts only: HTTPS or localhost). */
export const notificationsSupported = () => typeof Notification !== 'undefined' && window.isSecureContext;

/**
 * Runs that need the user, oldest first, minus the ones already acknowledged in their current
 * state. Keeps the tab title and favicon badge in sync and raises a desktop notification when a
 * run newly needs attention while the tab is in the background.
 */
export function useAttention(
  runs: Run[] | undefined,
  onOpen: (run: Run) => void,
): { items: Run[]; acknowledge: (run: Run) => void } {
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  const items = useMemo(
    () =>
      (runs ?? [])
        .filter((run) => needsAttention(run) && seen[run.id] !== run.stateChangedAt)
        .sort((a, b) => Date.parse(a.stateChangedAt) - Date.parse(b.stateChangedAt)),
    [runs, seen],
  );

  const acknowledge = useCallback((run: Run) => {
    setSeen((prev) => {
      // Drop entries for runs that changed state since; keeps the map small.
      const next = { ...prev, [run.id]: run.stateChangedAt };
      writeSeen(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.title = items.length > 0 ? `(${items.length}) ${BASE_TITLE}` : BASE_TITLE;
    setFaviconBadge(items.length > 0);
  }, [items.length]);

  // Desktop notifications for runs that just entered an attention state.
  const known = useRef<Map<string, string> | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!runs) return;
    const previous = known.current;
    known.current = new Map(runs.map((run) => [run.id, `${run.state}@${run.stateChangedAt}`]));
    if (!previous || !notificationsSupported() || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    for (const run of runs) {
      if (!needsAttention(run) || previous.get(run.id) === `${run.state}@${run.stateChangedAt}`) continue;
      const note = new Notification(`${run.title ?? 'Agent run'} ${attentionReason(run)}`, {
        body:
          run.state === 'failed' ? 'Open Emberline to see what went wrong.' : 'Open Emberline to respond.',
        tag: run.id,
        icon: '/favicon.svg',
      });
      note.onclick = () => {
        window.focus();
        openRef.current(run);
        note.close();
      };
    }
  }, [runs]);

  return { items, acknowledge };
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

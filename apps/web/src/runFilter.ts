import type { Run, RunAttentionReason } from '@emberline/protocol';
import { ATTENTION_ORDER, attentionDetail } from './attention';

export const DASHBOARD_RUN_CATEGORIES = [
  'all',
  'live',
  'working',
  'attention',
  'queued',
  'done',
  'failed',
] as const;

export type DashboardRunCategory = (typeof DASHBOARD_RUN_CATEGORIES)[number];

export const DASHBOARD_CATEGORY_LABELS: Record<DashboardRunCategory, string> = {
  all: 'All',
  live: 'Active & Waiting',
  working: 'Working',
  attention: 'Needs Input',
  queued: 'Queued / Paused',
  done: 'Completed',
  failed: 'Failed',
};

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every search term appears in the run's title, prompt, branch, provider, persona, or extra context. */
export function runMatchesQuery(run: Run, query: string, extraContext = ''): boolean {
  const words = queryTerms(query);
  if (words.length === 0) return true;
  const haystack = [
    run.title ?? '',
    run.prompt,
    run.branch ?? '',
    run.agent,
    run.persona,
    run.state,
    run.lastEvent ?? '',
    run.model ?? '',
    extraContext,
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function runMatchesCategory(run: Run, category: DashboardRunCategory): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'live':
      return !run.endedAt && run.state !== 'done' && run.state !== 'failed';
    case 'working':
      return run.state === 'starting' || run.state === 'working';
    case 'attention':
      return run.state === 'waiting_input' || Boolean(run.attention);
    case 'queued':
      return run.state === 'queued' || run.state === 'rate_limited';
    case 'done':
      return run.state === 'done';
    case 'failed':
      return run.state === 'failed';
  }
}

export function filterDashboardRuns(
  runs: readonly Run[],
  filter: { category: DashboardRunCategory; query: string },
  projectNameOf?: (projectId: string | null) => string | undefined,
): Run[] {
  return runs.filter(
    (run) =>
      runMatchesCategory(run, filter.category) &&
      runMatchesQuery(run, filter.query, projectNameOf?.(run.projectId) ?? ''),
  );
}

export function countDashboardRunCategories(runs: readonly Run[]): Record<DashboardRunCategory, number> {
  const counts: Record<DashboardRunCategory, number> = {
    all: runs.length,
    live: 0,
    working: 0,
    attention: 0,
    queued: 0,
    done: 0,
    failed: 0,
  };
  for (const run of runs) {
    if (runMatchesCategory(run, 'live')) counts.live += 1;
    if (runMatchesCategory(run, 'working')) counts.working += 1;
    if (runMatchesCategory(run, 'attention')) counts.attention += 1;
    if (runMatchesCategory(run, 'queued')) counts.queued += 1;
    if (runMatchesCategory(run, 'done')) counts.done += 1;
    if (runMatchesCategory(run, 'failed')) counts.failed += 1;
  }
  return counts;
}

export interface InboxFilter {
  query: string;
  reasons: RunAttentionReason[];
}

export const EMPTY_INBOX_FILTER: InboxFilter = {
  query: '',
  reasons: [],
};

export function isInboxFilterActive(filter: InboxFilter): boolean {
  return filter.query.trim() !== '' || filter.reasons.length > 0;
}

export function filterInboxRuns(
  runs: readonly Run[],
  filter: InboxFilter,
  contextOf?: (run: Run) => string,
): Run[] {
  if (!isInboxFilterActive(filter)) return [...runs];
  return runs.filter((run) => {
    const reason = run.attention?.reason;
    if (filter.reasons.length > 0 && (!reason || !filter.reasons.includes(reason))) return false;
    const detail = run.attention ? (attentionDetail(run.attention) ?? '') : '';
    const extra = [detail, reason ?? '', contextOf ? contextOf(run) : ''].join(' ');
    return runMatchesQuery(run, filter.query, extra);
  });
}

export function countInboxReasons(runs: readonly Run[]): Record<RunAttentionReason, number> {
  const counts = Object.fromEntries(ATTENTION_ORDER.map((r) => [r, 0])) as Record<RunAttentionReason, number>;
  for (const run of runs) {
    if (run.attention) counts[run.attention.reason] += 1;
  }
  return counts;
}

import type { Run } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './components/ErrorBoundary';
import {
  countDashboardRunCategories,
  countInboxReasons,
  EMPTY_INBOX_FILTER,
  filterDashboardRuns,
  filterInboxRuns,
  runMatchesCategory,
  runMatchesQuery,
} from './runFilter';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    projectId: 'p1',
    ticketId: 't1',
    title: 'EMB-19 Dashboard UX',
    agent: 'claude',
    persona: 'ui_ux',
    state: 'working',
    prompt: 'Add search and filter controls',
    permissionMode: 'default',
    branch: 'emberline/emb-19',
    worktreePath: '/workspaces/.worktrees/p1/r1',
    terminalId: 'term-1',
    agentSessionId: null,
    lastEvent: 'tool_use',
    stateChangedAt: '2026-11-12T00:05:00.000Z',
    createdAt: '2026-11-12T00:01:00.000Z',
    endedAt: null,
    resumable: false,
    cancelled: false,
    attention: null,
    reviewReady: false,
    ...overrides,
  } as Run;
}

describe('runFilter', () => {
  const rWorking = makeRun({ id: 'r1', state: 'working', agent: 'claude', title: 'EMB-10 Auth' });
  const rInput = makeRun({
    id: 'r2',
    state: 'waiting_input',
    agent: 'codex',
    title: 'EMB-11 Schema',
    attention: {
      reason: 'permission',
      detail: 'Run migrations on sqlite',
      since: '2026-11-12T00:10:00.000Z',
      occurrence: 'r2:perm:1',
    },
  });
  const rQueued = makeRun({ id: 'r3', state: 'rate_limited', title: 'EMB-12 Api' });
  const rDone = makeRun({
    id: 'r4',
    state: 'done',
    endedAt: '2026-11-12T01:00:00.000Z',
    title: 'EMB-13 CSS',
  });
  const rFailed = makeRun({
    id: 'r5',
    state: 'failed',
    endedAt: '2026-11-12T01:00:00.000Z',
    title: 'EMB-14 Build',
    attention: {
      reason: 'failed',
      detail: 'Exit code 1',
      since: '2026-11-12T01:00:00.000Z',
      occurrence: 'r5:fail:1',
    },
  });

  const all = [rWorking, rInput, rQueued, rDone, rFailed];

  it('categorizes and counts runs across all dashboard buckets', () => {
    expect(countDashboardRunCategories(all)).toEqual({
      all: 5,
      live: 3,
      working: 1,
      attention: 2,
      queued: 1,
      done: 1,
      failed: 1,
    });
    expect(runMatchesCategory(rQueued, 'queued')).toBe(true);
    expect(runMatchesCategory(rDone, 'live')).toBe(false);
  });

  it('filters dashboard runs by category, multi-term search, and project name', () => {
    expect(runMatchesQuery(rInput, 'codex emb-11', 'Acme Cloud')).toBe(true);
    expect(runMatchesQuery(rInput, 'acme emb-11', 'Acme Cloud')).toBe(true);
    expect(runMatchesQuery(rInput, 'acme unknown', 'Acme Cloud')).toBe(false);

    const matched = filterDashboardRuns(
      all,
      { category: 'attention', query: 'schema' },
      () => 'Emberline Web',
    );
    expect(matched.map((r) => r.id)).toEqual(['r2']);
  });

  it('filters inbox runs by attention reason and detail text', () => {
    const inboxRuns = [rInput, rFailed];
    const counts = countInboxReasons(inboxRuns);
    expect(counts.permission).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.question).toBe(0);

    expect(filterInboxRuns(inboxRuns, EMPTY_INBOX_FILTER)).toHaveLength(2);
    expect(filterInboxRuns(inboxRuns, { query: '', reasons: ['permission'] }).map((r) => r.id)).toEqual([
      'r2',
    ]);
    expect(filterInboxRuns(inboxRuns, { query: 'sqlite', reasons: [] }).map((r) => r.id)).toEqual(['r2']);
  });

  it('identifies lazy chunk load errors accurately', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/BoardPage.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});

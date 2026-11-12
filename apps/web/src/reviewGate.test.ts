import type { ReviewComment, RunReviewState, SlopAuditReport } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { buildMergeGateSummary } from './reviewGate';

function makeComment(overrides: Partial<ReviewComment> & { id: string; filePath: string }): ReviewComment {
  return {
    runId: 'r1',
    round: 1,
    line: 14,
    currentLine: 14,
    outdated: false,
    anchorText: null,
    anchorHash: 'h',
    verifiedAt: null,
    side: 'modified',
    body: 'Null check missing before dereferencing session',
    intent: 'fix',
    priority: 'blocking',
    status: 'open',
    createdAt: '2026-11-12T06:00:00.000Z',
    sentAt: null,
    resolvedAt: null,
    carriedTo: null,
    ...overrides,
  };
}

function makeReviewState(overrides: Partial<RunReviewState> = {}): RunReviewState {
  return {
    comments: [],
    viewed: [],
    blockingOpen: 0,
    carriedBlocking: null,
    ...overrides,
  };
}

describe('buildMergeGateSummary', () => {
  it('reports an open/ready merge gate when there are zero blocking reasons', () => {
    const gate = buildMergeGateSummary({
      review: makeReviewState({
        comments: [makeComment({ id: 'c-imp', filePath: 'src/a.ts', priority: 'important' })],
        blockingOpen: 0,
      }),
      run: { id: 'r1', attention: null, reviewReady: true, predecessorRunId: null },
      orderedDiffPaths: ['src/a.ts'],
    });

    expect(gate.loaded).toBe(true);
    expect(gate.isBlocked).toBe(false);
    expect(gate.blockingOpen).toBe(0);
    expect(gate.blockingComments).toHaveLength(0);
  });

  it('orders blocking comments by diff tree order with anchor links and marks off-diff comments', () => {
    const cB = makeComment({
      id: 'blk-b',
      filePath: 'src/b.ts',
      currentLine: 48,
      body: 'Race condition when cancelling active stream',
    });
    const cA = makeComment({
      id: 'blk-a',
      filePath: 'src/a.ts',
      line: null,
      currentLine: null,
      body: 'Missing schema validation on request payload',
    });
    const cOff = makeComment({
      id: 'blk-off',
      filePath: 'src/deleted.ts',
      currentLine: 9,
      status: 'sent',
      body: 'Still failing integration check',
    });
    const cResolved = makeComment({
      id: 'blk-resolved',
      filePath: 'src/a.ts',
      status: 'resolved',
    });

    const gate = buildMergeGateSummary({
      review: makeReviewState({
        comments: [cB, cOff, cA, cResolved],
        blockingOpen: 3,
      }),
      run: { id: 'r1', attention: null, reviewReady: false, predecessorRunId: null },
      orderedDiffPaths: ['src/a.ts', 'src/b.ts'],
    });

    expect(gate.isBlocked).toBe(true);
    expect(gate.blockingOpen).toBe(3);
    expect(gate.headline).toContain('3 blocking comments are open');
    expect(gate.blockingComments.map((c) => c.id)).toEqual(['blk-a', 'blk-b', 'blk-off']);
    expect(gate.blockingComments[0]).toMatchObject({
      id: 'blk-a',
      href: '#review-comment-blk-a',
      filePath: 'src/a.ts',
      location: 'Whole file',
      inDiff: true,
    });
    expect(gate.blockingComments[1]).toMatchObject({
      id: 'blk-b',
      href: '#review-comment-blk-b',
      filePath: 'src/b.ts',
      location: 'L48',
      inDiff: true,
    });
    expect(gate.blockingComments[2]).toMatchObject({
      id: 'blk-off',
      href: '#review-comment-blk-off',
      inDiff: false,
    });
  });

  it('surfaces carried blocking comments, predecessor handoff counts, and pipeline/secret holds', () => {
    const slopAudit: SlopAuditReport = {
      runId: 'r1',
      workspacePath: '/tmp/wt',
      score: 60,
      grade: 'D',
      passed: false,
      secretLeakCount: 1,
      secretGuardPassed: false,
      filesAudited: 2,
      addedLinesAudited: 20,
      errorCount: 1,
      warningCount: 0,
      issues: [],
      autoFixPrompt: null,
      auditedAt: '2026-11-12T06:00:00.000Z',
    };

    const gate = buildMergeGateSummary({
      review: makeReviewState({
        comments: [],
        blockingOpen: 2,
        carriedBlocking: { count: 1, fromRun: 'run-prev-9999' },
      }),
      run: {
        id: 'r1',
        attention: {
          reason: 'held',
          since: '2026-11-12T06:00:00.000Z',
          detail: 'CI test suite failed',
          occurrence: 'r1:held:1',
        },
        reviewReady: false,
        predecessorRunId: 'run-pred-1234',
      },
      orderedDiffPaths: [],
      slopAudit,
    });

    expect(gate.isBlocked).toBe(true);
    expect(gate.predecessorBlocking).toEqual({ count: 1, predecessorRunId: 'run-pred-1234' });
    expect(gate.carriedBlocking).toMatchObject({
      count: 1,
      fromRun: 'run-prev-9999',
    });
    expect(gate.holdReasons.map((h) => h.label)).toEqual(['Pipeline hold', 'Secret guard']);
  });
});

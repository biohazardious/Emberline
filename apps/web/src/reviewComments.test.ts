import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '@emberline/protocol';
import { ApiRequestError } from './api';
import {
  blockingCount,
  blockingMessage,
  reviewBlockedCount,
  commentActions,
  commentBadges,
  commentLocation,
  fileCommentCounts,
  groupByPriority,
  requestableComments,
  requestSummary,
  viewedState,
} from './reviewComments';

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    runId: 'r1',
    filePath: 'a.ts',
    line: 3,
    side: 'modified',
    body: 'Fix it',
    intent: 'fix',
    priority: 'important',
    anchorText: 'const x = 1;',
    anchorHash: 'h',
    round: 0,
    verifiedAt: null,
    carriedTo: null,
    currentLine: 3,
    outdated: false,
    status: 'open',
    createdAt: '2026-10-18T00:00:00Z',
    sentAt: null,
    resolvedAt: null,
    ...over,
  };
}

describe('groupByPriority', () => {
  it('orders blocking, important, suggestion and drops empty groups', () => {
    const groups = groupByPriority([
      comment({ id: 'a', priority: 'suggestion' }),
      comment({ id: 'b', priority: 'blocking' }),
      comment({ id: 'c', priority: 'suggestion' }),
    ]);
    expect(groups.map((g) => [g.priority, g.label, g.comments.map((c) => c.id)])).toEqual([
      ['blocking', 'Blocking', ['b']],
      ['suggestion', 'Suggestions', ['a', 'c']],
    ]);
  });
});

describe('commentBadges', () => {
  it('names intent and priority', () => {
    expect(commentBadges(comment({ intent: 'question', priority: 'blocking' }))).toEqual({
      intent: 'Question',
      priority: 'Blocking',
    });
  });
});

describe('commentLocation', () => {
  it('shows the current line, the whole file, or the old line when outdated', () => {
    expect(commentLocation(comment({ line: 3, currentLine: 8 }))).toBe('L8');
    expect(commentLocation(comment({ line: null, currentLine: null }))).toBe('Whole file');
    expect(commentLocation(comment({ line: 3, currentLine: null, outdated: true }))).toBe('Outdated (was L3)');
  });
});

describe('commentActions', () => {
  it('maps status to the actions a person can take', () => {
    expect(commentActions(comment({ status: 'open' }))).toEqual(['delete']);
    expect(commentActions(comment({ status: 'sent' }))).toEqual(['resolve']);
    expect(commentActions(comment({ status: 'addressed' }))).toEqual(['verify', 'notDone']);
    expect(commentActions(comment({ status: 'resolved' }))).toEqual([]);
  });
});

describe('blocking and counts', () => {
  const list = [
    comment({ id: 'a', priority: 'blocking', status: 'open' }),
    comment({ id: 'b', priority: 'blocking', status: 'addressed', outdated: true, currentLine: null }),
    comment({ id: 'c', priority: 'blocking', status: 'resolved' }),
    comment({ id: 'd', priority: 'suggestion', status: 'sent', filePath: 'b.ts' }),
  ];
  it('counts unresolved blocking comments, outdated included', () => {
    expect(blockingCount(list)).toBe(2);
  });
  it('counts open and blocking per file', () => {
    expect(fileCommentCounts(list, 'a.ts')).toEqual({ open: 2, blocking: 2 });
    expect(fileCommentCounts(list, 'b.ts')).toEqual({ open: 1, blocking: 0 });
    expect(fileCommentCounts(list, 'none.ts')).toEqual({ open: 0, blocking: 0 });
  });
});

describe('request changes', () => {
  const list = [
    comment({ id: 'a', status: 'open', priority: 'blocking' }),
    comment({ id: 'b', status: 'addressed', priority: 'important' }),
    comment({ id: 'c', status: 'sent' }),
    comment({ id: 'd', status: 'resolved' }),
    comment({ id: 'e', status: 'open', priority: 'important' }),
  ];
  it('sends open and still-pinned addressed comments', () => {
    expect(requestableComments(list).map((c) => c.id)).toEqual(['a', 'b', 'e']);
  });
  it('summarises by priority', () => {
    expect(requestSummary(requestableComments(list))).toBe('1 blocking, 2 important');
    expect(requestSummary([])).toBe('No comments to send');
    expect(requestSummary([comment({ priority: 'suggestion' })])).toBe('1 suggestion');
  });
});

describe('viewedState', () => {
  it('compares the stored signature with the file hash', () => {
    expect(viewedState(undefined, 'h1')).toBe('unviewed');
    expect(viewedState('h1', 'h1')).toBe('viewed');
    expect(viewedState('h0', 'h1')).toBe('changed');
  });
});

describe('merge gate errors', () => {
  it('reads the blocking count from a review_blocked 409', () => {
    const blocked = new ApiRequestError(409, 'review_blocked', 'x', { blocking: 2 });
    expect(reviewBlockedCount(blocked)).toBe(2);
  });
  it('ignores every other error', () => {
    expect(reviewBlockedCount(new ApiRequestError(409, 'conflict', 'x', { blocking: 2 }))).toBeNull();
    expect(reviewBlockedCount(new ApiRequestError(500, 'review_blocked', 'x', { blocking: 2 }))).toBeNull();
    expect(reviewBlockedCount(new ApiRequestError(409, 'review_blocked', 'x'))).toBeNull();
    expect(reviewBlockedCount(new Error('boom'))).toBeNull();
  });
  it('words the count', () => {
    expect(blockingMessage(1)).toBe('1 blocking comment is open');
    expect(blockingMessage(3)).toBe('3 blocking comments are open');
  });
});

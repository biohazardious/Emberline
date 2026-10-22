import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '@emberline/protocol';
import { ApiRequestError } from './api';
import {
  blockingBanner,
  blockingMessage,
  carriedMessage,
  commentsOffDiff,
  escapeDraft,
  glyphHoverText,
  mergeNowFailure,
  requestTargets,
  reviewBlockedCount,
  worktreeMissing,
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
    expect(commentLocation(comment({ line: 3, currentLine: null, outdated: true }))).toBe(
      'Outdated (was L3)',
    );
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
  it('takes the blocking count from the server, apart from what a new run carried', () => {
    expect(blockingBanner({ blockingOpen: 3, carriedBlocking: null })).toEqual({
      comments: 3,
      carried: null,
    });
    expect(blockingBanner({ blockingOpen: 3, carriedBlocking: { count: 2, fromRun: 'r0' } })).toEqual({
      comments: 1,
      carried: { count: 2, fromRun: 'r0' },
    });
    expect(blockingBanner(undefined)).toEqual({ comments: 0, carried: null });
    expect(carriedMessage(1)).toBe(
      "This run carries 1 blocking item from the previous attempt — check it's done",
    );
    expect(carriedMessage(2)).toBe(
      "This run carries 2 blocking items from the previous attempt — check they're done",
    );
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
    const h0 = '0'.repeat(40);
    const h1 = '1'.repeat(40);
    expect(viewedState(undefined, h1)).toBe('unviewed');
    expect(viewedState(h1, h1)).toBe('viewed');
    expect(viewedState(h0, h1)).toBe('changed');
  });
  it('treats a legacy status:adds:dels signature as unviewed, not changed', () => {
    const hash = 'a'.repeat(40);
    expect(viewedState('modified:3:1', hash)).toBe('unviewed');
    expect(viewedState('untracked:12:0', hash)).toBe('unviewed');
    expect(viewedState('b'.repeat(40), hash)).toBe('changed');
    expect(viewedState(`link:${'c'.repeat(40)}`, hash)).toBe('changed');
    expect(viewedState(`deleted:${'d'.repeat(40)}`, `deleted:${'d'.repeat(40)}`)).toBe('viewed');
    expect(viewedState('unhashed:modified:3:1', 'unhashed:modified:3:1')).toBe('viewed');
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

describe('comments on files no longer in the diff', () => {
  const list = [
    comment({ id: 'a', filePath: 'kept.ts' }),
    comment({ id: 'b', filePath: 'gone.ts', status: 'addressed' }),
    comment({ id: 'c', filePath: 'gone.ts', status: 'resolved' }),
    comment({ id: 'd', filePath: 'also-gone.ts', status: 'sent', priority: 'blocking' }),
  ];
  it('lists the unresolved ones whose file left the diff, by file', () => {
    expect(commentsOffDiff(list, ['kept.ts']).map((c) => c.id)).toEqual(['d', 'b']);
  });
  it('lists every unresolved comment when nothing is in the diff (the worktree is gone)', () => {
    expect(commentsOffDiff(list, []).map((c) => c.id)).toEqual(['d', 'b', 'a']);
  });
  it('lists none before the diff has loaded', () => {
    expect(commentsOffDiff(list, null)).toEqual([]);
  });
});

describe('a person merge of a run whose worktree is gone', () => {
  it('reads the ticket from a worktree_missing 409', () => {
    expect(worktreeMissing(new ApiRequestError(409, 'worktree_missing', 'x', { ticketId: 't1' }))).toEqual({
      ticketId: 't1',
    });
    expect(worktreeMissing(new ApiRequestError(409, 'worktree_missing', 'x'))).toEqual({ ticketId: null });
    expect(worktreeMissing(new ApiRequestError(409, 'review_blocked', 'x'))).toBeNull();
    expect(worktreeMissing(new Error('boom'))).toBeNull();
  });
});

describe('mergeNowFailure', () => {
  it('words each refusal of a merge from the ticket drawer, naming the ticket', () => {
    expect(mergeNowFailure(new ApiRequestError(409, 'review_blocked', 'x', { blocking: 2 }), 'EL-3')).toBe(
      '2 blocking comments are open on EL-3, so it was not merged. Resolve them in Review first.',
    );
    expect(
      mergeNowFailure(new ApiRequestError(409, 'worktree_missing', 'x', { ticketId: 't1' }), 'EL-3'),
    ).toBe("The worktree of EL-3's run is gone and its work isn't in main. Nothing was merged.");
    expect(mergeNowFailure(new Error('boom'), 'EL-3')).toBe('Not merged: boom');
  });
});

describe('glyphHoverText', () => {
  it('escapes Markdown so a comment body is shown as plain text', () => {
    const text = glyphHoverText(
      comment({ priority: 'blocking', body: '**bold** [link](http://x) `code` <b>x</b>\n# head' }),
    );
    expect(text).toBe(
      'blocking: \\*\\*bold\\*\\* \\[link\\]\\(http://x\\) \\`code\\` \\<b\\>x\\</b\\> \\# head',
    );
  });
  it('shortens long bodies', () => {
    expect(glyphHoverText(comment({ body: 'x'.repeat(400) })).length).toBeLessThanOrEqual(
      'important: '.length + 161,
    );
  });
});

describe('escapeDraft', () => {
  it('closes an empty draft, asks before discarding a written one, and keeps it on a second Escape', () => {
    expect(escapeDraft('', false)).toBe('close');
    expect(escapeDraft('   ', false)).toBe('close');
    expect(escapeDraft('half a thought', false)).toBe('confirm');
    expect(escapeDraft('half a thought', true)).toBe('keep');
  });
});

describe('requestTargets', () => {
  it('offers a new run from main only for a ticket run', () => {
    expect(requestTargets({ ticketId: 't1' })).toEqual(['same', 'new']);
    expect(requestTargets({ ticketId: null })).toEqual(['same']);
  });
});

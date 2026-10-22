import type { ReviewComment, ReviewCommentPriority, Run, RunReviewState } from '@emberline/protocol';
import { ApiRequestError, errorMessage } from './api';

export const PRIORITY_ORDER: readonly ReviewCommentPriority[] = ['blocking', 'important', 'suggestion'];

const PRIORITY_GROUP_LABEL: Record<ReviewCommentPriority, string> = {
  blocking: 'Blocking',
  important: 'Important',
  suggestion: 'Suggestions',
};
const PRIORITY_LABEL: Record<ReviewCommentPriority, string> = {
  blocking: 'Blocking',
  important: 'Important',
  suggestion: 'Suggestion',
};
const INTENT_LABEL: Record<ReviewComment['intent'], string> = {
  fix: 'Fix',
  change: 'Change',
  question: 'Question',
  approve: 'Approve',
};

export const INTENT_OPTIONS = (['fix', 'change', 'question', 'approve'] as const).map((value) => ({
  value,
  label: INTENT_LABEL[value],
}));
export const PRIORITY_OPTIONS = PRIORITY_ORDER.map((value) => ({ value, label: PRIORITY_LABEL[value] }));

export interface CommentGroup {
  priority: ReviewCommentPriority;
  label: string;
  comments: ReviewComment[];
}

/** Comments grouped blocking → important → suggestion; empty groups are left out. */
export function groupByPriority(comments: readonly ReviewComment[]): CommentGroup[] {
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    label: PRIORITY_GROUP_LABEL[priority],
    comments: comments.filter((c) => c.priority === priority),
  })).filter((g) => g.comments.length > 0);
}

export function commentBadges(c: ReviewComment): { intent: string; priority: string } {
  return { intent: INTENT_LABEL[c.intent], priority: PRIORITY_LABEL[c.priority] };
}

/** Where the comment sits now: the re-anchored line, the whole file, or the old line when outdated. */
export function commentLocation(c: ReviewComment): string {
  if (c.line === null) return 'Whole file';
  if (c.outdated || c.currentLine === null) return `Outdated (was L${c.line})`;
  return `L${c.currentLine}`;
}

export type CommentAction = 'delete' | 'resolve' | 'verify' | 'notDone';

/** open: delete · sent: mark resolved · addressed: verify or reopen · resolved: nothing. */
export function commentActions(c: Pick<ReviewComment, 'status'>): CommentAction[] {
  switch (c.status) {
    case 'open':
      return ['delete'];
    case 'sent':
      return ['resolve'];
    case 'addressed':
      return ['verify', 'notDone'];
    default:
      return [];
  }
}

/**
 * What the blocking banners show, from core's own count (`blockingOpen`, chain-aware): the blocking
 * comments, and apart from them what a new run carried from the previous attempt.
 */
export function blockingBanner(state: Pick<RunReviewState, 'blockingOpen' | 'carriedBlocking'> | undefined): {
  comments: number;
  carried: RunReviewState['carriedBlocking'];
} {
  if (!state) return { comments: 0, carried: null };
  const carried = state.carriedBlocking;
  return { comments: Math.max(0, state.blockingOpen - (carried?.count ?? 0)), carried };
}

export function carriedMessage(count: number): string {
  return count === 1
    ? "This run carries 1 blocking item from the previous attempt — check it's done"
    : `This run carries ${count} blocking items from the previous attempt — check they're done`;
}

/**
 * Unresolved comments whose file is not in the diff any more (it was reverted, or the worktree is
 * gone), by file: they are listed apart so they can still be resolved. None until the diff loaded.
 */
export function commentsOffDiff(
  comments: readonly ReviewComment[],
  diffPaths: readonly string[] | null,
): ReviewComment[] {
  if (diffPaths === null) return [];
  const inDiff = new Set(diffPaths);
  return comments
    .filter((c) => c.status !== 'resolved' && !inDiff.has(c.filePath))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0));
}

export function fileCommentCounts(
  comments: readonly ReviewComment[],
  filePath: string,
): { open: number; blocking: number } {
  const mine = comments.filter((c) => c.filePath === filePath && c.status !== 'resolved');
  return { open: mine.length, blocking: mine.filter((c) => c.priority === 'blocking').length };
}

/** What a send carries from the person's side: new comments plus addressed ones they have not verified. */
export function requestableComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => c.status === 'open' || c.status === 'addressed');
}

export function requestSummary(comments: readonly ReviewComment[]): string {
  const parts = PRIORITY_ORDER.flatMap((priority) => {
    const n = comments.filter((c) => c.priority === priority).length;
    return n > 0 ? [`${n} ${priority === 'suggestion' && n !== 1 ? 'suggestions' : priority}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'No comments to send';
}

export type ViewedState = 'unviewed' | 'viewed' | 'changed';

/** A content hash as DiffFile.hash has it; older marks stored `status:adds:dels` instead. */
const HASH_SIGNATURE = /^(?:(?:link:|deleted:)?[0-9a-f]{40,64}|unhashed:.*)$/;

export function viewedState(storedSignature: string | undefined, hash: string): ViewedState {
  // A mark from before content hashes says nothing about the content: look again.
  if (storedSignature === undefined || !HASH_SIGNATURE.test(storedSignature)) return 'unviewed';
  return storedSignature === hash ? 'viewed' : 'changed';
}

/** The open blocking-comment count when `error` is the merge gate's 409, else null. */
export function reviewBlockedCount(error: unknown): number | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status !== 409 || error.code !== 'review_blocked') return null;
  const n = error.data.blocking;
  return typeof n === 'number' && n > 0 ? n : null;
}

export function blockingMessage(count: number): string {
  return `${count} blocking comment${count === 1 ? ' is' : 's are'} open`;
}

/** The run's ticket when `error` is sync-worktree's 409 for a run whose worktree is gone, else null. */
export function worktreeMissing(error: unknown): { ticketId: string | null } | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status !== 409 || error.code !== 'worktree_missing') return null;
  return { ticketId: typeof error.data.ticketId === 'string' ? error.data.ticketId : null };
}

/** Why a merge from the ticket drawer (Mark done, Accept) did not happen, as one sentence for the recovery block. */
export function mergeNowFailure(error: unknown, ticketKey: string): string {
  const blocking = reviewBlockedCount(error);
  if (blocking !== null)
    return `${blockingMessage(blocking)} on ${ticketKey}, so it was not merged. Resolve them in Review first.`;
  if (worktreeMissing(error))
    return `The worktree of ${ticketKey}'s run is gone and its work isn't in main. Nothing was merged.`;
  return `Not merged: ${errorMessage(error)}`;
}

/** Markdown characters a hover would render; escaped so a comment body shows as typed. */
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~&]/g;

/** The glyph's hover text: priority and the start of the body, as plain text (Markdown escaped). */
export function glyphHoverText(c: Pick<ReviewComment, 'priority' | 'body'>): string {
  const body = c.body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${c.priority}: ${body.replace(MARKDOWN_SPECIAL, '\\$&')}`;
}

/**
 * Escape on something a person is writing (a comment, a note): an empty one closes, a written one
 * asks first ("Discard draft?"), and Escape on that question keeps the text. Never dropped silently.
 */
export function escapeDraft(text: string, confirming: boolean): 'close' | 'confirm' | 'keep' {
  if (confirming) return 'keep';
  return text.trim() === '' ? 'close' : 'confirm';
}

/** Where Request changes can send: a new run from main needs the run's ticket. */
export function requestTargets(run: Pick<Run, 'ticketId'>): ('same' | 'new')[] {
  return run.ticketId ? ['same', 'new'] : ['same'];
}

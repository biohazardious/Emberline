import type { ReviewComment, ReviewCommentPriority } from '@emberline/protocol';
import { ApiRequestError } from './api';

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

/** Unresolved blocking comments, outdated ones included (the same rule core's merge gate uses). */
export function blockingCount(comments: readonly ReviewComment[]): number {
  return comments.filter((c) => c.priority === 'blocking' && c.status !== 'resolved').length;
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

export function viewedState(storedSignature: string | undefined, hash: string): ViewedState {
  if (storedSignature === undefined) return 'unviewed';
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

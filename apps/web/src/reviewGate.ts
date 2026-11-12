import type { ReviewComment, Run, RunReviewState, SlopAuditReport } from '@emberline/protocol';
import { commentChipId } from './components/review/CommentChip';
import { blockingBanner, blockingMessage, carriedMessage, commentLocation } from './reviewComments';

export interface MergeGateBlockingCommentItem {
  id: string;
  href: string;
  filePath: string;
  location: string;
  status: ReviewComment['status'];
  excerpt: string;
  inDiff: boolean;
}

export interface MergeGateHoldReason {
  id: string;
  label: string;
  detail: string;
}

export interface MergeGateSummary {
  loaded: boolean;
  isBlocked: boolean;
  blockingOpen: number;
  directBlockingCount: number;
  headline: string;
  blockingComments: MergeGateBlockingCommentItem[];
  predecessorBlocking: { count: number; predecessorRunId: string | null } | null;
  carriedBlocking: { count: number; fromRun: string | null; message: string } | null;
  holdReasons: MergeGateHoldReason[];
}

function formatCommentExcerpt(body: string): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`;
}

/**
 * Builds the inline Merge Gate summary shown at the top of the review page, linking directly to
 * each unresolved blocking comment and surfacing carried, predecessor, and pipeline holds.
 */
export function buildMergeGateSummary(params: {
  review: RunReviewState | undefined;
  run: Pick<Run, 'id' | 'attention' | 'reviewReady' | 'predecessorRunId'>;
  orderedDiffPaths: readonly string[] | null;
  slopAudit?: SlopAuditReport | null;
}): MergeGateSummary {
  const { review, run, orderedDiffPaths, slopAudit } = params;
  const banner = blockingBanner(review);
  const pathOrder = new Map<string, number>();
  if (orderedDiffPaths) {
    for (let i = 0; i < orderedDiffPaths.length; i += 1) {
      pathOrder.set(orderedDiffPaths[i]!, i);
    }
  }

  const rawBlocking = (review?.comments ?? []).filter(
    (c) => c.priority === 'blocking' && c.status !== 'resolved',
  );

  const sortedBlocking = [...rawBlocking].sort((a, b) => {
    const rankA = pathOrder.get(a.filePath);
    const rankB = pathOrder.get(b.filePath);
    if (rankA !== undefined && rankB !== undefined) {
      if (rankA !== rankB) return rankA - rankB;
    } else if (rankA !== undefined) {
      return -1;
    } else if (rankB !== undefined) {
      return 1;
    } else {
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) return byPath;
    }
    return (a.currentLine ?? a.line ?? 0) - (b.currentLine ?? b.line ?? 0);
  });

  const blockingComments: MergeGateBlockingCommentItem[] = sortedBlocking.map((c) => ({
    id: c.id,
    href: `#${commentChipId(c.id)}`,
    filePath: c.filePath,
    location: commentLocation(c),
    status: c.status,
    excerpt: formatCommentExcerpt(c.body),
    inDiff: orderedDiffPaths === null ? true : pathOrder.has(c.filePath),
  }));

  const predecessorCount = Math.max(0, banner.comments - blockingComments.length);
  const predecessorBlocking =
    predecessorCount > 0 ? { count: predecessorCount, predecessorRunId: run.predecessorRunId ?? null } : null;

  const carriedBlocking = banner.carried
    ? {
        count: banner.carried.count,
        fromRun: banner.carried.fromRun,
        message: carriedMessage(banner.carried.count),
      }
    : null;

  const holdReasons: MergeGateHoldReason[] = [];
  if (
    (run.attention?.reason === 'held' || run.attention?.reason === 'blocked') &&
    run.attention.detail &&
    run.attention.detail !== 'Blocking review comments'
  ) {
    holdReasons.push({
      id: `attention-${run.attention.reason}`,
      label: run.attention.reason === 'blocked' ? 'Blocked' : 'Pipeline hold',
      detail: run.attention.detail,
    });
  }

  if (slopAudit && slopAudit.secretGuardPassed === false && slopAudit.secretLeakCount > 0) {
    const alreadyCovered = holdReasons.some((h) => h.detail.toLowerCase().includes('secret'));
    if (!alreadyCovered) {
      holdReasons.push({
        id: 'secret-guard',
        label: 'Secret guard',
        detail: `${slopAudit.secretLeakCount} potential secret leak${slopAudit.secretLeakCount === 1 ? '' : 's'} detected in diff`,
      });
    }
  }

  const blockingOpen = review?.blockingOpen ?? 0;
  const isBlocked =
    blockingOpen > 0 || blockingComments.length > 0 || carriedBlocking !== null || holdReasons.length > 0;

  let headline = 'Merge gate ready — 0 blocking items open';
  if (banner.comments > 0) {
    headline = `${blockingMessage(banner.comments)}. The merge gate stays closed until they are resolved.`;
  } else if (carriedBlocking) {
    headline = 'Merge gate closed — carried blocking feedback awaits verification.';
  } else if (holdReasons.length > 0) {
    headline = `Merge gate held — ${holdReasons[0]!.detail}.`;
  }

  return {
    loaded: review !== undefined,
    isBlocked,
    blockingOpen: Math.max(blockingOpen, blockingComments.length),
    directBlockingCount: banner.comments,
    headline,
    blockingComments,
    predecessorBlocking,
    carriedBlocking,
    holdReasons,
  };
}

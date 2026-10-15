import { randomUUID } from 'node:crypto';
import {
  CreateReviewCommentBody,
  MarkFileViewedBody,
  RequestChangesBody,
  type ReviewComment,
  type Run,
  type RunReviewState,
  UpdateReviewCommentBody,
} from '@emberline/protocol';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { reviewComments, reviewFileViews } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import type { RunService } from '../runs/service.js';

type CommentRow = typeof reviewComments.$inferSelect;

const toComment = (row: CommentRow): ReviewComment => ({
  id: row.id,
  runId: row.runId,
  filePath: row.filePath,
  line: row.line,
  side: row.side as ReviewComment['side'],
  body: row.body,
  status: row.status as ReviewComment['status'],
  createdAt: row.createdAt.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, raw: unknown): T {
  const res = schema.safeParse(raw ?? {});
  if (!res.success) throw badRequest(res.error.issues.map((i) => i.message).join('; '));
  return res.data;
}

/**
 * Line comments and per-file "viewed" marks on a run's diff, stored in SQLite so a review survives
 * reloads and can be continued after the agent has addressed part of it.
 */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
  ) {}

  state(runId: string): RunReviewState {
    this.runs.getRun(runId);
    const comments = this.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.runId, runId))
      .orderBy(asc(reviewComments.filePath), asc(reviewComments.line), asc(reviewComments.createdAt))
      .all()
      .map(toComment);
    const viewed = this.db
      .select()
      .from(reviewFileViews)
      .where(eq(reviewFileViews.runId, runId))
      .all()
      .map((row) => ({ filePath: row.filePath, signature: row.signature, viewedAt: row.viewedAt.toISOString() }));
    return { comments, viewed };
  }

  addComment(runId: string, raw: unknown): ReviewComment {
    this.runs.getRun(runId);
    const body = parse(CreateReviewCommentBody, raw);
    const row: CommentRow = {
      id: randomUUID(),
      runId,
      filePath: body.filePath,
      line: body.line,
      side: body.side,
      body: body.body,
      status: 'open',
      createdAt: new Date(),
      sentAt: null,
      resolvedAt: null,
    };
    this.db.insert(reviewComments).values(row).run();
    return toComment(row);
  }

  private comment(runId: string, commentId: string): CommentRow {
    const row = this.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.id, commentId), eq(reviewComments.runId, runId)))
      .get();
    if (!row) throw notFound('no such review comment');
    return row;
  }

  updateComment(runId: string, commentId: string, raw: unknown): ReviewComment {
    const existing = this.comment(runId, commentId);
    const body = parse(UpdateReviewCommentBody, raw);
    const patch: Partial<CommentRow> = {};
    if (body.body !== undefined) patch.body = body.body;
    if (body.status === 'resolved') Object.assign(patch, { status: 'resolved', resolvedAt: new Date() });
    // Reopening keeps the history of whether it was sent.
    if (body.status === 'open') Object.assign(patch, { status: existing.sentAt ? 'sent' : 'open', resolvedAt: null });
    const updated = this.db
      .update(reviewComments)
      .set(patch)
      .where(eq(reviewComments.id, commentId))
      .returning()
      .get();
    return toComment(updated!);
  }

  deleteComment(runId: string, commentId: string): void {
    this.comment(runId, commentId);
    this.db.delete(reviewComments).where(eq(reviewComments.id, commentId)).run();
  }

  /** Sends every open comment (plus an optional note) to the agent as one prompt and marks them sent. */
  async requestChanges(runId: string, raw: unknown): Promise<{ run: Run; sent: number }> {
    const { note } = parse(RequestChangesBody, raw);
    const open = this.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.runId, runId), eq(reviewComments.status, 'open')))
      .orderBy(asc(reviewComments.filePath), asc(reviewComments.line))
      .all();
    if (open.length === 0 && !note) throw badRequest('nothing to send: add a line comment or a note');
    const lines = ['Please address the following code review feedback on this branch:', ''];
    if (note) lines.push(`Overall note: ${note}`, '');
    if (open.length > 0) {
      lines.push('Line comments:');
      for (const c of open) {
        lines.push(`- \`${c.filePath}:${c.line}\`${c.side === 'original' ? ' (removed code)' : ''}: ${c.body}`);
      }
    }
    const run = await this.runs.prompt(runId, lines.join('\n'));
    const sentAt = new Date();
    for (const c of open) {
      this.db.update(reviewComments).set({ status: 'sent', sentAt }).where(eq(reviewComments.id, c.id)).run();
    }
    return { run, sent: open.length };
  }

  markViewed(runId: string, raw: unknown): RunReviewState {
    this.runs.getRun(runId);
    const body = parse(MarkFileViewedBody, raw);
    if (body.viewed) {
      this.db
        .insert(reviewFileViews)
        .values({ runId, filePath: body.filePath, signature: body.signature, viewedAt: new Date() })
        .onConflictDoUpdate({
          target: [reviewFileViews.runId, reviewFileViews.filePath],
          set: { signature: body.signature, viewedAt: new Date() },
        })
        .run();
    } else {
      this.db
        .delete(reviewFileViews)
        .where(and(eq(reviewFileViews.runId, runId), eq(reviewFileViews.filePath, body.filePath)))
        .run();
    }
    return this.state(runId);
  }
}

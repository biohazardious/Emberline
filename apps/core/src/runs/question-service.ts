/** The Answer dialog's server side: what a run asks, a drafted answer, and delivering the person's answer. */
import {
  ANSWER_LIMITS,
  type AnswerRequestParsed,
  type AnswerResponse,
  type AskUserQuestionSummary,
  type Run,
  type RunQuestion,
  type SuggestAnswerResponse,
} from '@emberline/protocol';
import { existsSync } from 'node:fs';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents, tickets } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { deleteWorkspaceFileEntry, writeNewWorkspaceFile } from '../factory/files.js';
import { decodeMaterials } from '../factory/materials.js';
import { getFactorySettings } from '../factory/settings.js';
import { answerAttachmentPaths, answerPrompt, type StoredAttachment } from './answer.js';
import { assertSuccessorExtraFits } from './handoff.js';
import { buildRunQuestion, openPicker } from './question.js';
import type { RecoveryService } from './recovery-service.js';
import type { RunService } from './service.js';
import { buildSuggestPrompt, runSuggestion } from './suggest.js';

export interface QuestionServiceOptions {
  completionReminder: (run: Run) => string;
  /** `--model` for the suggestion (EMBERLINE_SUGGEST_MODEL, default haiku). */
  suggestModel: string;
  /** Claude Code executable in the runner. */
  claudeCommand: string;
  /** How long a cancelled picker gets to close before the typed answer follows. */
  cancelWaitMs: number;
  /** Whether the runner (ptyd) is connected: a suggestion runs there. */
  runnerConnected: () => boolean;
}

const noQuestion = () => new HttpError(404, 'no_question', 'This run is not waiting for an answer.');
const ANSWERABLE = new Set(['question', 'permission', 'held', 'blocked']);

const ESC = '\x1b';

export class QuestionService {
  /** Runs with a suggestion being written (one at a time per run). */
  private readonly suggesting = new Set<string>();
  /** Runs with an answer being delivered (a second one would type into the terminal twice). */
  private readonly answering = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly recovery: RecoveryService,
    private readonly opts: QuestionServiceOptions,
  ) {}

  async get(runId: string): Promise<RunQuestion> {
    const run = this.runs.getRun(runId);
    const attention = run.attention;
    if (!attention || !ANSWERABLE.has(attention.reason)) throw noQuestion();
    const attentionReason = attention.reason as 'question' | 'permission' | 'held' | 'blocked';
    // An open AskUserQuestion picker raises a permission prompt notification, so a permission may be a question.
    const pendingAsk =
      attentionReason === 'question' || attentionReason === 'permission' ? this.pendingAsk(run.id) : null;
    const reason = pendingAsk ? 'question' : attentionReason;
    const base = buildRunQuestion({
      reason,
      blockers: reason === 'blocked' ? this.blockers(run.id) : [],
      pendingAsk,
      lastMessage: reason === 'question' ? this.lastMessage(run.id, attention.since) : null,
      notification: reason === 'question' || reason === 'permission' ? attention.detail : null,
      holdWhy: reason === 'held' ? ((await this.recovery.get(run.id))?.why ?? attention.detail) : null,
    });
    return { ...base, suggest: this.suggestAvailability(reason) };
  }

  /** Stores the answer's files in the run's worktree, then delivers the prompt the answer becomes. */
  async answer(runId: string, body: AnswerRequestParsed): Promise<AnswerResponse> {
    if (this.answering.has(runId))
      throw new HttpError(409, 'answer_busy', 'An answer is already being sent.');
    this.answering.add(runId);
    try {
      return await this.deliver(runId, body);
    } finally {
      this.answering.delete(runId);
    }
  }

  private async deliver(runId: string, body: AnswerRequestParsed): Promise<AnswerResponse> {
    // An option is its number alone: text or files beside it would be dropped without a word.
    if (body.option !== undefined && (body.text.trim() || body.attachments.length > 0))
      throw new HttpError(
        400,
        'option_with_answer',
        'An option is sent on its own. Send your text and files without picking an option.',
      );
    const question = await this.get(runId); // 404 no_question once the run stopped waiting
    if (body.option !== undefined) return this.answerPicker(runId, question, body.option);
    // Nothing is typed into a permission prompt: Enter or text there would allow or deny it.
    if (question.kind === 'permission')
      throw new HttpError(409, 'permission_prompt', 'Answer this permission prompt in the terminal.');
    const run = this.runs.getRun(runId);
    const decoded = decodeMaterials(body.attachments, ANSWER_LIMITS);
    // Refused before any file is written where it can be (a refusal after is undone below).
    if (question.kind === 'blocked' || question.kind === 'held') this.recovery.assertDeliverable(run);
    if (!run.worktreePath || !existsSync(run.worktreePath))
      throw new HttpError(
        409,
        'worktree_missing',
        "this run's worktree was removed; start a new run or discard it",
      );
    const paths = answerAttachmentPaths(
      decoded.map((d) => d.name),
      new Date(),
    );
    const files: StoredAttachment[] = decoded.map((d, i) => ({
      path: paths[i]!,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
    }));
    const text = answerPrompt(
      question,
      body.text,
      files,
      question.kind === 'blocked' ? this.opts.completionReminder(run) : '',
    );
    // A successor's prompt also carries the handoff context: a too-long answer is refused here, before
    // its files are written, rather than by the handoff after.
    if (
      (question.kind === 'blocked' || question.kind === 'held') &&
      this.recovery.deliveryFor(run) === 'successor'
    )
      assertSuccessorExtraFits(text);
    const written: string[] = [];
    try {
      for (const [i, d] of decoded.entries()) {
        try {
          await writeNewWorkspaceFile(run.worktreePath, paths[i]!, d.bytes);
        } catch {
          throw new HttpError(
            500,
            'attachment_write_failed',
            `Couldn't store ${d.name} in the run's worktree. Try again, or send the answer without it.`,
          );
        }
        written.push(paths[i]!);
      }
      if (question.kind === 'blocked' || question.kind === 'held') {
        const res = await this.recovery.recover(run.id, text);
        return { delivery: res.delivery, attachments: paths };
      }
      // Free text over an open picker: Esc closes it, then the answer is typed as an ordinary prompt.
      if (question.picker) {
        await this.runs.sendKeys(run.id, ESC);
        await new Promise((resolve) => setTimeout(resolve, this.opts.cancelWaitMs));
      }
      await this.runs.prompt(run.id, text);
      return { delivery: 'session', attachments: paths };
    } catch (error) {
      // An answer that was not delivered leaves none of its files behind (a retry writes them anew).
      for (const p of written) await deleteWorkspaceFileEntry(run.worktreePath, p).catch(() => undefined);
      throw error;
    }
  }

  /** Picks option `option` (0-based) of the open picker: its number plus Enter selects it. */
  private async answerPicker(runId: string, question: RunQuestion, option: number): Promise<AnswerResponse> {
    if (!question.picker)
      throw new HttpError(409, 'picker_closed', 'This question has no open picker any more.');
    if (!question.pickerChips)
      throw new HttpError(
        409,
        'picker_text_only',
        "Answer this question by typing; its options can't be picked from here.",
      );
    if (option >= question.options.length)
      throw new HttpError(400, 'invalid_option', 'That option is not offered.');
    await this.runs.prompt(runId, String(option + 1));
    return { delivery: 'picker', attachments: [] };
  }

  /** Claude drafts the person's reply, read-only in the run's worktree; the person edits and sends it. */
  async suggest(runId: string): Promise<SuggestAnswerResponse> {
    const question = await this.get(runId);
    if (!question.suggest.available)
      throw new HttpError(
        409,
        'suggest_unavailable',
        question.suggest.reason ?? 'Suggestions are not available.',
      );
    if (this.suggesting.has(runId))
      throw new HttpError(409, 'suggest_busy', 'A suggestion is already being written.');
    this.suggesting.add(runId);
    try {
      const run = this.runs.getRun(runId);
      const ticket = run.ticketId
        ? this.db
            .select({ key: tickets.key, title: tickets.title, body: tickets.body })
            .from(tickets)
            .where(eq(tickets.id, run.ticketId))
            .get()
        : undefined;
      const prompt = buildSuggestPrompt({
        ticketTitle: ticket ? `${ticket.key} ${ticket.title}` : (run.title ?? null),
        ticketBody: ticket?.body ?? null,
        question,
        lastMessage:
          question.kind === 'question'
            ? this.lastMessage(run.id, run.attention?.since ?? new Date(0).toISOString())
            : null,
      });
      const answer = await runSuggestion({
        command: this.opts.claudeCommand,
        model: this.opts.suggestModel,
        cwd: run.worktreePath,
        prompt,
      });
      return { answer };
    } finally {
      this.suggesting.delete(runId);
    }
  }

  /** The blockers of the run's newest `completion_blocked` note. */
  private blockers(runId: string): string[] {
    const row = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'completion_blocked')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    const raw = (row?.payload as { blockers?: unknown } | null)?.blockers;
    return Array.isArray(raw) ? raw.filter((b): b is string => typeof b === 'string' && b.length > 0) : [];
  }

  /** The newest AskUserQuestion PreToolUse when no PostToolUse of that tool came after it. */
  private pendingAsk(runId: string): AskUserQuestionSummary | null {
    return openPicker(
      this.db
        .select({ type: runEvents.type, payload: runEvents.payload })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.id))
        .limit(200)
        .all(),
    );
  }

  /** The agent's last message of this wait (Stop at or after `since`). */
  private lastMessage(runId: string, since: string): string | null {
    const row = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'Stop'), gte(runEvents.ts, new Date(since))))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    const said = (row?.payload as { last_assistant_message?: unknown } | null)?.last_assistant_message;
    return typeof said === 'string' && said.trim() ? said.trim() : null;
  }

  private suggestAvailability(reason: string): RunQuestion['suggest'] {
    if (reason === 'permission')
      return { available: false, reason: 'A permission prompt is answered in the terminal.' };
    if (!getFactorySettings(this.db).providerAuth?.claude?.authenticated)
      return { available: false, reason: 'Claude Code is not signed in.' };
    if (!this.opts.runnerConnected()) return { available: false, reason: 'The runner is not reachable.' };
    return { available: true, reason: null };
  }
}

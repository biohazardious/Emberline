/** The Answer dialog's server side: what a run asks, a drafted answer, and delivering the person's answer. */
import {
  ANSWER_LIMITS,
  type AnswerRequestParsed,
  type AnswerResponse,
  type AskUserQuestionSummary,
  type Run,
  type RunQuestion,
} from '@emberline/protocol';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { writeNewWorkspaceFile } from '../factory/files.js';
import { decodeMaterials } from '../factory/materials.js';
import { getFactorySettings } from '../factory/settings.js';
import { answerAttachmentPaths, answerPrompt, type StoredAttachment } from './answer.js';
import { buildRunQuestion } from './question.js';
import type { RecoveryService } from './recovery-service.js';
import type { RunService } from './service.js';

export interface QuestionServiceOptions {
  completionReminder: (run: Run) => string;
  /** `--model` for the suggestion (EMBERLINE_SUGGEST_MODEL, default haiku). */
  suggestModel: string;
  /** Claude Code executable in the runner. */
  claudeCommand: string;
}

const noQuestion = () => new HttpError(404, 'no_question', 'This run is not waiting for an answer.');
const BOUNDARIES = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionStart']);
const ANSWERABLE = new Set(['question', 'permission', 'held', 'blocked']);

export class QuestionService {
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
    const question = await this.get(runId); // 404 no_question once the run stopped waiting
    // Nothing is typed into a terminal picker or a permission prompt: Enter or text there would pick a choice.
    // Picker delivery of `option` comes later.
    if (body.option !== undefined)
      throw new HttpError(409, 'picker_open', 'Answer this question in the terminal.');
    if (question.kind === 'permission')
      throw new HttpError(409, 'permission_prompt', 'Answer this permission prompt in the terminal.');
    if (question.picker) throw new HttpError(409, 'picker_open', 'Answer this question in the terminal.');
    const run = this.runs.getRun(runId);
    const decoded = decodeMaterials(body.attachments, ANSWER_LIMITS);
    const paths = answerAttachmentPaths(
      decoded.map((d) => d.name),
      new Date(),
    );
    const files: StoredAttachment[] = [];
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
      files.push({ path: paths[i]!, mimeType: d.mimeType, sizeBytes: d.sizeBytes });
    }
    const text = answerPrompt(
      question,
      body.text,
      files,
      question.kind === 'blocked' ? this.opts.completionReminder(run) : '',
    );
    if (question.kind === 'blocked' || question.kind === 'held') {
      const res = await this.recovery.recover(run.id, text);
      return { delivery: res.delivery, attachments: paths };
    }
    await this.runs.prompt(run.id, text);
    return { delivery: 'session', attachments: paths };
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
    const rows = this.db
      .select({ type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.id))
      .limit(200)
      .all();
    for (const r of rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      // Only PostToolUse is hooked, so a declined or terminal-answered picker never closes: a turn
      // boundary or another tool starting after the picker means the agent moved on.
      if (BOUNDARIES.has(r.type)) return null;
      if (p.tool_name !== 'AskUserQuestion') {
        if (r.type === 'PreToolUse') return null;
        continue;
      }
      if (r.type === 'PostToolUse') return null;
      if (r.type === 'PreToolUse') {
        const ask = p.ask_user_question as AskUserQuestionSummary | undefined;
        return ask && Array.isArray(ask.questions) && ask.questions.length > 0 ? ask : null;
      }
    }
    return null;
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
    return { available: true, reason: null };
  }
}

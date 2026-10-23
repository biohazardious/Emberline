/** 0.6.0 Answer dialog: the question a run waits on, the person's answer and a drafted suggestion. */
import { z } from 'zod';
import { type MaterialLimits, ProjectMaterialInput } from './project-materials.js';
import { RUN_PROMPT_MAX } from './runs.js';

const MB = 1024 * 1024;

export const ANSWER_LIMITS: MaterialLimits = { maxFiles: 10, maxFileBytes: 10 * MB, maxTotalBytes: 25 * MB };
/** Inside the run's worktree; `.emberline/attachments/**` never reaches main. */
export const ANSWER_ATTACHMENTS_DIR = '.emberline/attachments/answers';
export const QUESTION_OPTIONS_MAX = 6;
export const QUESTION_OPTION_MAX_CHARS = 200;

export const RunQuestionKind = z.enum(['blocked', 'question', 'permission', 'held']);
export type RunQuestionKind = z.infer<typeof RunQuestionKind>;

export const RunQuestionOption = z.object({ label: z.string(), detail: z.string().nullable() });
export type RunQuestionOption = z.infer<typeof RunQuestionOption>;

/** `GET /api/runs/:id/question`. */
export const RunQuestion = z.object({
  kind: RunQuestionKind,
  text: z.string(),
  source: z.enum(['blockers', 'ask_user_question', 'last_message', 'notification', 'hold']),
  options: z.array(RunQuestionOption).max(QUESTION_OPTIONS_MAX),
  /** Claude's AskUserQuestion picker is open in the terminal. */
  picker: z.boolean(),
  suggest: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type RunQuestion = z.infer<typeof RunQuestion>;

/** The compact copy of an AskUserQuestion tool input kept on the hook event (`ask_user_question`). */
export interface AskUserQuestionSummary {
  questions: { question: string; header: string | null; options: RunQuestionOption[] }[];
}

/** `POST /api/runs/:id/answer`. `option` answers an open picker by its 0-based index. */
export const AnswerRequest = z
  .object({
    text: z.string().max(RUN_PROMPT_MAX).optional().default(''),
    attachments: z.array(ProjectMaterialInput).max(ANSWER_LIMITS.maxFiles).optional().default([]),
    option: z
      .number()
      .int()
      .min(0)
      .max(QUESTION_OPTIONS_MAX - 1)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.option === undefined && !v.text.trim() && v.attachments.length === 0)
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'Write an answer or attach a file.' });
  });
export type AnswerRequest = z.input<typeof AnswerRequest>;

export const AnswerResponse = z.object({
  delivery: z.enum(['session', 'successor', 'picker']),
  /** Stored paths of the attachments, relative to the worktree. */
  attachments: z.array(z.string()),
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;

export const SuggestAnswerResponse = z.object({ answer: z.string() });
export type SuggestAnswerResponse = z.infer<typeof SuggestAnswerResponse>;

/** What a run waits on, as the Answer dialog shows it. Pure: QuestionService gathers the inputs. */
import {
  type AskUserQuestionSummary,
  QUESTION_OPTION_MAX_CHARS,
  QUESTION_OPTIONS_MAX,
  type RunQuestion,
  type RunQuestionOption,
} from '@emberline/protocol';

export interface QuestionInput {
  reason: 'blocked' | 'question' | 'permission' | 'held';
  blockers: string[];
  /** The AskUserQuestion input of a PreToolUse with no PostToolUse after it (the picker is open). */
  pendingAsk: AskUserQuestionSummary | null;
  /** The agent's last message since it started waiting (Stop `last_assistant_message`). */
  lastMessage: string | null;
  /** The Notification text attention uses (permission prompts, Claude's waiting notice). */
  notification: string | null;
  /** RecoveryService's why line for a hold. */
  holdWhy: string | null;
}

const ITEM = /^\s*(?:\d{1,2}[.)]|[A-Za-z][.)]|[-*])\s+(.+?)\s*$/;
const clip = (s: string) => s.slice(0, QUESTION_OPTION_MAX_CHARS);
const plain = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();

/**
 * Options the agent offered: a list that directly follows a question, or a list followed by a closing
 * question. Anything else (a list in a report, a question without a list) gives none.
 */
export function parseOptions(message: string): RunQuestionOption[] {
  const lines = message.trim().split('\n');
  const isItem = (l: string) => ITEM.test(l);
  const lastItem = lines.findLastIndex(isItem);
  if (lastItem < 0) return [];
  let first = lastItem;
  while (first > 0 && (isItem(lines[first - 1]!) || !lines[first - 1]!.trim())) first -= 1;
  if (!isItem(lines[first]!)) first += 1;
  const before = lines.slice(0, first).join('\n').trim();
  const after = lines
    .slice(lastItem + 1)
    .join('\n')
    .trim();
  // The list is an offer when it answers a question before it, or when a question closes the message.
  const asks = after ? after.endsWith('?') : /\?:?$/.test(before);
  if (!asks) return [];
  return lines
    .slice(first, lastItem + 1)
    .filter(isItem)
    .slice(0, QUESTION_OPTIONS_MAX)
    .map((l) => ({ label: clip(plain(ITEM.exec(l)![1]!)), detail: null }));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The compact copy of an AskUserQuestion tool input, or null when it is not one. */
export function askUserQuestionOf(toolInput: unknown): AskUserQuestionSummary | null {
  const questions = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return null;
  let complete = true;
  const out = questions.flatMap((q) => {
    const question = str((q as { question?: unknown }).question);
    if (!question) {
      complete = false;
      return [];
    }
    const options = Array.isArray((q as { options?: unknown }).options)
      ? (q as { options: unknown[] }).options
      : [];
    return [
      {
        question: clip(question),
        header: str((q as { header?: unknown }).header),
        multiSelect: (q as { multiSelect?: unknown }).multiSelect === true,
        options: options
          .flatMap((o) => {
            const label = str((o as { label?: unknown }).label);
            if (!label) complete = false;
            return label
              ? [{ label: clip(label), detail: str((o as { description?: unknown }).description) }]
              : [];
          })
          .slice(0, QUESTION_OPTIONS_MAX),
      },
    ];
  });
  return out.length > 0 ? { questions: out, complete } : null;
}

/**
 * Whether option i of the open picker is its number i+1: verified live only for one question with a
 * single choice. A summary from before `multiSelect`/`complete` were kept counts as not.
 */
export function pickerTakesNumbers(ask: AskUserQuestionSummary): boolean {
  return ask.complete === true && ask.questions.length === 1 && ask.questions[0]!.multiSelect === false;
}

export function buildRunQuestion(input: QuestionInput): Omit<RunQuestion, 'suggest'> {
  const none = { options: [] as RunQuestionOption[], picker: false, pickerChips: false };
  switch (input.reason) {
    case 'blocked':
      return { kind: 'blocked', text: input.blockers.join('\n'), source: 'blockers', ...none };
    case 'held':
      return { kind: 'held', text: input.holdWhy ?? '', source: 'hold', ...none };
    case 'permission':
      return { kind: 'permission', text: input.notification ?? '', source: 'notification', ...none };
    case 'question': {
      const ask = input.pendingAsk?.questions[0];
      if (ask) {
        const text = input.pendingAsk!.questions.map((q) => q.question).join('\n');
        return {
          kind: 'question',
          text,
          source: 'ask_user_question',
          options: ask.options,
          picker: true,
          pickerChips: pickerTakesNumbers(input.pendingAsk!),
        };
      }
      if (input.lastMessage)
        return {
          kind: 'question',
          text: input.lastMessage,
          source: 'last_message',
          options: parseOptions(input.lastMessage),
          picker: false,
          pickerChips: false,
        };
      return { kind: 'question', text: input.notification ?? '', source: 'notification', ...none };
    }
  }
}

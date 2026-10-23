/** The Answer dialog's state that is not markup: drafts, limits, error text. */
import {
  ANSWER_LIMITS,
  type Run,
  type RunAttentionReason,
  type RunQuestion,
  type RunRecovery,
} from '@emberline/protocol';
import type { QueryClient } from '@tanstack/react-query';
import {
  addMaterials,
  capLine,
  type MaterialCandidate,
  type WizardMaterial,
} from './components/wizard/materials';
import { trapTab } from './focusTrap';
import { recoverErrorText } from './holdRecovery';

const DRAFT_PREFIX = 'emberline.answerDraft.';
export const ANSWER_DRAFT_KEY = (runId: string) => `${DRAFT_PREFIX}${runId}`;
/** A draft nobody came back to in this long is for a run long finished; it is dropped. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Storage can be missing or blocked; the draft is a convenience, so every access is guarded.
const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** A stored draft is `{text, savedAt}`; before 0.6.1 it was the plain text, which counts as saved now. */
function readDraft(raw: string, now: number): { text: string; savedAt: number; legacy: boolean } {
  try {
    const v: unknown = JSON.parse(raw);
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { text?: unknown }).text === 'string' &&
      typeof (v as { savedAt?: unknown }).savedAt === 'number'
    ) {
      const { text, savedAt } = v as { text: string; savedAt: number };
      return { text, savedAt, legacy: false };
    }
  } catch {
    // plain text
  }
  return { text: raw, savedAt: now, legacy: true };
}

/** Drops drafts older than DRAFT_MAX_AGE_MS; an old plain-text one is stamped now, so it expires in turn. */
function pruneDrafts(now: number): void {
  const s = store();
  if (!s || typeof s.key !== 'function') return;
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const raw = s.getItem(k);
    if (raw === null) continue;
    const draft = readDraft(raw, now);
    if (now - draft.savedAt > DRAFT_MAX_AGE_MS) s.removeItem(k);
    else if (draft.legacy) s.setItem(k, JSON.stringify({ text: draft.text, savedAt: now }));
  }
}

export function loadDraft(runId: string, now = Date.now()): string {
  try {
    pruneDrafts(now);
    const raw = store()?.getItem(ANSWER_DRAFT_KEY(runId));
    return raw == null ? '' : readDraft(raw, now).text;
  } catch {
    return '';
  }
}

/** Every change is saved; old drafts are pruned on load, not on each keystroke. */
export function saveDraft(runId: string, text: string, now = Date.now()): void {
  try {
    if (text.trim()) store()?.setItem(ANSWER_DRAFT_KEY(runId), JSON.stringify({ text, savedAt: now }));
    else store()?.removeItem(ANSWER_DRAFT_KEY(runId));
  } catch {
    // the draft is a convenience
  }
}

export function clearDraft(runId: string): void {
  saveDraft(runId, '');
}

const ANSWERABLE: ReadonlySet<RunAttentionReason> = new Set(['question', 'permission', 'held', 'blocked']);

/**
 * Whether the Inbox offers Answer: the run waits on a person, and a held run's recovery (once known)
 * can still deliver a prompt. One that cannot gets the hold block's Copy fallback and its reason instead.
 */
export const answerOffered = (
  run: Pick<Run, 'attention'>,
  recovery: Pick<RunRecovery, 'delivery'> | null | undefined,
): boolean => !!run.attention && ANSWERABLE.has(run.attention.reason) && recovery?.delivery !== 'none';

/**
 * The run an open Answer dialog shows: its latest copy, or the one it opened with once the run left
 * the list (it stopped waiting). The dialog stays open either way, so the person's files are not lost.
 */
export const answerTarget = <R extends Pick<Run, 'id'>>(runs: readonly R[] | undefined, opened: R): R =>
  runs?.find((r) => r.id === opened.id) ?? opened;

/** What the answer box opens with: a suggestion's prompt when there is one, else the run's draft. */
export const startText = (initialText: string | undefined, runId: string): string =>
  initialText || loadDraft(runId);

export const canSend = (text: string, files: readonly WizardMaterial[], busy: boolean): boolean =>
  !busy && (text.trim().length > 0 || files.length > 0);

export const addAnswerFiles = (
  current: readonly WizardMaterial[],
  candidates: readonly MaterialCandidate[],
) => addMaterials(current, candidates, undefined, ANSWER_LIMITS);

export const answerCapLine = (files: readonly WizardMaterial[]) => capLine(files, ANSWER_LIMITS);

/** Recovery's refusals of a held run, worded as the hold block words them. */
const RECOVERY_CODES: ReadonlySet<string> = new Set([
  'no_session',
  'worktree_missing',
  'run_stopped_by_you',
  'not_held',
]);

/** Core's own messages are plain sentences; the states the dialog explains itself and recovery's refusals are mapped. */
export function answerErrorText(code: string, message: string): string {
  if (RECOVERY_CODES.has(code)) return recoverErrorText(code, message);
  switch (code) {
    case 'no_question':
      return 'This run is not waiting for an answer any more. Your draft is kept.';
    case 'run_busy':
      return 'The agent is working right now. Send your answer once it waits.';
    default:
      return message;
  }
}

/** The small print under the question: where its text came from. */
export const QUESTION_SOURCE_LINES: Record<RunQuestion['source'], string> = {
  last_message: "From the agent's last message",
  blockers: "The agent's blockers",
  ask_user_question: "Claude's question picker",
  hold: 'Why it is held',
  notification: "The agent's notification",
};

/** What the options and the typed answer do while Claude's picker is open; null without one. */
export function pickerNote(question: Pick<RunQuestion, 'picker' | 'pickerChips'>): string | null {
  if (!question.picker) return null;
  const typed = "Typing an answer cancels Claude's question picker and sends your text instead.";
  return question.pickerChips
    ? `${typed} With nothing typed or attached, an option answers it directly; otherwise the option is added to your answer.`
    : typed;
}

/** A chip answers the open picker by its number only when core says the numbers match; else it fills the box. */
export const chipAnswers = (question: Pick<RunQuestion, 'picker' | 'pickerChips'>): boolean =>
  question.picker && question.pickerChips;

/**
 * A chip sends its number only when nothing is typed or attached: the option goes alone, so it
 * would drop them. Otherwise it goes into the box (`withOption`) and Send carries all of it.
 */
export const chipSends = (
  question: Pick<RunQuestion, 'picker' | 'pickerChips'>,
  text: string,
  files: readonly WizardMaterial[],
): boolean => chipAnswers(question) && !text.trim() && files.length === 0;

/**
 * The box after a chip fills it: the option on its own line after the typed answer. `placed` is the
 * label the previous chip put there; while it is still the last line, the new option replaces it,
 * so two options never both go out.
 */
export function withOption(text: string, label: string, placed: string | null): string {
  const lines = text.trimEnd().split('\n');
  if (placed !== null && lines.at(-1)?.trim() === placed) lines.pop();
  const rest = lines.join('\n').trimEnd();
  return rest.trim() ? `${rest}\n${label}` : label;
}

/** What option chip `i` does: send its number (`chipSends`), or fill the box and remember the label it placed. */
export function optionChoice(
  question: Pick<RunQuestion, 'picker' | 'pickerChips' | 'options'>,
  i: number,
  text: string,
  files: readonly WizardMaterial[],
  placed: string | null,
): { send: true } | { send: false; text: string; placed: string } | null {
  const option = question.options[i];
  if (!option) return null;
  if (chipSends(question, text, files)) return { send: true };
  return { send: false, text: withOption(text, option.label, placed), placed: option.label };
}

/** A problem with an attached file, shown in the dialog's live region. */
export interface AnswerProblem {
  id: number;
  text: string;
}
let lastProblemId = 0;
/** Each refusal gets a fresh id, so the same sentence again is a new node the live region reads out again. */
export const answerProblems = (texts: readonly string[]): AnswerProblem[] =>
  texts.map((text) => ({ id: ++lastProblemId, text }));

/** Once an answer went out: the hold block refetches its recovery, and no copy of the answered question is kept. */
export function refreshAfterAnswer(
  client: Pick<QueryClient, 'invalidateQueries' | 'removeQueries'>,
  runId: string,
): void {
  void client.invalidateQueries({ queryKey: ['run-recovery', runId] });
  client.removeQueries({ queryKey: ['run-question', runId] });
}

/**
 * The dialog's keydown, registered on window in the capture phase: Escape and a trapped Tab stop
 * there, so a drawer or page behind the dialog never sees them (the ticket drawer closes on Escape).
 */
export function handleDialogKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>,
  container: HTMLElement | null,
  dismiss: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  } else if (event.key === 'Tab') {
    event.stopPropagation();
    trapTab(container, event as KeyboardEvent);
  }
}

/** What a suggestion does when it lands: nothing once the dialog closed or the answer went out, else fill or ask. */
export function suggestionAction(closed: boolean, text: string): 'ignore' | 'fill' | 'ask' {
  if (closed) return 'ignore';
  return text.trim() ? 'ask' : 'fill';
}

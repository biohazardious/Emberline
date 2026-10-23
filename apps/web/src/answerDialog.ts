/** The Answer dialog's state that is not markup: drafts, limits, error text. */
import {
  ANSWER_LIMITS,
  type Run,
  type RunAttentionReason,
  type RunQuestion,
  type RunRecovery,
} from '@emberline/protocol';
import {
  addMaterials,
  capLine,
  type MaterialCandidate,
  type WizardMaterial,
} from './components/wizard/materials';
import { trapTab } from './focusTrap';
import { recoverErrorText } from './holdRecovery';

export const ANSWER_DRAFT_KEY = (runId: string) => `emberline.answerDraft.${runId}`;

// Storage can be missing or blocked; the draft is a convenience, so every access is guarded.
const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadDraft(runId: string): string {
  try {
    return store()?.getItem(ANSWER_DRAFT_KEY(runId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(runId: string, text: string): void {
  try {
    if (text.trim()) store()?.setItem(ANSWER_DRAFT_KEY(runId), text);
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
  return question.pickerChips ? `${typed} Pick an option to answer it directly.` : typed;
}

/** A chip answers the open picker by its number only when core says the numbers match; else it fills the box. */
export const chipAnswers = (question: Pick<RunQuestion, 'picker' | 'pickerChips'>): boolean =>
  question.picker && question.pickerChips;

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

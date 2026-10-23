/** The Answer dialog's state that is not markup: drafts, limits, error text. */
import { ANSWER_LIMITS } from '@emberline/protocol';
import {
  addMaterials,
  capLine,
  type MaterialCandidate,
  type WizardMaterial,
} from './components/wizard/materials';

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

export const canSend = (text: string, files: readonly WizardMaterial[], busy: boolean): boolean =>
  !busy && (text.trim().length > 0 || files.length > 0);

export const addAnswerFiles = (
  current: readonly WizardMaterial[],
  candidates: readonly MaterialCandidate[],
) => addMaterials(current, candidates, undefined, ANSWER_LIMITS);

export const answerCapLine = (files: readonly WizardMaterial[]) => capLine(files, ANSWER_LIMITS);

/** Core's messages are already plain sentences; only the two states the dialog explains itself are mapped. */
export function answerErrorText(code: string, message: string): string {
  switch (code) {
    case 'no_question':
    case 'not_held':
      return 'This run is not waiting for an answer any more. Your draft is kept.';
    case 'run_busy':
      return 'The agent is working right now. Send your answer once it waits.';
    default:
      return message;
  }
}

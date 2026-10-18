/** The wizard's reducer plus its sessionStorage draft (an accidental close can be undone). */
import { useCallback, useEffect, useReducer, useState } from 'react';
import { DRAFT_KEY, draftOf, initialWizardState, isDirty, parseDraft, type WizardDraft, wizardReducer } from './wizardLogic';

function readDraft(): WizardDraft | null {
  try {
    return parseDraft(sessionStorage.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}

function writeDraft(draft: WizardDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage blocked or full: the wizard works without a draft.
  }
}

function removeDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * State lives only while the wizard is mounted, so closing it resets everything. The draft of the
 * last wizard stays in sessionStorage and is offered as "Restore draft" on a fresh one.
 */
export function useWizardState() {
  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizardState);
  const [savedDraft, setSavedDraft] = useState<WizardDraft | null>(readDraft);

  useEffect(() => {
    const draft = draftOf(state);
    if (draft) writeDraft(draft);
    // An import that registered its project cannot be replayed from a draft.
    else if (state.importProjectId !== null) removeDraft();
  }, [state]);

  const restore = useCallback(() => {
    if (savedDraft) dispatch({ type: 'restore', draft: savedDraft });
    setSavedDraft(null);
  }, [savedDraft]);

  const dismissDraft = useCallback(() => {
    removeDraft();
    setSavedDraft(null);
  }, []);

  /** After a create: start over with no draft to restore. */
  const finish = useCallback(() => {
    dispatch({ type: 'reset' });
    removeDraft();
    setSavedDraft(null);
  }, []);

  return {
    state,
    dispatch,
    /** Offered only until the person starts entering something new. */
    savedDraft: isDirty(state) ? null : savedDraft,
    restore,
    dismissDraft,
    finish,
  };
}

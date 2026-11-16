import { Check, X } from 'lucide-react';
import type { RefObject } from 'react';
import {
  canVisit,
  isStepValid,
  type StepId,
  stepLabel,
  type WizardSource,
  type WizardState,
} from './wizardLogic';

export function stepGuidance(step: StepId, source: WizardSource | null): string {
  switch (step) {
    case 'start':
      return 'Choose whether to create a new project or import an existing repository.';
    case 'type':
      return 'Name the project, pick a preset and describe the product vision.';
    case 'repo':
      return source === 'import_folder'
        ? 'Pick a git repository in the workspaces directory.'
        : 'Enter the repository URL and branch to clone.';
    case 'import':
      return source === 'import_folder'
        ? 'Inspecting repository files.'
        : 'Clone the repository and inspect its stack.';
    case 'stack':
      return source === 'import_url' || source === 'import_folder'
        ? 'Review detected stack choices.'
        : 'Adjust stack choices for the project.';
    case 'factory':
      return 'Configure quality gates and startup mode.';
    case 'summary':
      return 'Review what will be created before finishing.';
  }
}

export function WizardTopBar({
  done,
  index,
  total,
  step,
  source,
  onClose,
}: {
  done: boolean;
  index: number;
  total: number;
  step: StepId;
  source: WizardSource | null;
  onClose: () => void;
}) {
  return (
    <header className="wizard-top">
      <div className="wizard-top-title">
        <h2 id="wizard-title">New project</h2>
        {!done && (
          <span className="wizard-top-step muted small">
            Step {index + 1} of {total} · {stepLabel(step, source)}
          </span>
        )}
      </div>
      <button id="wizard-close" type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
        <X className="icon" aria-hidden />
      </button>
    </header>
  );
}

export function WizardRail({
  steps,
  state,
  busy,
  onSelectStep,
}: {
  steps: readonly StepId[];
  state: WizardState;
  busy: string | null;
  onSelectStep: (step: StepId) => void;
}) {
  return (
    <nav className="wizard-rail" aria-label="Wizard steps">
      <ol>
        {steps.map((step, i) => {
          const current = step === state.step;
          const complete = i < state.furthest && isStepValid(state, step) && !current;
          return (
            <li key={step}>
              <button
                type="button"
                className={`wizard-rail-step${current ? ' current' : ''}${complete ? ' complete' : ''}`}
                aria-current={current ? 'step' : undefined}
                disabled={busy !== null || (!current && !canVisit(state, step))}
                onClick={() => onSelectStep(step)}
              >
                <span className="wizard-rail-index" aria-hidden>
                  {complete ? <Check className="icon" /> : i + 1}
                </span>
                <span>{stepLabel(step, state.source)}</span>
                {complete && <span className="sr-only"> (done)</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function WizardDoneView({
  name,
  warning,
  headingRef,
  onClose,
}: {
  name: string;
  warning: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title" tabIndex={-1} ref={headingRef}>
        {name} was created
      </h3>
      <p className="banner banner-warn" role="alert">
        {warning}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-primary" data-autofocus="" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function WizardFooter({
  confirmClose,
  importProjectId,
  actionError,
  hint,
  busy,
  back,
  nextDisabled,
  nextLabel,
  onConfirmClose,
  onKeepEditing,
  onBack,
  onNext,
}: {
  confirmClose: boolean;
  importProjectId: string | null;
  actionError: string | null;
  hint: string;
  busy: string | null;
  back: StepId | null;
  nextDisabled: boolean;
  nextLabel: string;
  onConfirmClose: () => void;
  onKeepEditing: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <footer className="wizard-foot">
      {confirmClose ? (
        <div className="wizard-confirm" role="alert">
          <span className="small">
            {importProjectId !== null
              ? 'Close the wizard? The imported project stays in your list, without Emberline files.'
              : 'Discard this project setup? You can restore it the next time you open the wizard.'}
          </span>
          <div className="actions">
            <button type="button" className="btn btn-sm" onClick={onConfirmClose}>
              {importProjectId !== null ? 'Close' : 'Discard'}
            </button>
            <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={onKeepEditing}>
              Keep editing
            </button>
          </div>
        </div>
      ) : (
        <>
          {actionError && (
            <p className="form-error wizard-foot-error" role="alert">
              {actionError}
            </p>
          )}
          <p id="wizard-next-hint" className="wizard-hint muted small" aria-live="polite">
            {hint}
          </p>
          <div className="wizard-foot-actions">
            <button type="button" className="btn" disabled={busy !== null || back === null} onClick={onBack}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={nextDisabled}
              aria-describedby={hint ? 'wizard-next-hint' : undefined}
              onClick={onNext}
            >
              {nextLabel}
            </button>
          </div>
        </>
      )}
    </footer>
  );
}

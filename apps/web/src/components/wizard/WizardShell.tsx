import type {
  AdoptProjectResponse,
  CreateProjectResponse,
  FactorySettings,
  Project,
  ProjectDetectResponse,
  WorkspaceFolder,
  WorkspaceFoldersResponse,
} from '@emberline/protocol';
import { Check, X } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../../api';
import { trapTab } from '../../focusTrap';
import { useApi } from '../../hooks/useApi';
import { ImportProgress } from './ImportProgress';
import { StepFactory } from './StepFactory';
import { StepStack } from './StepStack';
import { StepRepo, StepStart } from './StepStart';
import { StepSummary, useSummaryPreview } from './StepSummary';
import { StepType } from './StepType';
import { materialsErrorMessage } from './materials';
import { useWizardState } from './useWizardState';
import {
  buildAdoptBody,
  buildCreateBody,
  buildCreateBodyWithFiles,
  canVisit,
  hasImportableFolders,
  isDirty,
  isImport,
  isNameConflict,
  isStepValid,
  nextStep,
  previousStep,
  type StepId,
  stepLabel,
  stepProblem,
  stepsFor,
} from './wizardLogic';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  open: boolean;
  /** The runner is not connected: cloning is not offered. */
  runnerDown: boolean;
  onClose: () => void;
  /** A project was created or adopted: refresh, select and show it. */
  onCreated: (project: Project) => Promise<void> | void;
  /** An import registered (or removed) a project before the wizard finished. */
  onProjectsChanged: () => void;
}

/** The one project wizard: new from a preset, blank, import from a Git URL or a workspace folder. */
export function ProjectWizard(props: Props) {
  // Unmounting on close resets every piece of state.
  return props.open ? <WizardShell {...props} /> : null;
}

function useWorkspaceFolders(): WorkspaceFolder[] {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<WorkspaceFoldersResponse>('/api/workspaces/folders').then(
      (res) => !cancelled && setFolders(res.folders),
      () => undefined, // No list, no folder option.
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return folders;
}

function WizardShell({ runnerDown, onClose, onCreated, onProjectsChanged }: Props) {
  const { state, dispatch, savedDraft, restore, dismissDraft, finish } = useWizardState();
  const folders = useWorkspaceFolders();
  const factory = useApi<FactorySettings>('/api/factory/settings', 15_000);
  const preview = useSummaryPreview(state, state.step === 'summary');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [done, setDone] = useState<{ name: string; warning: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<string | null>(null);
  /** Bumped to re-run the initial-focus pass when the step stays but its controls change. */
  const [focusTick, setFocusTick] = useState(0);
  const refocus = (id?: string) => {
    focusNext.current = id ?? null;
    setFocusTick((t) => t + 1);
  };
  /** Where to go after a confirmed close (the Settings link). */
  const leaveTo = useRef<string | null>(null);
  const [, navigate] = useLocation();

  const steps = stepsFor(state.source);
  const index = steps.indexOf(state.step);
  const imported = isImport(state.source);

  // Focus goes back to the opener when the wizard closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  // Initial focus per step: a requested field, else the step's [data-autofocus] control, else its heading.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const requested = focusNext.current ? document.getElementById(focusNext.current) : null;
    focusNext.current = null;
    const marked = [...body.querySelectorAll<HTMLElement>('[data-autofocus]')]
      .map((el) => (el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)))
      .find((el): el is HTMLElement => el !== null);
    (requested ?? marked ?? headingRef.current)?.focus();
  }, [state.step, done, state.importProjectId, focusTick]);

  // Focus never rests outside the dialog: a removed or disabled control drops it to the body.
  useEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog && (!active || active === document.body || !dialog.contains(active))) {
      (headingRef.current ?? dialog).focus();
    }
  });

  const go = useCallback(
    (step: StepId, focusId?: string) => {
      focusNext.current = focusId ?? null;
      setActionError(null);
      dispatch({ type: 'go', step });
    },
    [dispatch],
  );

  const close = () => {
    if (state.importProjectId !== null) onProjectsChanged();
    const to = leaveTo.current;
    leaveTo.current = null;
    onClose();
    if (to) navigate(to);
  };

  /** Escape, the backdrop, the close button and the Settings link: a dirty wizard asks first. */
  const requestClose = () => {
    if (busy) {
      leaveTo.current = null;
      return;
    }
    if (done || !isDirty(state)) close();
    else setConfirmClose(true);
  };

  const keepEditing = () => {
    leaveTo.current = null;
    setConfirmClose(false);
    refocus('wizard-close');
  };

  const leaveForSettings = (e: MouseEvent) => {
    e.preventDefault();
    leaveTo.current = '/settings';
    requestClose();
  };

  // Escape and the Tab trap listen on the document, so they work even when focus has slipped out.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmClose) keepEditing();
      else requestClose();
    } else {
      trapTab(dialogRef.current, e);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const registerImport = async () => {
    setBusy(state.source === 'import_url' ? 'Starting the clone…' : 'Registering the folder…');
    try {
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', buildCreateBody(state));
      onProjectsChanged();
      dispatch({ type: 'importCreated', projectId: res.project.id });
    } catch (err) {
      if (isNameConflict(err)) {
        dispatch({ type: 'nameError', message: errorMessage(err) });
        document.getElementById('wizard-name')?.focus();
      } else {
        setActionError(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy(imported ? 'Importing…' : 'Creating the project…');
    try {
      const res = imported
        ? await api<AdoptProjectResponse>(`/api/projects/${state.importProjectId}/adopt`, 'POST', buildAdoptBody(state))
        : await api<CreateProjectResponse>('/api/projects', 'POST', await buildCreateBodyWithFiles(state));
      const name = state.name.trim();
      // The project exists now: a failing refresh must not look like a failed create.
      await Promise.resolve(onCreated(res.project)).catch(() => undefined);
      // Reset only now, together with the close or the warning view: no flash of the Start step.
      finish();
      if (res.warning) setDone({ name, warning: res.warning });
      else onClose();
    } catch (err) {
      const materialsProblem = imported ? null : materialsErrorMessage(err);
      if (!imported && isNameConflict(err)) {
        dispatch({ type: 'nameError', message: errorMessage(err) });
        go('type', 'wizard-name');
      } else if (materialsProblem) {
        dispatch({ type: 'materialsError', message: materialsProblem });
        go('type', 'wizard-materials');
      } else {
        setActionError(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  };

  const onNext = () => {
    setActionError(null);
    if (state.step === 'repo') void registerImport();
    else if (state.step === 'summary') void create();
    else {
      const n = nextStep(state);
      if (n) go(n);
    }
  };

  const onDetected = useCallback((detect: ProjectDetectResponse) => dispatch({ type: 'detected', detect }), [dispatch]);
  const onRecreated = useCallback(
    (projectId: string) => {
      onProjectsChanged();
      dispatch({ type: 'importCreated', projectId });
    },
    [dispatch, onProjectsChanged],
  );
  const onCancelled = useCallback(
    (failure?: { message: string; onName: boolean }) => {
      onProjectsChanged();
      focusNext.current = failure?.onName ? 'wizard-name' : null;
      dispatch({ type: 'importCancelled' });
      if (failure?.onName) dispatch({ type: 'nameError', message: failure.message });
      else if (failure) setActionError(failure.message);
    },
    [dispatch, onProjectsChanged],
  );

  const problem = stepProblem(state, state.step);
  const cloneBlocked = state.step === 'repo' && state.source === 'import_url' && runnerDown;
  const summaryBlocked = state.step === 'summary' && !preview.ready;
  const nextDisabled = busy !== null || problem !== null || cloneBlocked || summaryBlocked || state.step === 'import';
  const hint =
    busy ??
    problem ??
    (cloneBlocked
      ? 'The runner is not connected.'
      : state.step === 'summary'
        ? preview.error
          ? 'Fix the preview error first.'
          : preview.loading
            ? 'Building the preview…'
            : ''
        : '');
  const nextLabel =
    state.step === 'repo'
      ? state.source === 'import_url'
        ? 'Clone'
        : 'Use this folder'
      : state.step === 'summary'
        ? imported
          ? 'Finish import'
          : state.startFactory
            ? 'Create and start'
            : 'Create project'
        : 'Next';
  const back = previousStep(state);

  return (
    <div
      className="wizard-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <header className="wizard-top">
          <div className="wizard-top-title">
            <h2 id="wizard-title">New project</h2>
            {!done && (
              <span className="wizard-top-step muted small">
                Step {index + 1} of {steps.length} · {stepLabel(state.step, state.source)}
              </span>
            )}
          </div>
          <button id="wizard-close" type="button" className="icon-btn" aria-label="Close" onClick={requestClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>

        {!done && (
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
                      onClick={() => go(step)}
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
        )}

        <div className="wizard-body" ref={bodyRef}>
          {done ? (
            <div className="wizard-step">
              <h3 className="wizard-step-title" tabIndex={-1} ref={headingRef}>
                {done.name} was created
              </h3>
              <p className="banner banner-warn" role="alert">
                {done.warning}
              </p>
              <div className="actions">
                <button type="button" className="btn btn-primary" data-autofocus="" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              <h3 className="wizard-step-title" tabIndex={-1} ref={headingRef}>
                {stepLabel(state.step, state.source)}
              </h3>
              {state.step === 'start' && (
                <StepStart
                  state={state}
                  dispatch={dispatch}
                  hasFolders={hasImportableFolders(folders)}
                  savedDraft={savedDraft}
                  onRestore={() => {
                    restore();
                    refocus();
                  }}
                  onDismissDraft={() => {
                    dismissDraft();
                    refocus();
                  }}
                />
              )}
              {state.step === 'type' && <StepType state={state} dispatch={dispatch} />}
              {state.step === 'repo' && <StepRepo state={state} dispatch={dispatch} folders={folders} runnerDown={runnerDown} />}
              {state.step === 'import' && imported && state.importProjectId && (
                <ImportProgress
                  key={state.importProjectId}
                  source={state.source as 'import_url' | 'import_folder'}
                  projectId={state.importProjectId}
                  createBody={buildCreateBody(state)}
                  onDetected={onDetected}
                  onRecreated={onRecreated}
                  onCancelled={onCancelled}
                />
              )}
              {state.step === 'stack' && <StepStack state={state} dispatch={dispatch} />}
              {state.step === 'factory' && (
                <StepFactory
                  state={state}
                  dispatch={dispatch}
                  factory={factory.data}
                  factoryError={factory.error !== undefined && !factory.data ? errorMessage(factory.error) : null}
                  onEditDeploy={() => go('stack', 'wizard-dim-deploy')}
                  onSettings={leaveForSettings}
                />
              )}
              {state.step === 'summary' && <StepSummary state={state} dispatch={dispatch} preview={preview} onEdit={go} />}
            </>
          )}
        </div>

        {!done && (
          <footer className="wizard-foot">
            {confirmClose ? (
              <div className="wizard-confirm" role="alert">
                <span className="small">
                  {state.importProjectId !== null
                    ? 'Close the wizard? The imported project stays in your list, without Emberline files.'
                    : 'Discard this project setup? You can restore it the next time you open the wizard.'}
                </span>
                <div className="actions">
                  <button type="button" className="btn btn-sm" onClick={close}>
                    {state.importProjectId !== null ? 'Close' : 'Discard'}
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={keepEditing}>
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
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null || back === null}
                    onClick={() => back && go(back)}
                  >
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
        )}
      </div>
    </div>
  );
}

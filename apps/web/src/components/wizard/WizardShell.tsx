import type {
  AdoptProjectResponse,
  CreateProjectResponse,
  FactorySettings,
  ImportSshKey,
  Project,
  ProjectDetectResponse,
  SshKeyResponse,
  WorkspaceFolder,
  WorkspaceFoldersResponse,
} from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, ApiRequestError, errorMessage } from '../../api';
import { trapTab } from '../../focusTrap';
import { useApi } from '../../hooks/useApi';
import { ImportProgress } from './ImportProgress';
import { materialsErrorField, materialsErrorMessage } from './materials';
import { StepFactory } from './StepFactory';
import { StepStack } from './StepStack';
import { StepRepo, StepStart } from './StepStart';
import { StepSummary, useSummaryPreview } from './StepSummary';
import { StepType } from './StepType';
import { useWizardState } from './useWizardState';
import { stepGuidance, WizardDoneView, WizardFooter, WizardRail, WizardTopBar } from './WizardChrome';
import {
  buildAdoptBody,
  buildCreateBody,
  buildCreateBodyWithFiles,
  hasImportableFolders,
  importWaitHint,
  isDirty,
  isImport,
  isNameConflict,
  nextStep,
  previousStep,
  repoIsSsh,
  repoNextLabel,
  sshKeyStepProblem,
  type StepId,
  stepLabel,
  stepProblem,
  stepsFor,
} from './wizardLogic';
import './wizard-ux.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  return props.open ? <WizardShell {...props} /> : null;
}

function useWorkspaceFolders(): WorkspaceFolder[] {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<WorkspaceFoldersResponse>('/api/workspaces/folders').then(
      (res) => !cancelled && setFolders(res.folders),
      () => undefined,
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
  const [importSshKey, setImportSshKey] = useState<ImportSshKey | null | undefined>(undefined);
  const [waitingForKey, setWaitingForKey] = useState(false);
  const queryClient = useQueryClient();
  const sharedKey = useQuery({
    queryKey: ['api', '/api/ssh-key'],
    queryFn: () => api<SshKeyResponse>('/api/ssh-key'),
    enabled: repoIsSsh(state),
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const refocus = (id?: string) => {
    focusNext.current = id ?? null;
    setFocusTick((t) => t + 1);
  };
  const leaveTo = useRef<string | null>(null);
  const [, navigate] = useLocation();

  const steps = stepsFor(state.source);
  const index = steps.indexOf(state.step);
  const imported = isImport(state.source);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

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
    const body = buildCreateBody(state);
    setBusy(
      state.source !== 'import_url'
        ? 'Registering the folder…'
        : 'sshKeyChoice' in body
          ? "Creating the project's key…"
          : 'Starting the clone…',
    );
    try {
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', body);
      onProjectsChanged();
      setImportSshKey(res.importStatus === 'awaiting_key' ? (res.sshKey ?? null) : undefined);
      dispatch({ type: 'importCreated', projectId: res.project.id });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'ssh_key_missing')
        void queryClient.invalidateQueries({ queryKey: ['api', '/api/ssh-key'] });
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
        ? await api<AdoptProjectResponse>(
            `/api/projects/${state.importProjectId}/adopt`,
            'POST',
            buildAdoptBody(state),
          )
        : await api<CreateProjectResponse>('/api/projects', 'POST', await buildCreateBodyWithFiles(state));
      const name = state.name.trim();
      await Promise.resolve(onCreated(res.project)).catch(() => undefined);
      finish();
      if (res.warning) setDone({ name, warning: res.warning });
      else onClose();
    } catch (err) {
      const field = materialsErrorField(err);
      const materialsProblem = imported ? null : materialsErrorMessage(err, state.materials.length > 0);
      if (!imported && isNameConflict(err)) {
        dispatch({ type: 'nameError', message: errorMessage(err) });
        go('type', 'wizard-name');
      } else if (materialsProblem) {
        dispatch({ type: 'materialsError', message: materialsProblem, field });
        go('type', field === 'links' ? 'wizard-links' : 'wizard-materials');
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

  const onDetected = useCallback(
    (detect: ProjectDetectResponse) => dispatch({ type: 'detected', detect }),
    [dispatch],
  );
  const onRecreated = useCallback(
    (projectId: string) => {
      setImportSshKey(undefined);
      onProjectsChanged();
      dispatch({ type: 'importCreated', projectId });
    },
    [dispatch, onProjectsChanged],
  );
  const onCancelled = useCallback(
    (failure?: { message: string; onName: boolean }) => {
      setImportSshKey(undefined);
      onProjectsChanged();
      focusNext.current = failure?.onName ? 'wizard-name' : null;
      dispatch({ type: 'importCancelled' });
      if (failure?.onName) dispatch({ type: 'nameError', message: failure.message });
      else if (failure) setActionError(failure.message);
    },
    [dispatch, onProjectsChanged],
  );

  const problem =
    importWaitHint(state, waitingForKey) ??
    stepProblem(state, state.step) ??
    (sharedKey.isError ? null : sshKeyStepProblem(state, sharedKey.data));
  const cloneBlocked = state.step === 'repo' && state.source === 'import_url' && runnerDown;
  const summaryBlocked = state.step === 'summary' && !preview.ready;
  const nextDisabled =
    busy !== null || problem !== null || cloneBlocked || summaryBlocked || state.step === 'import';
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
      ? repoNextLabel(state)
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
      <div ref={dialogRef} className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <WizardTopBar
          done={done !== null}
          index={index}
          total={steps.length}
          step={state.step}
          source={state.source}
          onClose={requestClose}
        />
        {!done && <WizardRail steps={steps} state={state} busy={busy} onSelectStep={go} />}
        <div className="wizard-body" ref={bodyRef}>
          {done ? (
            <WizardDoneView
              name={done.name}
              warning={done.warning}
              headingRef={headingRef}
              onClose={onClose}
            />
          ) : (
            <>
              <h3 className="wizard-step-title" tabIndex={-1} ref={headingRef}>
                {stepLabel(state.step, state.source)}
              </h3>
              <p className="wizard-step-lead">{stepGuidance(state.step, state.source)}</p>
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
              {state.step === 'repo' && (
                <StepRepo state={state} dispatch={dispatch} folders={folders} runnerDown={runnerDown} />
              )}
              {state.step === 'import' && imported && state.importProjectId && (
                <ImportProgress
                  key={state.importProjectId}
                  source={state.source as 'import_url' | 'import_folder'}
                  projectId={state.importProjectId}
                  createBody={buildCreateBody(state)}
                  initialSshKey={importSshKey}
                  onWaitingForKey={setWaitingForKey}
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
                  factoryError={
                    factory.error !== undefined && !factory.data ? errorMessage(factory.error) : null
                  }
                  onEditDeploy={() => go('stack', 'wizard-dim-deploy')}
                  onSettings={leaveForSettings}
                />
              )}
              {state.step === 'summary' && (
                <StepSummary state={state} dispatch={dispatch} preview={preview} onEdit={go} />
              )}
            </>
          )}
        </div>
        {!done && (
          <WizardFooter
            confirmClose={confirmClose}
            importProjectId={state.importProjectId}
            actionError={actionError}
            hint={hint}
            busy={busy}
            back={back}
            nextDisabled={nextDisabled}
            nextLabel={nextLabel}
            onConfirmClose={close}
            onKeepEditing={keepEditing}
            onBack={() => back && go(back)}
            onNext={onNext}
          />
        )}
      </div>
    </div>
  );
}

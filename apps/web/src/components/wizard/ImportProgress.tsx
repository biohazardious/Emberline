import {
  type CreateProjectBody,
  type CreateProjectResponse,
  type ImportStatusResponse,
  PROJECT_CONFLICT,
  type ProjectDetectResponse,
} from '@emberline/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { isNameConflict } from './wizardLogic';

type Phase =
  | { kind: 'cloning'; tail: string; note: string | null }
  | { kind: 'detecting' }
  | { kind: 'cloneFailed'; exitCode: number | null; tail: string }
  | { kind: 'detectFailed'; message: string }
  | { kind: 'busy'; label: string };

const POLL_MS = 1_000;

/**
 * Clone progress (status polling with the clone terminal's tail), then detection. A failed clone
 * offers Try again (remove the failed project and clone afresh) and Cancel (remove it). A folder
 * import goes straight to detection; Cancel unregisters it and never deletes the folder.
 */
export function ImportProgress({
  source,
  projectId,
  createBody,
  onDetected,
  onRecreated,
  onCancelled,
}: {
  source: 'import_url' | 'import_folder';
  projectId: string;
  /** The body that registered the project, for Try again. */
  createBody: CreateProjectBody;
  onDetected: (detect: ProjectDetectResponse) => void;
  onRecreated: (projectId: string) => void;
  /** The project is gone; `failure` when a Try again could not register it again. */
  onCancelled: (failure?: { message: string; onName: boolean }) => void;
}) {
  const [phase, setPhase] = useState<Phase>(source === 'import_url' ? { kind: 'cloning', tail: '', note: null } : { kind: 'detecting' });
  const [actionError, setActionError] = useState<string | null>(null);
  const alive = useRef(true);
  const terminalId = useRef<string | null>(null);
  // Detection is handed over once: a second answer (StrictMode, a retry race) must not reset edits.
  const delivered = useRef(false);
  // A new callback identity must not restart the polling.
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const detect = useCallback(async () => {
    setPhase({ kind: 'detecting' });
    try {
      const res = await api<ProjectDetectResponse>(`/api/projects/${projectId}/detect`);
      if (alive.current && !delivered.current) {
        delivered.current = true;
        onDetectedRef.current(res);
      }
    } catch (err) {
      if (alive.current) setPhase({ kind: 'detectFailed', message: errorMessage(err) });
    }
  }, [projectId]);

  // Poll the clone; a failed poll (runner restarting) is shown and retried, never fatal.
  useEffect(() => {
    if (source !== 'import_url') {
      void detect();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await api<ImportStatusResponse>(`/api/projects/${projectId}/import-status`);
        if (stopped) return;
        terminalId.current = s.terminalId ?? terminalId.current;
        if (s.status === 'cloning') {
          setPhase({ kind: 'cloning', tail: s.tail, note: null });
          timer = setTimeout(() => void poll(), POLL_MS);
        } else if (s.status === 'ready') {
          void detect();
        } else {
          setPhase({ kind: 'cloneFailed', exitCode: s.exitCode, tail: s.tail });
        }
      } catch (err) {
        if (stopped) return;
        setPhase((p) => ({
          kind: 'cloning',
          tail: p.kind === 'cloning' ? p.tail : '',
          note: `Couldn't read the clone status (${errorMessage(err)}); trying again.`,
        }));
        timer = setTimeout(() => void poll(), POLL_MS * 3);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, projectId, detect]);

  /** Stops a clone still running, then removes the registered project; a folder import keeps the folder itself. */
  const remove = async () => {
    if (terminalId.current) {
      await api(`/api/terminals/${terminalId.current}`, 'DELETE').catch(() => undefined);
      terminalId.current = null;
    }
    await api(`/api/projects/${projectId}${source === 'import_folder' ? '?deleteFiles=0' : ''}`, 'DELETE');
  };

  const retry = async () => {
    setActionError(null);
    if (source === 'import_folder' || phase.kind === 'detectFailed') {
      void detect();
      return;
    }
    const before = phase;
    setPhase({ kind: 'busy', label: 'Removing the failed clone…' });
    try {
      await remove();
    } catch (err) {
      if (!alive.current) return;
      setActionError(errorMessage(err));
      setPhase(before);
      return;
    }
    setPhase({ kind: 'busy', label: 'Cloning again…' });
    try {
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', createBody);
      if (alive.current) onRecreated(res.project.id);
    } catch (err) {
      if (!alive.current) return;
      // The failed project is already removed: back to the repository step with the reason.
      const leftover = err instanceof ApiRequestError && err.code === PROJECT_CONFLICT.directoryExists;
      onCancelled({
        message: leftover
          ? `The failed clone's folder could not be removed (${err.message}). Pick another name, or remove the folder and try again.`
          : errorMessage(err),
        onName: isNameConflict(err),
      });
    }
  };

  const cancel = async () => {
    setActionError(null);
    const before = phase;
    setPhase({ kind: 'busy', label: 'Removing the project…' });
    try {
      await remove();
      if (alive.current) onCancelled();
    } catch (err) {
      if (!alive.current) return;
      setActionError(errorMessage(err));
      setPhase(before);
    }
  };

  const failed = phase.kind === 'cloneFailed' || phase.kind === 'detectFailed';

  // The buttons swap with the phase: keep focus on what replaced the one that was pressed.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lastKind = useRef(phase.kind);
  useEffect(() => {
    const was = lastKind.current;
    lastKind.current = phase.kind;
    if (was === phase.kind) return;
    if (phase.kind === 'busy') statusRef.current?.focus();
    else if (failed) retryRef.current?.focus();
    else if (was === 'busy') cancelRef.current?.focus();
  }, [phase.kind, failed]);
  const tail = phase.kind === 'cloning' || phase.kind === 'cloneFailed' ? phase.tail : '';
  const status =
    phase.kind === 'cloning'
      ? 'Cloning the repository…'
      : phase.kind === 'detecting'
        ? 'Inspecting the repository (files only; no project code runs)…'
        : phase.kind === 'cloneFailed'
          ? `The clone failed${phase.exitCode !== null ? ` (exit ${phase.exitCode})` : ''}.`
          : phase.kind === 'detectFailed'
            ? `Couldn't inspect the repository: ${phase.message}`
            : phase.label;

  return (
    <div className="wizard-step">
      <p ref={statusRef} tabIndex={-1} className={failed ? 'form-error' : 'wizard-status'} role={failed ? 'alert' : 'status'}>
        {status}
      </p>
      {phase.kind === 'cloning' && phase.note && <p className="muted small">{phase.note}</p>}
      {source === 'import_url' && (tail || phase.kind === 'cloning') && (
        <pre className="wizard-tail mono" tabIndex={0} aria-label="Clone output">
          {tail || 'Waiting for output…'}
        </pre>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {(failed || phase.kind === 'cloning') && (
        <div className="actions">
          {failed && (
            <button ref={retryRef} type="button" className="btn btn-sm btn-primary" data-autofocus="" onClick={() => void retry()}>
              Try again
            </button>
          )}
          <button ref={cancelRef} type="button" className="btn btn-sm" onClick={() => void cancel()}>
            {source === 'import_folder' ? 'Cancel (keeps the folder)' : 'Cancel and remove the clone'}
          </button>
        </div>
      )}
    </div>
  );
}

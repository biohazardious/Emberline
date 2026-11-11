import {
  type CreateProjectBody,
  type CreateProjectResponse,
  type HostKeyDetails,
  type ImportCloneResponse,
  type ImportSshKey,
  type ImportStatusResponse,
  PROJECT_CONFLICT,
  type ProjectDetectResponse,
  type ProjectSshKeyResponse,
  type SshKeyResponse,
  type SshRemoteProblem,
} from '@emberline/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import {
  deployKeyHint,
  isSshAddress,
  keyInUse,
  OWN_KEY_BUTTON,
  SHARED_KEY_HINT,
  sshProblemFor,
} from '../../sshKeys';
import { HostKeyChangedNote, HostKeyTrust } from '../HostKeyTrust';
import { SshKeyLine } from '../SshKeyLine';
import { cloneFailedText, isNameConflict } from './wizardLogic';

type Phase =
  | { kind: 'cloning'; tail: string; note: string | null }
  /** An import with its own key: nothing cloned until the key is on the forge and Clone now is pressed. */
  | { kind: 'awaitingKey'; sshKey: ImportSshKey | null }
  | { kind: 'detecting' }
  | {
      kind: 'cloneFailed';
      exitCode: number | null;
      tail: string;
      reason: string | undefined;
      code?: SshRemoteProblem;
      hostKey?: HostKeyDetails;
    }
  | { kind: 'detectFailed'; message: string }
  | { kind: 'busy'; label: string };

const POLL_MS = 1_000;

/**
 * Clone progress (status polling with the clone terminal's tail), then detection. A failed clone
 * offers Try again and Cancel (remove the project). Try again clones an ssh address again into the
 * same project, keeping its key (`import-clone`, Ruling 21), after the fix the failure offers (trust
 * the host key, make a key, add the key on the forge); any other address is removed and cloned
 * afresh. An import with its own key waits for Clone now. A folder import goes straight to
 * detection; Cancel unregisters it and never deletes the folder.
 */
export function ImportProgress({
  source,
  projectId,
  createBody,
  initialSshKey,
  onDetected,
  onRecreated,
  onCancelled,
}: {
  source: 'import_url' | 'import_folder';
  projectId: string;
  /** The body that registered the project, for Try again. */
  createBody: CreateProjectBody;
  /** The create answered `awaiting_key` with this key: show it at once (the first status read confirms it). */
  initialSshKey?: ImportSshKey | null;
  onDetected: (detect: ProjectDetectResponse) => void;
  onRecreated: (projectId: string) => void;
  /** The project is gone; `failure` when a Try again could not register it again. */
  onCancelled: (failure?: { message: string; onName: boolean }) => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    source !== 'import_url'
      ? { kind: 'detecting' }
      : initialSshKey !== undefined
        ? { kind: 'awaitingKey', sshKey: initialSshKey }
        : { kind: 'cloning', tail: '', note: null },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped to poll again after `import-clone` started a clone. */
  const [pollRun, setPollRun] = useState(0);
  /** The project's keys, read after an ssh failure: the key in use is shown with where to add it. */
  const [keys, setKeys] = useState<ProjectSshKeyResponse | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const repoUrl = createBody.repoUrl ?? '';
  const ssh = source === 'import_url' && isSshAddress(repoUrl);
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
        } else if (s.status === 'awaiting_key') {
          setPhase({ kind: 'awaitingKey', sshKey: s.sshKey ?? null });
        } else {
          setPhase({
            kind: 'cloneFailed',
            exitCode: s.exitCode,
            tail: s.tail,
            reason: s.reason,
            ...(s.code ? { code: s.code } : {}),
            ...(s.hostKey ? { hostKey: s.hostKey } : {}),
          });
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
    // A project waiting for its key answers `awaiting_key` (no clone runs); Clone now polls again.
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, projectId, detect, pollRun]);

  // After an ssh failure: which key the project uses, to show it (and offer to make one).
  const failedOverSsh = ssh && phase.kind === 'cloneFailed';
  const readKeys = useCallback(async () => {
    try {
      const res = await api<ProjectSshKeyResponse>(`/api/projects/${projectId}/ssh-key`);
      if (alive.current) setKeys(res);
    } catch {
      // Only help text depends on it; the failure and Try again stay.
    }
  }, [projectId]);
  useEffect(() => {
    if (failedOverSsh) void readKeys();
  }, [failedOverSsh, readKeys]);

  /** Stops a clone still running, then removes the registered project; a folder import keeps the folder itself. */
  const remove = async () => {
    if (terminalId.current) {
      await api(`/api/terminals/${terminalId.current}`, 'DELETE').catch(() => undefined);
      terminalId.current = null;
    }
    await api(`/api/projects/${projectId}${source === 'import_folder' ? '?deleteFiles=0' : ''}`, 'DELETE');
  };

  /** The project has its own key (a deploy key that goes with the project on Cancel or a fresh clone). */
  const ownKey =
    createBody.sshKeyChoice === 'own' ||
    (phase.kind === 'awaitingKey' && phase.sshKey !== null) ||
    (keys?.key ?? null) !== null;

  /** Removes the failed project and registers it again from the same body (a new clone). */
  const recreate = async (before: Phase) => {
    setActionError(null);
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

  /** Clones again into the same project, keeping it and its key (`import-clone`). */
  const cloneAgain = async () => {
    setActionError(null);
    const before = phase;
    setPhase({ kind: 'busy', label: 'Starting the clone…' });
    try {
      const res = await api<ImportCloneResponse>(`/api/projects/${projectId}/import-clone`, 'POST');
      if (!alive.current) return;
      terminalId.current = res.terminalId;
      setKeys(null);
      setPhase({ kind: 'cloning', tail: '', note: null });
      setPollRun((n) => n + 1);
    } catch (err) {
      if (!alive.current) return;
      // A failed clone left files behind (a tag checked out, say): with the shared key nothing is
      // lost by cloning afresh, as for https; a project's own key would be, so it says so instead.
      if (
        err instanceof ApiRequestError &&
        err.code === PROJECT_CONFLICT.directoryExists &&
        before.kind === 'cloneFailed' &&
        !ownKey
      ) {
        void recreate(before);
        return;
      }
      setActionError(
        err instanceof ApiRequestError && err.code === PROJECT_CONFLICT.directoryExists
          ? `The failed clone left files in the project's folder (${err.message}). Cancel removes the project and its key; then import it again.`
          : errorMessage(err),
      );
      setPhase(before);
    }
  };

  const retry = async () => {
    setActionError(null);
    if (source === 'import_folder' || phase.kind === 'detectFailed') {
      void detect();
      return;
    }
    if (ssh) {
      void cloneAgain();
      return;
    }
    void recreate(phase);
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

  /** Makes a key the failure or the wait asks for: the shared key, the project's key, or switches the project to its own. */
  const makeKey = async (how: 'shared' | 'own' | 'chooseOwn') => {
    setKeyBusy(true);
    setActionError(null);
    try {
      if (how === 'shared') {
        await api<SshKeyResponse>('/api/ssh-key', 'POST');
        await readKeys();
        return;
      }
      const res =
        how === 'own'
          ? await api<ProjectSshKeyResponse>(`/api/projects/${projectId}/ssh-key`, 'POST')
          : await api<ProjectSshKeyResponse>(`/api/projects/${projectId}/ssh-key-choice`, 'PUT', {
              choice: 'own',
            });
      if (!alive.current) return;
      setKeys(res);
      const made = res.key;
      if (made)
        setPhase((p) =>
          p.kind === 'awaitingKey'
            ? { kind: 'awaitingKey', sshKey: { publicKey: made.publicKey, fingerprint: made.fingerprint } }
            : p,
        );
    } catch (err) {
      if (alive.current) setActionError(errorMessage(err));
    } finally {
      if (alive.current) setKeyBusy(false);
    }
  };

  const failed = phase.kind === 'cloneFailed' || phase.kind === 'detectFailed';
  const waiting = phase.kind === 'awaitingKey';

  // The buttons swap with the phase: keep focus on what replaced the one that was pressed.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const cloneRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lastKind = useRef(phase.kind);
  useEffect(() => {
    const was = lastKind.current;
    lastKind.current = phase.kind;
    if (was === phase.kind) return;
    if (phase.kind === 'busy') statusRef.current?.focus();
    else if (failed) retryRef.current?.focus();
    else if (phase.kind === 'awaitingKey') cloneRef.current?.focus();
    else if (was === 'busy') cancelRef.current?.focus();
  }, [phase.kind, failed]);
  const tail = phase.kind === 'cloning' || phase.kind === 'cloneFailed' ? phase.tail : '';
  const status =
    phase.kind === 'cloning'
      ? 'Cloning the repository…'
      : phase.kind === 'awaitingKey'
        ? phase.sshKey
          ? "Add this project's key to the repository, then clone."
          : "This project's key was deleted. Make a new one, add it to the repository, then clone."
        : phase.kind === 'detecting'
          ? 'Inspecting the repository (files only; no project code runs)…'
          : phase.kind === 'cloneFailed'
            ? cloneFailedText(phase.exitCode, phase.reason)
            : phase.kind === 'detectFailed'
              ? `Couldn't inspect the repository: ${phase.message}`
              : phase.label;

  const problem = phase.kind === 'cloneFailed' ? sshProblemFor(repoUrl, phase.code) : null;
  // Trusting is the way on: a plain Try again would meet the same unknown key.
  const trustOffered = problem === 'host_key_unknown' && phase.kind === 'cloneFailed' && !!phase.hostKey;
  const inUse = keys ? keyInUse(keys) : null;
  const ownChosen = keys?.choice === 'own';

  return (
    <div className="wizard-step">
      <p
        ref={statusRef}
        tabIndex={-1}
        className={failed ? 'form-error' : 'wizard-status'}
        role={failed ? 'alert' : 'status'}
      >
        {status}
      </p>
      {phase.kind === 'cloning' && phase.note && <p className="muted small">{phase.note}</p>}
      {phase.kind === 'awaitingKey' && (
        <div className="wizard-ssh-key">
          {phase.sshKey ? (
            <>
              <p className="muted small">
                Fingerprint <span className="mono">{phase.sshKey.fingerprint}</span>
              </p>
              <SshKeyLine publicKey={phase.sshKey.publicKey} copyLabel="Copy" />
              <p className="muted small">{deployKeyHint(repoUrl)}</p>
            </>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={keyBusy}
                onClick={() => void makeKey('own')}
              >
                {keyBusy ? 'Creating…' : "Create this project's key"}
              </button>
            </div>
          )}
        </div>
      )}
      {source === 'import_url' && (tail || phase.kind === 'cloning') && (
        <pre className="wizard-tail mono" tabIndex={0} aria-label="Clone output">
          {tail || 'Waiting for output…'}
        </pre>
      )}
      {trustOffered && phase.kind === 'cloneFailed' && phase.hostKey && (
        <HostKeyTrust hostKey={phase.hostKey} trustLabel="Trust and try again" onTrusted={cloneAgain} />
      )}
      {problem === 'host_key_changed' && phase.kind === 'cloneFailed' && (
        <HostKeyChangedNote hostKey={phase.hostKey} newTab />
      )}
      {(problem === 'auth_refused' || problem === 'ssh_key_missing') && keys && (
        <div className="wizard-ssh-key">
          {inUse ? (
            <>
              <p className="small">
                The clone uses {ownChosen ? "this project's own key" : "Emberline's shared key"}{' '}
                <span className="muted mono">({inUse.fingerprint})</span>. Add its public key, then try again.
              </p>
              <SshKeyLine publicKey={inUse.publicKey} copyLabel="Copy" />
              <p className="muted small">{ownChosen ? deployKeyHint(repoUrl) : SHARED_KEY_HINT}</p>
            </>
          ) : (
            <div className="actions">
              {ownChosen ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={keyBusy}
                  onClick={() => void makeKey('own')}
                >
                  Create this project&apos;s key
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={keyBusy}
                    onClick={() => void makeKey('shared')}
                  >
                    Create a shared key
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={keyBusy}
                    onClick={() => void makeKey('chooseOwn')}
                  >
                    {OWN_KEY_BUTTON}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {(failed || waiting || phase.kind === 'cloning') && (
        <div className="actions">
          {failed && !trustOffered && (
            <button
              ref={retryRef}
              type="button"
              className="btn btn-sm btn-primary"
              data-autofocus=""
              disabled={keyBusy}
              onClick={() => void retry()}
            >
              Try again
            </button>
          )}
          {phase.kind === 'awaitingKey' && (
            <button
              ref={cloneRef}
              type="button"
              className="btn btn-sm btn-primary"
              data-autofocus=""
              disabled={keyBusy || !phase.sshKey}
              onClick={() => void cloneAgain()}
            >
              Clone now
            </button>
          )}
          <button ref={cancelRef} type="button" className="btn btn-sm" onClick={() => void cancel()}>
            {source === 'import_folder'
              ? 'Cancel (keeps the folder)'
              : waiting
                ? 'Cancel and remove the project'
                : 'Cancel and remove the clone'}
          </button>
        </div>
      )}
      {source === 'import_url' && ownKey && (failed || waiting || phase.kind === 'cloning') && (
        <p className="muted small">
          Cancel removes the project and its own key. If you already added the key to the repository, remove
          the deploy key there too.
        </p>
      )}
    </div>
  );
}

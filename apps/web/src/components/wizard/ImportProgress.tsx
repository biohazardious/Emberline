import {
  type CreateProjectBody,
  type CreateProjectResponse,
  type ImportCloneResponse,
  type ImportSshKey,
  type ImportStatusResponse,
  PROJECT_CONFLICT,
  type ProjectDetectResponse,
  type ProjectSshKeyResponse,
  type SshKeyResponse,
} from '@emberline/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { isSshAddress, sshProblemFor } from '../../sshKeys';
import {
  ImportAwaitingKeyBox,
  type ImportPhase,
  ImportProgressSteps,
  ImportSshFailureBox,
} from './ImportSshHelp';
import { cloneFailedText, isNameConflict } from './wizardLogic';
import './wizard-ux.css';

const POLL_MS = 1_000;

/**
 * Clone progress (status polling with the clone terminal's tail), then detection. A failed clone
 * offers Try again and Cancel (remove the project).
 */
export function ImportProgress({
  source,
  projectId,
  createBody,
  initialSshKey,
  onWaitingForKey,
  onDetected,
  onRecreated,
  onCancelled,
  keepProject = false,
  confirmCancel,
}: {
  source: 'import_url' | 'import_folder';
  projectId: string;
  createBody: CreateProjectBody;
  initialSshKey?: ImportSshKey | null;
  onWaitingForKey?: (waiting: boolean) => void;
  onDetected: (detect: ProjectDetectResponse) => void;
  onRecreated: (projectId: string) => void;
  onCancelled: (failure?: { message: string; onName: boolean }) => void;
  keepProject?: boolean;
  confirmCancel?: string;
}) {
  const [phase, setPhase] = useState<ImportPhase>(
    source !== 'import_url'
      ? { kind: 'detecting' }
      : initialSshKey !== undefined
        ? { kind: 'awaitingKey', sshKey: initialSshKey }
        : { kind: 'cloning', tail: '', note: null },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollRun, setPollRun] = useState(0);
  const [keys, setKeys] = useState<ProjectSshKeyResponse | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const repoUrl = createBody.repoUrl ?? '';
  const ssh = source === 'import_url' && isSshAddress(repoUrl);
  const alive = useRef(true);
  const terminalId = useRef<string | null>(null);
  const delivered = useRef(false);
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
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, projectId, detect, pollRun]);

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

  const remove = async () => {
    if (terminalId.current) {
      await api(`/api/terminals/${terminalId.current}`, 'DELETE').catch(() => undefined);
      terminalId.current = null;
    }
    await api(`/api/projects/${projectId}${source === 'import_folder' ? '?deleteFiles=0' : ''}`, 'DELETE');
  };

  const ownKey =
    createBody.sshKeyChoice === 'own' ||
    (phase.kind === 'awaitingKey' && phase.sshKey !== null) ||
    keys?.choice === 'own' ||
    (keys?.key ?? null) !== null;
  const ownKeyNow =
    keys !== null ? keys.key !== null : phase.kind === 'awaitingKey' ? phase.sshKey !== null : null;
  const [ownKeyKnown, setOwnKeyKnown] = useState(false);
  if (ownKeyNow !== null && ownKeyNow !== ownKeyKnown) setOwnKeyKnown(ownKeyNow);
  const hasOwnKey = ownKeyNow ?? ownKeyKnown;

  const recreate = async (before: ImportPhase) => {
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
      const leftover = err instanceof ApiRequestError && err.code === PROJECT_CONFLICT.directoryExists;
      onCancelled({
        message: leftover
          ? `The failed clone's folder could not be removed (${err.message}). Pick another name, or remove the folder and try again.`
          : errorMessage(err),
        onName: isNameConflict(err),
      });
    }
  };

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
      const leftover = err instanceof ApiRequestError && err.code === PROJECT_CONFLICT.directoryExists;
      if (leftover && !keepProject && before.kind === 'cloneFailed' && keys !== null && !ownKey) {
        void recreate(before);
        return;
      }
      setActionError(
        !leftover
          ? errorMessage(err)
          : keepProject
            ? `The failed clone left files in the project's folder (${err.message}); Emberline never clones into them or removes them. Remove what is in the folder (from a terminal, say), then try again. Cancel removes the project with its folder${hasOwnKey ? ' and its own key' : ''}.`
            : ownKey
              ? `The failed clone left files in the project's folder (${err.message}). Cancel removes the project${hasOwnKey ? ' and its own key' : ''}; then import it again.`
              : `The failed clone left files in the project's folder (${err.message}). Try again in a moment, or Cancel removes the project; then import it again.`,
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
    if (ssh || keepProject) {
      void cloneAgain();
      return;
    }
    void recreate(phase);
  };

  const cancel = async () => {
    if (confirmCancel !== undefined && !window.confirm(confirmCancel)) return;
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
  const onWaitingRef = useRef(onWaitingForKey);
  onWaitingRef.current = onWaitingForKey;
  useEffect(() => onWaitingRef.current?.(waiting), [waiting]);

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
  const trustOffered = problem === 'host_key_unknown' && phase.kind === 'cloneFailed' && !!phase.hostKey;

  return (
    <div className="wizard-step">
      <ImportProgressSteps source={source} phase={phase} usesOwnKey={ownKey} />
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
        <ImportAwaitingKeyBox
          sshKey={phase.sshKey}
          repoUrl={repoUrl}
          keyBusy={keyBusy}
          onMakeOwnKey={() => void makeKey('own')}
        />
      )}
      {source === 'import_url' && (tail || phase.kind === 'cloning') && (
        <pre className="wizard-tail mono" tabIndex={0} aria-label="Clone output">
          {tail || 'Waiting for output…'}
        </pre>
      )}
      {phase.kind === 'cloneFailed' && (
        <ImportSshFailureBox
          problem={problem}
          hostKey={phase.hostKey}
          trustOffered={trustOffered}
          keys={keys}
          repoUrl={repoUrl}
          keyBusy={keyBusy}
          onCloneAgain={cloneAgain}
          onMakeKey={(how) => void makeKey(how)}
        />
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
      {source === 'import_url' && hasOwnKey && (failed || waiting || phase.kind === 'cloning') && (
        <p className="muted small">
          Cancel removes the project and its own key. If you already added the key to the repository, remove
          the deploy key there too.
        </p>
      )}
    </div>
  );
}

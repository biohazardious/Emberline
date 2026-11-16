import type { Project, RepositoryStatus, UpdateRepositoryBody } from '@emberline/protocol';
import { useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiRequestError, errorMessage } from '../api';
import { FORGE_ACCOUNTS_HREF } from '../forgeAccounts';
import { useApi } from '../hooks/useApi';
import {
  accountText,
  hasWorkingBranch,
  keepPushedText,
  lastPushText,
  mainStateText,
  mainTipText,
  originCredentialsText,
  pushMainBlocked,
  replaceOriginQuestion,
  repoErrorForm,
} from '../repository';
import { hostKeyOf } from '../sshKeys';
import { ImportRecovery } from './ImportRecovery';
import { ProjectSshKey } from './ProjectSshKey';
import './project-settings-ux.css';
import {
  type RepoError,
  type RepoForm,
  RepositoryRemoteForms,
  SshProblemHelp,
} from './projectSettings/RepositoryRemoteForms';
import { CommitIdentityFields } from './RepositoryCommitIdentity';
import { PushTargetFields } from './RepositoryPushTarget';
import { SettingRow } from './ui/SettingRow';
import { Switch } from './ui/Switch';

/** Project settings → Repository: remote, working branch, push target, commit identity and SSH key. */
export function RepositoryPanel({ project }: { project: Project }) {
  const base = `/api/projects/${project.id}/repository`;
  const status = useApi<RepositoryStatus>(base, 120_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<RepoError | null>(null);
  const [editingRemote, setEditingRemote] = useState(false);
  /** The last operation, to run again once its server's host key is trusted. */
  const lastAction = useRef<{ key: string; send: (replace: boolean) => Promise<RepositoryStatus> } | null>(
    null,
  );
  const s = status.data;

  /** Runs a mutation; on origin_exists asks once and resends with replace. */
  const act = async (key: string, send: (replace: boolean) => Promise<RepositoryStatus>) => {
    lastAction.current = { key, send };
    setBusy(key);
    setError(null);
    try {
      try {
        await send(false);
      } catch (err) {
        const question = replaceOriginQuestion(err);
        if (!question) throw err;
        if (!window.confirm(question)) return;
        await send(true);
      }
    } catch (err) {
      const failure = err instanceof ApiRequestError ? err : null;
      setError({
        form: repoErrorForm(key),
        text: errorMessage(err),
        code: failure?.code,
        hostKey: hostKeyOf(failure?.data),
      });
    } finally {
      await status.refresh();
      setBusy(null);
    }
  };

  const again = () => {
    const last = lastAction.current;
    if (last) void act(last.key, last.send);
  };
  const saveSettings = (key: string, patch: UpdateRepositoryBody) =>
    void act(key, () => api<RepositoryStatus>(base, 'PATCH', patch));
  const help = (form: RepoForm) =>
    error?.form === form ? <SshProblemHelp error={error} onTrusted={again} /> : null;

  const account = s ? accountText(s) : null;
  const blocked = s ? pushMainBlocked(s) : 'Loading…';
  const lastPush = s ? lastPushText(s) : null;
  const credentials = s ? originCredentialsText(s) : null;
  const tip = s ? mainTipText(s) : null;
  const separate = s ? hasWorkingBranch(s) : false;

  return (
    <section className="project-settings-section repo-block" aria-labelledby="repository-title">
      <div className="project-settings-section-head">
        <h3 id="repository-title" className="project-settings-section-title">
          Repository
        </h3>
      </div>
      <ImportRecovery project={project} />
      {status.error !== undefined && !s && (
        <p className="banner banner-error" role="alert">
          {errorMessage(status.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void status.refresh()}>
            Retry
          </button>
        </p>
      )}
      {s && (
        <>
          <div className="project-settings-rows">
            <SettingRow
              label="Remote"
              summary={
                <>
                  <span className="mono">{s.originUrl ?? 'No remote yet'}</span>
                  {account && (
                    <>
                      {' · '}
                      {account.text}
                      {account.addAccount && (
                        <>
                          {' · '}
                          <Link href={FORGE_ACCOUNTS_HREF}>Add account</Link>
                        </>
                      )}
                    </>
                  )}
                  {s.isGitRepo ? (
                    <>
                      {' · '}
                      <span className="mono">{s.defaultBranch}</span> ({mainStateText(s)})
                    </>
                  ) : (
                    <> · {mainStateText(s)}</>
                  )}
                  {s.isGitRepo && !separate && blocked !== null ? <> · {blocked}</> : null}
                </>
              }
              control={
                <>
                  {s.isGitRepo && !separate && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy !== null || blocked !== null}
                      aria-describedby={error?.form === 'actions' ? 'repo-actions-error' : undefined}
                      onClick={() =>
                        void act('push', () => api<RepositoryStatus>(`${base}/push-main`, 'POST'))
                      }
                    >
                      {busy === 'push' ? 'Pushing…' : 'Push main'}
                    </button>
                  )}
                  {s.isGitRepo && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null || !s.originUrl}
                      onClick={() =>
                        void act('refresh', () => api<RepositoryStatus>(`${base}/refresh`, 'POST'))
                      }
                    >
                      {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
                    </button>
                  )}
                  {s.isGitRepo && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-expanded={editingRemote}
                      aria-label="Edit remote"
                      onClick={() => setEditingRemote((v) => !v)}
                    >
                      {editingRemote ? 'Close' : 'Edit'}
                    </button>
                  )}
                </>
              }
            />
            {s.isGitRepo && editingRemote && (
              <RepositoryRemoteForms
                project={project}
                status={s}
                busy={busy}
                error={error}
                help={help}
                onConnect={(url) =>
                  void act('connect', (replace) =>
                    api<RepositoryStatus>(`${base}/connect`, 'POST', { url, replace }),
                  )
                }
                onCreate={(payload) =>
                  void act('create', (replace) =>
                    api<RepositoryStatus>(`${base}/create`, 'POST', { ...payload, replace }),
                  )
                }
              />
            )}
            {s.isGitRepo && (
              <SettingRow
                label="Working branch"
                summary={
                  <>
                    <span className="mono">{s.workingBranch}</span>
                    {!separate && tip ? (
                      <>
                        {' · '}
                        <span className="mono">{tip}</span>
                      </>
                    ) : null}
                    {separate ? <> · {keepPushedText(s)}</> : null}
                  </>
                }
                control={
                  <>
                    {separate && (
                      <Switch
                        checked={s.keepMainPushed}
                        disabled={busy !== null}
                        label="Keep pushed"
                        onChange={(checked) =>
                          void act('keep', () =>
                            api<RepositoryStatus>(base, 'PATCH', { keepMainPushed: checked }),
                          )
                        }
                      />
                    )}
                    <Link
                      href={`/projects/${project.id}/git`}
                      className="btn btn-sm btn-ghost"
                      aria-label="Edit working branch"
                    >
                      Edit
                    </Link>
                  </>
                }
              />
            )}
            {s.isGitRepo && <PushTargetFields s={s} busy={busy !== null} onSave={saveSettings} />}
            {s.isGitRepo && <CommitIdentityFields s={s} busy={busy !== null} onSave={saveSettings} />}
          </div>
          {credentials && (
            <p className="banner banner-warn" role="alert">
              {credentials}
            </p>
          )}
          {lastPush && (
            <p className="banner banner-warn" role="alert">
              {lastPush}
            </p>
          )}
          {error?.form === 'actions' && (
            <p className="banner banner-error" role="alert" id="repo-actions-error">
              {error.text}
            </p>
          )}
          {help('actions')}
          <div className="repo-ssh-wrap">
            <ProjectSshKey project={project} originUrl={s.originUrl ?? project.repoUrl} />
          </div>
        </>
      )}
    </section>
  );
}

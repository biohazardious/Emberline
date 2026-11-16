import type { WorkspaceFolder } from '@emberline/protocol';
import type { Dispatch } from 'react';
import { Disclosure } from '../ui/Disclosure';
import { RepoSshKey } from './RepoSshKey';
import { NameField } from './StepType';
import {
  branchProblem,
  urlProblem,
  type WizardAction,
  type WizardDraft,
  type WizardSource,
  type WizardState,
} from './wizardLogic';

const SOURCES: { id: WizardSource; label: string; hint: string; details: string }[] = [
  {
    id: 'preset',
    label: 'New from a preset',
    hint: 'Pick a project type and stack.',
    details: 'Generates PROJECT.md, CLAUDE.md, .emberline/worktree.yml and starter tickets.',
  },
  {
    id: 'import_url',
    label: 'Import a Git URL',
    hint: 'Clone an existing repository.',
    details: 'Clones over HTTPS (forge account) or SSH, inspects the stack and suggests project files.',
  },
  {
    id: 'import_folder',
    label: 'Use a folder in workspaces',
    hint: 'Register an existing workspace folder.',
    details: 'Uses the git repository in place without copying or moving files.',
  },
  {
    id: 'blank',
    label: 'Blank',
    hint: 'Start from a vision only.',
    details: 'Creates project docs and lets the agent propose the technology stack.',
  },
];

export function StepStart({
  state,
  dispatch,
  hasFolders,
  savedDraft,
  onRestore,
  onDismissDraft,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  /** "Use a folder" is offered only when the workspaces directory has one to use. */
  hasFolders: boolean;
  savedDraft: WizardDraft | null;
  onRestore: () => void;
  onDismissDraft: () => void;
}) {
  const sources = SOURCES.filter((s) => s.id !== 'import_folder' || hasFolders);
  return (
    <div className="wizard-step">
      {savedDraft && (
        <div className="wizard-draft" role="status">
          <span>
            You closed a wizard{savedDraft.name.trim() ? ` for “${savedDraft.name.trim()}”` : ''} before
            finishing it.
          </span>
          <div className="actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={onRestore}>
              Restore draft
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onDismissDraft}>
              Discard it
            </button>
          </div>
        </div>
      )}
      <fieldset className="wizard-fieldset">
        <legend className="wizard-legend">How do you want to start?</legend>
        <div className="wizard-cards wizard-cards-2">
          {sources.map((s, i) => (
            <label key={s.id} className="wizard-card">
              <input
                type="radio"
                name="wizard-source"
                value={s.id}
                checked={state.source === s.id}
                disabled={state.importProjectId !== null}
                data-autofocus={state.source === s.id || (state.source === null && i === 0) ? '' : undefined}
                onChange={() => dispatch({ type: 'source', source: s.id })}
              />
              <span className="wizard-card-title">{s.label}</span>
              <span className="wizard-card-hint">{s.hint}</span>
            </label>
          ))}
        </div>
        <Disclosure label="Details">
          <dl className="wizard-preset-details">
            {sources.map((s) => (
              <div key={s.id}>
                <dt>{s.label}</dt>
                <dd>{s.details}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      </fieldset>
    </div>
  );
}

/** Import: the repository URL and branch, or the workspace folder; Next registers the project. */
export function StepRepo({
  state,
  dispatch,
  folders,
  runnerDown,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  folders: WorkspaceFolder[];
  runnerDown: boolean;
}) {
  if (state.source === 'import_folder') {
    return (
      <div className="wizard-step">
        <fieldset className="wizard-fieldset">
          <legend className="wizard-legend">Folder in the workspaces directory</legend>
          <p className="muted small">Registered in place: nothing is copied or moved.</p>
          <div className="wizard-cards wizard-cards-2">
            {folders.map((f, i) => (
              <label key={f.name} className={`wizard-card${f.isGitRepo ? '' : ' wizard-card-disabled'}`}>
                <input
                  type="radio"
                  name="wizard-folder"
                  value={f.name}
                  checked={state.folder === f.name}
                  disabled={!f.isGitRepo}
                  data-autofocus={state.folder === f.name || (!state.folder && i === 0) ? '' : undefined}
                  onChange={() => dispatch({ type: 'field', field: 'folder', value: f.name })}
                />
                <span className="wizard-card-title mono">{f.name}</span>
                <span className="wizard-card-hint">
                  {f.isGitRepo
                    ? f.hasRemote
                      ? 'Git repository with a remote'
                      : 'Local git repository'
                    : 'Not a git repository: run git init and make a first commit to import it'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {state.folder && <NameField state={state} dispatch={dispatch} />}
      </div>
    );
  }

  const url = state.repoUrl.trim() ? urlProblem(state.repoUrl) : null;
  const branch = state.defaultBranch.trim() ? branchProblem(state.defaultBranch) : null;
  return (
    <div className="wizard-step">
      <div className="field">
        <label htmlFor="wizard-repo-url">Git URL</label>
        <input
          id="wizard-repo-url"
          className="input mono"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
          value={state.repoUrl}
          aria-invalid={url ? true : undefined}
          aria-describedby="wizard-repo-url-hint"
          data-autofocus=""
          onChange={(e) => dispatch({ type: 'field', field: 'repoUrl', value: e.target.value })}
        />
        <p id="wizard-repo-url-hint" className={url ? 'form-error' : 'muted small'}>
          {url ?? 'HTTPS uses your forge account; SSH uses an Emberline key.'}
        </p>
      </div>
      <RepoSshKey state={state} dispatch={dispatch} />
      <NameField state={state} dispatch={dispatch} />
      <div className="field">
        <label htmlFor="wizard-repo-branch">Default branch</label>
        <input
          id="wizard-repo-branch"
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          value={state.defaultBranch}
          placeholder="The repository’s default branch"
          aria-invalid={branch ? true : undefined}
          aria-describedby="wizard-repo-branch-hint"
          onChange={(e) => dispatch({ type: 'field', field: 'defaultBranch', value: e.target.value })}
        />
        <p id="wizard-repo-branch-hint" className={branch ? 'form-error' : 'muted small'}>
          {branch ?? 'Leave empty to use the remote default branch.'}
        </p>
      </div>
      {runnerDown && (
        <p className="banner banner-warn" role="status">
          The runner is not connected. Cloning runs in the runner, so it has to be up first.
        </p>
      )}
    </div>
  );
}

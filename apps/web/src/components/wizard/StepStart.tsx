import type { WorkspaceFolder } from '@emberline/protocol';
import type { Dispatch } from 'react';
import { NameField } from './StepType';
import {
  branchProblem,
  urlProblem,
  type WizardAction,
  type WizardDraft,
  type WizardSource,
  type WizardState,
} from './wizardLogic';

const SOURCES: { id: WizardSource; label: string; hint: string }[] = [
  {
    id: 'preset',
    label: 'New from a preset',
    hint: 'Pick a project type and a stack; the agent builds the skeleton.',
  },
  {
    id: 'import_url',
    label: 'Import a Git URL',
    hint: 'Clone a repository and add the Emberline project files.',
  },
  {
    id: 'import_folder',
    label: 'Use a folder in workspaces',
    hint: 'Register a folder that is already in the workspaces directory.',
  },
  { id: 'blank', label: 'Blank', hint: 'Only the project docs; the agent proposes the stack.' },
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
          <p className="muted small">Emberline registers it where it is: nothing is copied or moved.</p>
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
  const branch = branchProblem(state.defaultBranch);
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
          {url ?? 'The runner clones it with its own git credentials.'}
        </p>
      </div>
      <NameField state={state} dispatch={dispatch} />
      <div className="field">
        <label htmlFor="wizard-repo-branch">Default branch</label>
        <input
          id="wizard-repo-branch"
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          value={state.defaultBranch}
          aria-invalid={branch ? true : undefined}
          aria-describedby="wizard-repo-branch-hint"
          onChange={(e) => dispatch({ type: 'field', field: 'defaultBranch', value: e.target.value })}
        />
        <p id="wizard-repo-branch-hint" className={branch ? 'form-error' : 'muted small'}>
          {branch ??
            'Finished runs are merged into the branch the clone checks out (the repository’s default branch); Emberline records it once the clone is done.'}
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

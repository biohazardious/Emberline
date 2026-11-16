import {
  ADOPT_FILE_PATHS,
  type AdoptPreviewResponse,
  IGNORED_FILE_NOTE,
  type ProjectPreviewResponse,
} from '@emberline/protocol';
import { type Dispatch, type KeyboardEvent, useRef, useState } from 'react';
import { Disclosure } from '../ui/Disclosure';
import { SettingRow } from '../ui/SettingRow';
import {
  ADOPT_FILES,
  canApproveRepoWorktreeYml,
  ignoredFile,
  isImport,
  type WizardAction,
  type WizardState,
  worktreeYmlImportNote,
  writableFiles,
} from './wizardLogic';

export type SummaryPreview =
  { kind: 'new'; data: ProjectPreviewResponse } | { kind: 'adopt'; data: AdoptPreviewResponse };

export interface PreviewState {
  preview: SummaryPreview | null;
  ready: boolean;
  error: string | null;
  loading: boolean;
}

/** WAI-ARIA tabs: one tab stop, arrow keys, Home and End move between files. */
export function PreviewTabs({ tabs }: { tabs: { id: string; label: string; content: string }[] }) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.min(selected, tabs.length - 1);
  if (tabs.length === 0) return null;
  const onKey = (e: KeyboardEvent) => {
    const last = tabs.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    setSelected(next);
    refs.current[next]?.focus();
  };
  const tab = tabs[index]!;
  return (
    <div className="wizard-tabs">
      <div role="tablist" aria-label="File previews" className="wizard-tablist">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`wizard-tab-${t.id}`}
            aria-selected={i === index}
            aria-controls="wizard-tabpanel"
            tabIndex={i === index ? 0 : -1}
            className={`wizard-tab${i === index ? ' active' : ''}`}
            onClick={() => setSelected(i)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre
        id="wizard-tabpanel"
        role="tabpanel"
        aria-labelledby={`wizard-tab-${tab.id}`}
        tabIndex={0}
        className="wizard-file-preview mono"
      >
        {tab.content}
      </pre>
    </div>
  );
}

export function SummaryFilesSection({
  state,
  dispatch,
  preview,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  preview: PreviewState;
}) {
  const imported = isImport(state.source);
  const detect = state.detect;
  const own = detect?.detected.worktreeYml ?? null;
  const writable = writableFiles(detect);
  const data = preview.preview;

  const tabs =
    data?.kind === 'new'
      ? [
          { id: 'project-md', label: 'PROJECT.md', content: data.data.projectMd },
          { id: 'claude-md', label: 'CLAUDE.md', content: data.data.claudeMd },
          { id: 'worktree-yml', label: 'worktree.yml', content: data.data.worktreeYml },
        ]
      : data?.kind === 'adopt'
        ? [
            ...Object.entries(data.data.files).map(([path, content]) => ({
              id: path.replace(/\W+/g, '-'),
              label: path.replace(/^\.emberline\//, ''),
              content,
            })),
            ...(own?.content && !state.write.includes('worktreeYml')
              ? [{ id: 'repo-worktree-yml', label: 'worktree.yml (repository)', content: own.content }]
              : []),
          ]
        : [];

  return (
    <>
      {imported && detect && (
        <section className="wizard-sum-group" aria-labelledby="wizard-sum-files">
          <h4 id="wizard-sum-files">Project files</h4>
          <ul className="wizard-files">
            {ADOPT_FILES.map((f) => {
              const path = ADOPT_FILE_PATHS[f];
              if (detect.detected.files[f]) {
                return (
                  <li key={f}>
                    <span className="mono">{path}</span>{' '}
                    <span className="muted small">· in the repository, kept as is</span>
                  </li>
                );
              }
              if (!writable.includes(f)) {
                return (
                  <li key={f}>
                    <span className="mono">{path}</span>{' '}
                    <span className="muted small">· missing; nothing to suggest</span>
                  </li>
                );
              }
              return (
                <li key={f}>
                  <label className="wizard-check">
                    <input
                      type="checkbox"
                      checked={state.write.includes(f)}
                      aria-describedby={ignoredFile(detect, f) ? `wizard-ignored-${f}` : undefined}
                      onChange={(e) => dispatch({ type: 'write', file: f, on: e.target.checked })}
                    />
                    <span>
                      Write this file: <span className="mono">{path}</span>
                    </span>
                  </label>
                  {ignoredFile(detect, f) && (
                    <p className="field-warn" id={`wizard-ignored-${f}`}>
                      {IGNORED_FILE_NOTE}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {detect.detected.files.agentsMd && (
            <p className="muted small">AGENTS.md is in the repository and stays as is.</p>
          )}

          {own && (
            <div className="wizard-own-yml">
              <p className="small">
                Repository <span className="mono">.emberline/worktree.yml</span> runs in every worktree once
                approved.
              </p>
              {own.errors.length > 0 && (
                <ul className="worktree-review-errors" role="alert">
                  {own.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {own.notCommitted && (
                <p className="muted small">
                  It is not committed in HEAD, so it cannot be approved: commit it and import again.
                </p>
              )}
              {own.workingTreeDiffers && (
                <p className="muted small">
                  The working tree differs from HEAD; this is HEAD&apos;s version.
                </p>
              )}
              {own.content !== null && (
                <pre
                  className="worktree-review-diff mono"
                  tabIndex={0}
                  aria-label="The repository's worktree.yml"
                >
                  {own.content}
                </pre>
              )}
              <label className="wizard-check">
                <input
                  type="checkbox"
                  checked={state.approveWorktreeYml}
                  disabled={!canApproveRepoWorktreeYml(detect)}
                  onChange={(e) => dispatch({ type: 'approveWorktreeYml', on: e.target.checked })}
                />
                <span>Approve these commands</span>
              </label>
            </div>
          )}

          <p className="muted small">
            {data?.kind === 'adopt'
              ? data.data.commitMessage
                ? `Commits ticked files locally as “${data.data.commitMessage}”.`
                : 'Nothing is written or committed.'
              : 'Checking what would be committed…'}
          </p>
          {(worktreeYmlImportNote(state) || (data?.kind === 'adopt' && data.data.ignored.length > 0)) && (
            <Disclosure label="Details">
              {worktreeYmlImportNote(state) && <p>{worktreeYmlImportNote(state)}</p>}
              {data?.kind === 'adopt' && data.data.ignored.length > 0 && (
                <p>
                  {data.data.ignored.join(', ')} {data.data.ignored.length === 1 ? 'is' : 'are'} ignored by
                  .gitignore and committed anyway.
                </p>
              )}
            </Disclosure>
          )}
        </section>
      )}

      {!imported && data?.kind === 'new' && (
        <div className="wizard-summary-rows">
          <SettingRow
            label="Files"
            summary={
              <>
                <span className="mono">PROJECT.md</span>, <span className="mono">CLAUDE.md</span>,{' '}
                <span className="mono">.emberline/worktree.yml</span>
                {data.data.starterFiles.map((f) => (
                  <span key={f}>
                    , <span className="mono">{f}</span>
                  </span>
                ))}{' '}
                on <span className="mono">{state.defaultBranch.trim()}</span>
              </>
            }
            details={
              data.data.notes.length > 0 ? (
                <div>
                  {data.data.notes.map((note) => (
                    <p key={note} className="small">
                      {note}
                    </p>
                  ))}
                </div>
              ) : undefined
            }
          />
        </div>
      )}

      {preview.error && (
        <p className="banner banner-error" role="alert">
          Couldn&apos;t build the preview: {preview.error}
        </p>
      )}
      {preview.loading && !data && (
        <p className="muted small" role="status">
          Building the preview…
        </p>
      )}
      {!preview.error && tabs.length > 0 && (
        <Disclosure label="Preview files">
          <PreviewTabs tabs={tabs} />
        </Disclosure>
      )}
    </>
  );
}

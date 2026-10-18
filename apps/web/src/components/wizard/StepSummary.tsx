import {
  ADOPT_FILE_PATHS,
  type AdoptPreviewResponse,
  getPreset,
  getProjectType,
  PROJECT_GATE_KEYS,
  type ProjectPreviewResponse,
  STACK_DIMENSIONS,
  VERSION_POLICIES,
} from '@emberline/protocol';
import { type Dispatch, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { GATE_LABELS } from '../../projectSettings';
import { PERSONA_BY_ID } from '../PersonaBadge';
import {
  ADOPT_FILES,
  buildAdoptBody,
  buildCreateBody,
  canApproveRepoWorktreeYml,
  choiceLabel,
  isImport,
  type StepId,
  type WizardAction,
  type WizardState,
  writableFiles,
  worktreeYmlImportNote,
} from './wizardLogic';

export type SummaryPreview =
  | { kind: 'new'; data: ProjectPreviewResponse }
  | { kind: 'adopt'; data: AdoptPreviewResponse };

export interface PreviewState {
  /** The last preview that loaded; it may be for an older body while a new one loads. */
  preview: SummaryPreview | null;
  /** The preview matches the current choices: Create may proceed. */
  ready: boolean;
  error: string | null;
  loading: boolean;
}

/**
 * What creation (or adopt) would write, from the server's own generators. Debounced; a request
 * for an older body never replaces a newer one. Create stays disabled until it succeeds.
 */
export function useSummaryPreview(state: WizardState, active: boolean): PreviewState {
  const imported = isImport(state.source);
  const projectId = state.importProjectId;
  const body = imported ? buildAdoptBody(state) : buildCreateBody(state);
  const key = `${projectId ?? ''}|${JSON.stringify(body)}`;
  const [result, setResult] = useState<{ key: string; error: string | null } | null>(null);
  const [lastGood, setLastGood] = useState<SummaryPreview | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    if (!active || (imported && !projectId)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const request = imported
        ? api<AdoptPreviewResponse>(`/api/projects/${projectId}/adopt/preview`, 'POST', bodyRef.current).then(
            (data): SummaryPreview => ({ kind: 'adopt', data }),
          )
        : api<ProjectPreviewResponse>('/api/projects/preview', 'POST', bodyRef.current).then(
            (data): SummaryPreview => ({ kind: 'new', data }),
          );
      request.then(
        (preview) => {
          if (cancelled) return;
          setLastGood(preview);
          setResult({ key, error: null });
        },
        (err: unknown) => {
          if (!cancelled) setResult({ key, error: errorMessage(err) });
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, imported, projectId, key]);

  const current = result?.key === key ? result : null;
  return {
    preview: lastGood,
    ready: current !== null && current.error === null,
    error: current?.error ?? null,
    loading: active && current === null,
  };
}

/** WAI-ARIA tabs: one tab stop, arrow keys, Home and End move between files. */
function PreviewTabs({ tabs }: { tabs: { id: string; label: string; content: string }[] }) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.min(selected, tabs.length - 1);
  if (tabs.length === 0) return null;
  const onKey = (e: KeyboardEvent) => {
    const last = tabs.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
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
      <pre id="wizard-tabpanel" role="tabpanel" aria-labelledby={`wizard-tab-${tab.id}`} tabIndex={0} className="wizard-file-preview mono">
        {tab.content}
      </pre>
    </div>
  );
}

function Group({
  title,
  editStep,
  onEdit,
  children,
}: {
  title: string;
  editStep: StepId | null;
  onEdit: (step: StepId) => void;
  children: ReactNode;
}) {
  const id = `wizard-sum-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className="wizard-sum-group" aria-labelledby={id}>
      <div className="wizard-sum-head">
        <h4 id={id}>{title}</h4>
        {editStep && (
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`Edit ${title.toLowerCase()}`} onClick={() => onEdit(editStep)}>
            Edit
          </button>
        )}
      </div>
      <dl className="wizard-sum-list">{children}</dl>
    </section>
  );
}

const Item = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const truncate = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function StepSummary({
  state,
  dispatch,
  preview,
  onEdit,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  preview: PreviewState;
  onEdit: (step: StepId) => void;
}) {
  const imported = isImport(state.source);
  const type = state.appType ? getProjectType(state.appType)?.label : undefined;
  const preset = state.presetId ? getPreset(state.presetId) : undefined;
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
    <div className="wizard-step">
      {imported ? (
        <Group title="Repository" editStep={null} onEdit={onEdit}>
          <Item label={state.source === 'import_folder' ? 'Folder' : 'Git URL'}>
            <span className="mono">{state.source === 'import_folder' ? state.folder : state.repoUrl.trim()}</span>
          </Item>
          <Item label="Project name">{state.name.trim()}</Item>
          <Item label="Type">{type ?? 'Custom'}</Item>
        </Group>
      ) : (
        <Group title="Project" editStep="type" onEdit={onEdit}>
          <Item label="Name">{state.name.trim()}</Item>
          <Item label="Type">{type}</Item>
          <Item label="Preset">{preset?.label}</Item>
          <Item label="Vision">{state.vision.trim() ? truncate(state.vision.trim()) : <span className="muted">None</span>}</Item>
          {state.referenceDocs.trim() && (
            <Item label="Reference docs">{state.referenceDocs.trim().length.toLocaleString()} characters</Item>
          )}
        </Group>
      )}

      <Group title="Stack" editStep="stack" onEdit={onEdit}>
        {STACK_DIMENSIONS.map((d) => (
          <Item key={d.id} label={d.label}>
            {choiceLabel(d.id, state.choices[d.id])}
          </Item>
        ))}
        {!imported && (
          <>
            <Item label="Default branch">
              <span className="mono">{state.defaultBranch.trim()}</span>
            </Item>
            <Item label="Version policy">{VERSION_POLICIES.find((p) => p.id === state.versionPolicy)?.label}</Item>
          </>
        )}
      </Group>

      <Group title="Factory" editStep="factory" onEdit={onEdit}>
        {PROJECT_GATE_KEYS.map((key) => (
          <Item key={key} label={GATE_LABELS[key].label}>
            {state.gates[key] === undefined ? 'Inherit' : state.gates[key] ? 'On' : 'Off'}
          </Item>
        ))}
        <Item label="Start mode">
          {`${imported ? 'Import' : 'Create'}${state.startFactory ? ' and start factory' : ' only'}`}
        </Item>
        {imported && <Item label="Vision">{state.vision.trim() ? truncate(state.vision.trim()) : <span className="muted">None</span>}</Item>}
      </Group>

      <section className="wizard-sum-group" aria-labelledby="wizard-sum-tickets">
        <h4 id="wizard-sum-tickets">Tickets</h4>
        {imported ? (
          state.startFactory ? (
            <ul className="wizard-tickets">
              <li>
                <span>[Factory] from the vision</span>
                <span className="muted small"> · {PERSONA_BY_ID.product_owner.label}</span>
              </li>
            </ul>
          ) : (
            <p className="muted small">No tickets: an import gets no Bootstrap ticket, and the factory is not started.</p>
          )
        ) : data?.kind === 'new' ? (
          <ul className="wizard-tickets">
            {data.data.tickets.map((t) => (
              <li key={t.key}>
                <span>{t.title}</span>
                <span className="muted small"> · {PERSONA_BY_ID[t.persona]?.label ?? t.persona}</span>
                {t.dependsOn.length > 0 && (
                  <span className="muted small">
                    {' '}
                    · after {t.dependsOn.map((k) => data.data.tickets.find((x) => x.key === k)?.title ?? k).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{preview.loading ? 'Loading…' : '—'}</p>
        )}
      </section>

      {imported && detect && (
        <section className="wizard-sum-group" aria-labelledby="wizard-sum-files">
          <h4 id="wizard-sum-files">Project files</h4>
          <ul className="wizard-files">
            {ADOPT_FILES.map((f) => {
              const path = ADOPT_FILE_PATHS[f];
              if (detect.detected.files[f]) {
                return (
                  <li key={f}>
                    <span className="mono">{path}</span> <span className="muted small">· in the repository, kept as is</span>
                  </li>
                );
              }
              if (!writable.includes(f)) {
                return (
                  <li key={f}>
                    <span className="mono">{path}</span> <span className="muted small">· missing; nothing to suggest</span>
                  </li>
                );
              }
              return (
                <li key={f}>
                  <label className="wizard-check">
                    <input
                      type="checkbox"
                      checked={state.write.includes(f)}
                      onChange={(e) => dispatch({ type: 'write', file: f, on: e.target.checked })}
                    />
                    <span>
                      Write this file: <span className="mono">{path}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {detect.detected.files.agentsMd && <p className="muted small">AGENTS.md is in the repository and stays as is.</p>}

          {own && (
            <div className="wizard-own-yml">
              <p className="small">
                The repository has its own <span className="mono">.emberline/worktree.yml</span>. Its commands run in the
                runner for every run worktree, so they apply only when you approve them.
              </p>
              {own.errors.length > 0 && (
                <ul className="worktree-review-errors" role="alert">
                  {own.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {own.notCommitted && <p className="muted small">It is not committed in HEAD, so it cannot be approved: commit it and import again.</p>}
              {own.workingTreeDiffers && <p className="muted small">The working tree differs from HEAD; this is HEAD&apos;s version.</p>}
              {own.content !== null && (
                <pre className="worktree-review-diff mono" tabIndex={0} aria-label="The repository's worktree.yml">
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

          {worktreeYmlImportNote(state) && (
            <p className="notice-box">
              <strong>worktree.yml</strong>
              {worktreeYmlImportNote(state)}
            </p>
          )}

          <p className="notice-box">
            {data?.kind === 'adopt' ? (
              data.data.commitMessage ? (
                <>
                  <strong>Commit</strong>
                  The ticked files are committed on the checked-out branch as “{data.data.commitMessage}”. It is a local
                  commit, never pushed. Runs branch from HEAD, so they see the files.
                </>
              ) : (
                <>Nothing is written or committed.</>
              )
            ) : (
              <>Checking what would be committed…</>
            )}
          </p>
        </section>
      )}

      {!imported && data?.kind === 'new' && (
        <section className="wizard-sum-group" aria-labelledby="wizard-sum-files">
          <h4 id="wizard-sum-files">Files</h4>
          <p className="small">
            <span className="mono">PROJECT.md</span>, <span className="mono">CLAUDE.md</span>,{' '}
            <span className="mono">.emberline/worktree.yml</span>
            {data.data.starterFiles.map((f) => (
              <span key={f}>
                , <span className="mono">{f}</span>
              </span>
            ))}
            , committed as the first commit on <span className="mono">{state.defaultBranch.trim()}</span>. The
            worktree.yml counts as approved.
          </p>
          {data.data.notes.map((note) => (
            <p key={note} className="notice-box">
              {note}
            </p>
          ))}
        </section>
      )}

      {preview.error && (
        <p className="banner banner-error" role="alert">
          Couldn&apos;t build the preview: {preview.error}
        </p>
      )}
      {preview.loading && !data && <p className="muted small" role="status">Building the preview…</p>}
      <PreviewTabs tabs={preview.error ? [] : tabs} />
    </div>
  );
}

import type { Project, ProjectSettingsResponse, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';
import {
  approveEnabled,
  bannerOffersEdit,
  gateChoices,
  gateUpdate,
  refreshWorktreeConfigViews,
  type GateChoice,
  WORKTREE_EDIT_PARAM,
  type WorktreeBanner,
  worktreeEditAvailable,
  worktreeBanner,
} from '../projectSettings';
import { ContainerPreviewBox } from './ContainerPreviewBox';
import { RepositoryPanel } from './RepositoryPanel';
import { WorktreeEditor } from './WorktreeEditor';

/** The unified diff, the schema errors and Approve for HEAD's .emberline/worktree.yml. */
function WorktreeReviewBody({
  project,
  banner,
  onDone,
}: {
  project: Project;
  banner: WorktreeBanner;
  onDone: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullFileShown, setFullFileShown] = useState(false);
  const canApproveNow = approveEnabled(banner, { busy, fullFileShown });

  const approve = async () => {
    if (!banner.approveBody) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project.id}/worktree-config/approve`, 'POST', banner.approveBody);
      await onDone();
      await refreshWorktreeConfigViews(queryClient, project.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="worktree-review">
      {banner.errors.length > 0 && (
        <ul className="worktree-review-errors" role="alert">
          {banner.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {banner.diff ? (
        <pre className="worktree-review-diff mono" tabIndex={0} aria-label="Changes to worktree.yml">
          {banner.diff}
        </pre>
      ) : banner.kind === 'unusable' ? null : (
        <p className="muted">No textual changes to show.</p>
      )}
      {banner.truncated && banner.fullFile !== null && (
        <>
          <p className="muted small">
            The diff is too long to show whole. Review HEAD&apos;s full file before you approve it.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={fullFileShown}
            onClick={() => setFullFileShown((v) => !v)}
          >
            {fullFileShown ? 'Hide full file' : 'Show full file'}
          </button>
          {fullFileShown && (
            <pre className="worktree-review-diff mono" tabIndex={0} aria-label="HEAD's worktree.yml">
              {banner.fullFile}
            </pre>
          )}
        </>
      )}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canApproveNow}
          onClick={() => void approve()}
        >
          {busy ? 'Approving…' : banner.kind === 'removed' ? 'Approve removal' : 'Approve'}
        </button>
        {!banner.canApprove && banner.errors.length > 0 && (
          <span className="muted">Fix the errors in the repository, then review again.</span>
        )}
        {banner.canApprove && banner.truncated && !fullFileShown && (
          <span className="muted">Open the full file to approve.</span>
        )}
      </div>
    </div>
  );
}

/** Native radios styled as segments: one tab stop, arrow keys move and select. */
export function GateRadios({
  name,
  labelledBy,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string;
  labelledBy: string;
  options: { value: GateChoice; label: string }[];
  value: GateChoice;
  disabled: boolean;
  onChange: (choice: GateChoice) => void;
}) {
  return (
    <div className="segmented segmented-radios" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        <label key={o.value} className={value === o.value ? 'active' : ''}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Slim banner for the Board: names the worktree.yml state and opens the review in place. */
export function WorktreeConfigBanner({ project }: { project: Project }) {
  const status = useApi<WorktreeConfigStatusResponse>(`/api/projects/${project.id}/worktree-config`, 30_000);
  const banner = worktreeBanner(status.data);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (!banner) return null;
  if (banner.kind === 'unreadable') return <p className="muted worktree-note">{banner.title}.</p>;
  return (
    <section className="banner banner-warn worktree-banner" aria-label="worktree.yml review">
      <div className="worktree-banner-head">
        <strong>{banner.title}</strong>
        <Link href={`/projects/${project.id}/settings`}>Project settings</Link>
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Review'}
        </button>
        {bannerOffersEdit(banner) && worktreeEditAvailable(status.data) && !editing && (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing && worktreeEditAvailable(status.data) && (
        <WorktreeEditor project={project} status={status.data} onClose={() => setEditing(false)} />
      )}
      {open && !editing && <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />}
    </section>
  );
}

/** Per-project settings: gate overrides (Inherit / On / Off) and the worktree.yml review. */
export function ProjectSettingsPanel({ project }: { project: Project }) {
  const settings = useApi<ProjectSettingsResponse>(`/api/projects/${project.id}/settings`, 15_000);
  const status = useApi<WorktreeConfigStatusResponse>(`/api/projects/${project.id}/worktree-config`, 30_000);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const banner = worktreeBanner(status.data);
  const [editing, setEditing] = useState(false);
  const search = useSearch();
  const openedFromLink = useRef(false);
  useEffect(() => {
    if (openedFromLink.current || !worktreeEditAvailable(status.data)) return;
    if (search.replace(/^\?/, '').split('&').includes(WORKTREE_EDIT_PARAM)) {
      openedFromLink.current = true;
      setEditing(true);
    }
  }, [search, status.data]);

  const choose = async (key: Parameters<typeof gateUpdate>[0], choice: GateChoice) => {
    setSaving(key);
    setError(null);
    try {
      await api(`/api/projects/${project.id}/settings`, 'PATCH', gateUpdate(key, choice));
      await settings.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="project-settings-title">
      <header className="panel-head">
        <div>
          <h2 id="project-settings-title">Project settings · {project.name}</h2>
          <p className="muted">
            Gates for this project&apos;s runs. Inherit follows the global setting, including later changes to
            it.
          </p>
        </div>
      </header>
      <RepositoryPanel project={project} />
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <h3>Gates</h3>
      {settings.error !== undefined && settings.data && (
        <p className="muted" role="alert">
          Couldn&apos;t refresh the gate settings ({errorMessage(settings.error)}); showing the last values.
        </p>
      )}
      {settings.error !== undefined && !settings.data && (
        <p className="banner banner-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
      {settings.data && (
        <ul className="gate-list">
          {gateChoices(settings.data).map((row) => (
            <li key={row.key} className="gate-row">
              <div>
                <span id={`gate-${row.key}`}>{row.label}</span>
                <p className="muted">{row.hint}</p>
              </div>
              <GateRadios
                name={`gate-${row.key}`}
                labelledBy={`gate-${row.key}`}
                options={row.options}
                value={row.choice}
                disabled={saving === row.key}
                onChange={(choice) => void choose(row.key, choice)}
              />
            </li>
          ))}
        </ul>
      )}
      <ContainerPreviewBox project={project} />
      <div className="worktree-heading">
        <h3>worktree.yml</h3>
        {!editing && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!worktreeEditAvailable(status.data)}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </div>
      {status.error !== undefined && status.data && (
        <p className="muted" role="alert">
          Couldn&apos;t refresh the worktree.yml status ({errorMessage(status.error)}); showing the last
          state.
        </p>
      )}
      {editing && worktreeEditAvailable(status.data) ? (
        <WorktreeEditor project={project} status={status.data} onClose={() => setEditing(false)} />
      ) : (
        <>
          {!banner && <p className="muted">The approved .emberline/worktree.yml matches the repository.</p>}
          {banner?.kind === 'unreadable' && <p className="muted">{banner.title}.</p>}
          {banner && banner.kind !== 'unreadable' && (
            <>
              <p className="banner banner-warn">{banner.title}</p>
              <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />
            </>
          )}
        </>
      )}
    </section>
  );
}

import type { Project, ProjectSettingsResponse, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';
import { gateChoices, gateUpdate, type GateChoice, type WorktreeBanner, worktreeBanner } from '../projectSettings';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    if (!banner.approveBody) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project.id}/worktree-config/approve`, 'POST', banner.approveBody);
      await onDone();
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
      ) : (
        <p className="muted">No textual changes to show.</p>
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
          disabled={!banner.canApprove || busy}
          onClick={() => void approve()}
        >
          {busy ? 'Approving…' : banner.kind === 'removed' ? 'Approve removal' : 'Approve'}
        </button>
        {!banner.canApprove && banner.errors.length > 0 && (
          <span className="muted">Fix the errors in the repository, then review again.</span>
        )}
      </div>
    </div>
  );
}

/** Slim banner for the Board: names the worktree.yml state and opens the review in place. */
export function WorktreeConfigBanner({ project }: { project: Project }) {
  const status = useApi<WorktreeConfigStatusResponse>(`/api/projects/${project.id}/worktree-config`, 30_000);
  const banner = worktreeBanner(status.data);
  const [open, setOpen] = useState(false);
  if (!banner) return null;
  if (banner.kind === 'unreadable') return <p className="muted worktree-note">{banner.title}.</p>;
  return (
    <section className="banner banner-warn worktree-banner" aria-label="worktree.yml review">
      <div className="worktree-banner-head">
        <strong>{banner.title}</strong>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Review'}
        </button>
      </div>
      {open && <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />}
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
            Gates for this project&apos;s runs. Inherit follows the global setting, including later changes to it.
          </p>
        </div>
      </header>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <h3>Gates</h3>
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
              <div className="segmented" role="radiogroup" aria-labelledby={`gate-${row.key}`}>
                {row.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={row.choice === o.value}
                    className={row.choice === o.value ? 'active' : ''}
                    disabled={saving === row.key}
                    onClick={() => void choose(row.key, o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3>worktree.yml</h3>
      {!banner && <p className="muted">The approved .emberline/worktree.yml matches the repository.</p>}
      {banner?.kind === 'unreadable' && <p className="muted">{banner.title}.</p>}
      {banner && banner.kind !== 'unreadable' && (
        <>
          <p className="banner banner-warn">{banner.title}</p>
          <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />
        </>
      )}
    </section>
  );
}

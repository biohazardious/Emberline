import type { Project, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { api, errorMessage } from '../../api';
import { useApi } from '../../hooks/useApi';
import {
  approveEnabled,
  bannerOffersEdit,
  refreshWorktreeConfigViews,
  WORKTREE_EDIT_HINT,
  WORKTREE_EDIT_PARAM,
  type WorktreeBanner,
  worktreeBanner,
  worktreeEditAvailable,
} from '../../projectSettings';
import { WorktreeEditor } from '../WorktreeEditor';
import { Disclosure } from '../ui/Disclosure';

/** The unified diff, the schema errors and Approve for HEAD's .emberline/worktree.yml. */
export function WorktreeReviewBody({
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

/** Slim banner for the Board: names the worktree.yml state and opens the review in place. */
export function WorktreeConfigBanner({ project }: { project: Project }) {
  const status = useApi<WorktreeConfigStatusResponse>(`/api/projects/${project.id}/worktree-config`, 30_000);
  const banner = worktreeBanner(status.data);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const closeEditor = (note?: string) => {
    setEditing(false);
    setSavedNote(note ?? null);
  };
  if (!banner)
    return savedNote ? (
      <p className="banner banner-warn worktree-banner" role="status">
        {savedNote}
      </p>
    ) : null;
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
        <WorktreeEditor project={project} status={status.data} onClose={closeEditor} />
      )}
      {open && !editing && <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />}
    </section>
  );
}

export function WorktreeConfigSection({ project }: { project: Project }) {
  const status = useApi<WorktreeConfigStatusResponse>(`/api/projects/${project.id}/worktree-config`, 30_000);
  const banner = worktreeBanner(status.data);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const search = useSearch();
  const openedFromLink = useRef(false);

  useEffect(() => {
    if (openedFromLink.current || !worktreeEditAvailable(status.data)) return;
    if (search.replace(/^\?/, '').split('&').includes(WORKTREE_EDIT_PARAM)) {
      openedFromLink.current = true;
      setEditing(true);
    }
  }, [search, status.data]);

  return (
    <section className="project-settings-section" aria-labelledby="worktree-config-title">
      <div className="project-settings-section-head">
        <h3 id="worktree-config-title" className="project-settings-section-title">
          Worktree config
        </h3>
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
        <p className="muted small" role="alert">
          Couldn&apos;t refresh the worktree.yml status ({errorMessage(status.error)}); showing the last
          state.
        </p>
      )}
      {savedNote && !editing && (
        <p className="banner banner-warn" role="status">
          {savedNote}
        </p>
      )}
      {editing && worktreeEditAvailable(status.data) ? (
        <WorktreeEditor
          project={project}
          status={status.data}
          onClose={(note) => {
            setEditing(false);
            setSavedNote(note ?? null);
          }}
        />
      ) : (
        <>
          {!banner && <p className="muted small">Approved .emberline/worktree.yml matches HEAD.</p>}
          {banner?.kind === 'unreadable' && <p className="muted small">{banner.title}.</p>}
          {banner && banner.kind !== 'unreadable' && (
            <>
              <p className="banner banner-warn">{banner.title}</p>
              <WorktreeReviewBody project={project} banner={banner} onDone={status.refresh} />
            </>
          )}
          <Disclosure label="Format reference">
            <p>
              Define <span className="mono">version: 1</span> with <span className="mono">setup</span>,{' '}
              <span className="mono">services</span> and <span className="mono">checks</span> in{' '}
              <span className="mono">.emberline/worktree.yml</span>. {WORKTREE_EDIT_HINT}
            </p>
          </Disclosure>
        </>
      )}
    </section>
  );
}

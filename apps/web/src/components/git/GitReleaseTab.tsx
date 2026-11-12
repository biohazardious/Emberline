import {
  RELEASE_VERSION,
  type GitPageStatus,
  type ReleaseJob,
  type StartReleaseBody,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleDashed, LoaderCircle, Minus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../../api';
import {
  canUndoPromote,
  releaseBlockedText,
  releaseChecksText,
  releasePlan,
  releaseStepText,
  releaseSummaryText,
  suggestedVersion,
} from '../../gitPage';
import { GitProblemBanner, type Problem, problemOf } from './GitStatusStrip';

const STEP_ICON = {
  pending: CircleDashed,
  running: LoaderCircle,
  done: Check,
  skipped: Minus,
  failed: X,
} as const;

/** A job's steps with their statuses and details, in the order they run. */
function JobSteps({ job, status }: { job: ReleaseJob; status: GitPageStatus }) {
  return (
    <ol className="git-release-steps" aria-label="Release progress">
      {job.steps.map((step) => {
        const Icon = STEP_ICON[step.status];
        return (
          <li key={step.name} className={`git-release-step git-release-step-${step.status}`}>
            <Icon className={`icon${step.status === 'running' ? ' icon-spin' : ''}`} aria-hidden />
            <span>
              {releaseStepText(step.name, status, job.version, job.working)}
              <span className="sr-only"> ({step.status})</span>
              {step.detail && <span className="muted small"> {step.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The release tab: what a release carries, the version and notes, the plan, and the job's progress. */
export function GitReleaseTab({ projectId, status }: { projectId: string; status: GitPageStatus }) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/git`;
  const { releaseJob: job, releaseDraft: draft, releaseSummary: summary } = status;
  const suggestion = suggestedVersion(status.latestTag);
  const [version, setVersion] = useState(draft?.version ?? suggestion);
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when Retry answered `restart_needed`: the failed job is then replaced by a new start.
  const [restart, setRestart] = useState(false);

  // A new draft replaces what is in the fields; the person's edits are theirs until then.
  const draftAt = draft?.status === 'ready' ? draft.at : null;
  useEffect(() => {
    if (draftAt === null || !draft) return;
    setVersion(draft.version ?? suggestion);
    setNotes(draft.notes);
    // Only a new draft re-seeds the fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAt]);
  useEffect(() => setRestart(false), [job?.id]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await client.invalidateQueries({ queryKey: ['git', projectId] });
    } catch (e) {
      setProblem(problemOf(e));
      if (e instanceof ApiRequestError && e.code === 'restart_needed') setRestart(true);
    } finally {
      setBusy(false);
    }
  };

  const working = status.workingBranch;
  const separate = working !== status.defaultBranch;
  const versionText = version.trim();
  const versionOk = RELEASE_VERSION.test(versionText);
  const blocked =
    releaseBlockedText(status) ?? (summary.head === null ? 'The working branch has no commits.' : null);
  const drafting = draft?.status === 'drafting';
  const stale = draft?.status === 'ready' && draft.head !== summary.head;
  const start = (mode: StartReleaseBody['mode']) => {
    if (summary.head === null) return;
    const head = summary.head;
    void act(() =>
      api(`${base}/release`, 'POST', {
        mode,
        ...(mode === 'publish' ? { version: versionText, notes } : {}),
        head,
      } satisfies StartReleaseBody),
    );
  };

  const jobOpen = job !== null && !restart && (job.state === 'running' || job.state === 'failed');
  const jobPanel = job && (
    <section className="panel git-release-job" aria-label="Release job">
      <h3>
        {job.mode === 'publish' ? `Release ${job.version ?? ''}` : 'Promote'}{' '}
        <span className="muted small">
          {job.state === 'running'
            ? 'running'
            : job.state === 'failed'
              ? 'failed'
              : job.state === 'done'
                ? 'done'
                : 'undone'}
        </span>
      </h3>
      <JobSteps job={job} status={status} />
      {job.error && (
        <div className="banner banner-error" role="alert">
          {job.error}
        </div>
      )}
      {job.state === 'done' && job.releaseUrl && (
        <p>
          <a href={job.releaseUrl} target="_blank" rel="noreferrer">
            Release {job.version ?? ''} on the forge
          </a>
        </p>
      )}
      {job.state === 'failed' && !restart && (
        <div className="git-release-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void act(() => api(`${base}/release/retry`, 'POST'))}
          >
            Retry
          </button>
          {canUndoPromote(job) && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void act(() => api(`${base}/release/undo-promote`, 'POST'))}
            >
              Undo promote
            </button>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div className="git-release">
      {problem && <GitProblemBanner problem={problem} />}
      {jobPanel}
      {!jobOpen && (
        <>
          <section aria-label="Summary">
            <p>
              <strong>{releaseSummaryText(status)}</strong>
            </p>
            <p className="muted small">{releaseChecksText(status)}</p>
          </section>

          <label className="git-release-field">
            <span>Version</span>
            <input
              className="input mono"
              aria-label="Version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          {!versionOk && (
            <p className="muted small" role="alert">
              A version looks like v1.2.3 (or 1.2.3, with an optional pre-release such as -rc.1).
            </p>
          )}

          <label className="git-release-field">
            <span>Release notes</span>
            <textarea
              className="input wizard-textarea"
              rows={10}
              aria-label="Release notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="git-release-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || drafting || summary.head === null}
              onClick={() => void act(() => api(`${base}/release/draft`, 'POST'))}
            >
              Draft notes with an agent
            </button>
            {drafting && (
              <span className="muted small">
                <LoaderCircle className="icon icon-spin" aria-hidden /> Drafting…
              </span>
            )}
          </div>
          {draft?.status === 'failed' && (
            <p className="muted small" role="alert">
              The draft failed: {draft.error ?? 'no reason was given.'}
            </p>
          )}
          {stale && <p className="muted small">The draft was written for an older tip of {working}.</p>}

          <section aria-label="What happens">
            <h3>What happens</h3>
            <ol>
              {releasePlan(status, 'publish', versionOk ? versionText : null).map((l) => (
                <li key={l.name}>{l.text}</li>
              ))}
            </ol>
          </section>

          {blocked && <p className="muted small">{blocked}</p>}
          <div className="git-release-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || blocked !== null || !versionOk}
              onClick={() => start('publish')}
            >
              Approve and publish
            </button>
            {separate && (
              <button
                type="button"
                className="btn"
                disabled={busy || blocked !== null}
                title={`Merge ${working} into ${status.defaultBranch} without a tag or a release`}
                onClick={() => start('promote_only')}
              >
                Promote only
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

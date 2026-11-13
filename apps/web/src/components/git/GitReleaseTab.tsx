import {
  RELEASE_VERSION,
  type GitPageStatus,
  type ReleaseDraft,
  type ReleaseJob,
  type StartReleaseBody,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleDashed, LoaderCircle, Minus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../../api';
import {
  canUndoPromote,
  factoryMergesWaitText,
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

interface ReleaseForm {
  version: string;
  notes: string;
  /** The draft the fields were last filled from, and its version and notes: told apart from the person's edits. */
  appliedAt: string | null;
  appliedVersion: string;
  appliedNotes: string;
}

const seedFrom = (draft: ReleaseDraft | null, suggestion: string): ReleaseForm => {
  const ready = draft?.status === 'ready' ? draft : null;
  const version = ready?.version ?? suggestion;
  return {
    version,
    notes: ready?.notes ?? '',
    appliedAt: ready?.at ?? null,
    appliedVersion: version,
    appliedNotes: ready?.notes ?? '',
  };
};

const formKey = (projectId: string) => `emberline.git.release.${projectId}`;
function readForm(projectId: string): ReleaseForm | null {
  try {
    const raw = window.sessionStorage.getItem(formKey(projectId));
    return raw ? (JSON.parse(raw) as ReleaseForm) : null;
  } catch {
    return null;
  }
}
function clearForm(projectId: string): void {
  try {
    window.sessionStorage.removeItem(formKey(projectId));
  } catch {
    // Nothing stored, nothing to clear.
  }
}
// Which finished job already reset the form, so that opening the tab again does not reset the next edits.
const endedKey = (projectId: string) => `emberline.git.release.ended.${projectId}`;
function endedJobOf(projectId: string): string | null {
  try {
    return window.sessionStorage.getItem(endedKey(projectId));
  } catch {
    return null;
  }
}
function markEnded(projectId: string, jobId: string): void {
  try {
    window.sessionStorage.setItem(endedKey(projectId), jobId);
  } catch {
    // Without storage the form is reset again when the tab is opened.
  }
}
function writeForm(projectId: string, form: ReleaseForm): void {
  try {
    window.sessionStorage.setItem(formKey(projectId), JSON.stringify(form));
  } catch {
    // Without storage the edits only last while the tab is open.
  }
}

/** The release tab: what a release carries, the version and notes, the plan, and the job's progress. */
export function GitReleaseTab({ projectId, status }: { projectId: string; status: GitPageStatus }) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/git`;
  const { releaseJob: job, releaseDraft: draft, releaseSummary: summary } = status;
  const suggestion = suggestedVersion(status.latestTag);
  const [form, setForm] = useState<ReleaseForm>(() => readForm(projectId) ?? seedFrom(draft, suggestion));
  const { version, notes } = form;
  const [mode, setMode] = useState<StartReleaseBody['mode']>('publish');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when Retry answered `restart_needed`: the failed job is then replaced by a new start.
  const [restart, setRestart] = useState(false);

  // The person's edits outlive a tab switch, except the form a finished release reset (see below).
  const fresh = useRef<ReleaseForm | null>(null);
  useEffect(() => {
    if (form !== fresh.current) writeForm(projectId, form);
  }, [projectId, form]);

  // A release that is over leaves nothing to carry on: the next one starts from the new suggestion,
  // not from the version and notes of the last. A draft already shown counts as applied.
  const jobEnded = job?.state === 'done' || job?.state === 'undone';
  useEffect(() => {
    if (!job || !jobEnded || endedJobOf(projectId) === job.id) return;
    markEnded(projectId, job.id);
    clearForm(projectId);
    const next: ReleaseForm = {
      version: suggestion,
      notes: '',
      appliedAt: draft?.at ?? null,
      appliedVersion: suggestion,
      appliedNotes: '',
    };
    fresh.current = next;
    setForm(next);
    // Only the job's end matters here; the suggestion and draft are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, jobEnded]);

  // A new draft fills the fields only while the person has edited neither the notes nor the version;
  // otherwise it waits behind "Use the new draft", so a draft that finishes late never overwrites their text.
  const newDraft = draft?.status === 'ready' && draft.at !== form.appliedAt ? draft : null;
  const untouched = form.notes === form.appliedNotes && form.version === form.appliedVersion;
  useEffect(() => {
    if (newDraft && untouched) setForm(seedFrom(newDraft, suggestion));
    // `suggestion` only matters when a draft names no version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDraft?.at, untouched]);
  useEffect(() => setRestart(false), [job?.id]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      const p = problemOf(e);
      if (e instanceof ApiRequestError && e.code === 'head_moved')
        p.text = `${status.workingBranch} has new commits since this page loaded. Review the summary again before you release.`;
      setProblem(p);
      if (e instanceof ApiRequestError && e.code === 'restart_needed') setRestart(true);
    } finally {
      // After a refusal too: the page must show the tip the server now has.
      await client.invalidateQueries({ queryKey: ['git', projectId] });
      setBusy(false);
    }
  };

  const working = status.workingBranch;
  const separate = working !== status.defaultBranch;
  const separateMode = separate ? mode : 'publish';
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
      {job.state === 'running' && factoryMergesWaitText(status, job.working) && (
        <p className="muted small">{factoryMergesWaitText(status, job.working)}</p>
      )}
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

          {/* Promote only makes no release: no version, no notes and no draft of them. */}
          {separateMode === 'publish' && (
            <>
              <label className="git-release-field">
                <span>Version</span>
                <input
                  className="input mono"
                  aria-label="Version"
                  value={version}
                  onChange={(e) => setForm({ ...form, version: e.target.value })}
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
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
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
              {newDraft && (
                <p className="small">
                  A new draft is ready.{' '}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setForm(seedFrom(newDraft, suggestion))}
                  >
                    Use the new draft
                  </button>
                </p>
              )}
              {stale && <p className="muted small">The draft was written for an older tip of {working}.</p>}
            </>
          )}

          {separate && (
            <fieldset className="git-release-mode">
              <legend className="sr-only">What to do</legend>
              <label>
                <input
                  type="radio"
                  name="release-mode"
                  checked={mode === 'publish'}
                  onChange={() => setMode('publish')}
                />{' '}
                Approve and publish
              </label>
              <label>
                <input
                  type="radio"
                  name="release-mode"
                  checked={mode === 'promote_only'}
                  onChange={() => setMode('promote_only')}
                />{' '}
                Promote only
              </label>
            </fieldset>
          )}

          <section aria-label="What happens">
            <h3>What happens</h3>
            <ol className="git-release-plan">
              {releasePlan(status, separateMode, versionOk ? versionText : null).map((l) => (
                <li key={l.name}>{l.text}</li>
              ))}
            </ol>
            {factoryMergesWaitText(status) && <p className="muted small">{factoryMergesWaitText(status)}</p>}
          </section>

          {blocked && <p className="muted small">{blocked}</p>}
          <div className="git-release-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || blocked !== null || (separateMode === 'publish' && !versionOk)}
              onClick={() => start(separateMode)}
            >
              {separateMode === 'publish' ? 'Approve and publish' : 'Promote only'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

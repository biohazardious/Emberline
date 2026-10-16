import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { CronOverlapPolicy, CronPermissionMode, CronPreviewResponse, Project, Run, ScheduledJob } from '@emberline/protocol';
import { X } from 'lucide-react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';

interface Props {
  projects: Project[];
  onRunCreated?: (run: Run) => void;
}

const PRESETS = [
  {
    label: 'Nightly Test & Lint Fix (02:00)',
    name: 'Nightly Test & Lint Maintenance',
    cronExpr: '0 2 * * *',
    prompt:
      'Run the test suite and linter. If any tests or lint checks fail, investigate the root cause and commit a minimal fix.',
  },
  {
    label: 'Weekly Dependency & Security Audit (Mon 04:00)',
    name: 'Weekly Security & Dependency Audit',
    cronExpr: '0 4 * * 1',
    prompt:
      'Audit project dependencies and recent changes for security vulnerabilities or outdated packages, and summarize findings.',
  },
];

/** The viewer's zone; schedules default to it so "02:00" means their 02:00. */
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const formatInZone = (iso: string, timeZone: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(iso).toLocaleString();
  }
};

export function ScheduledJobsPanel({ projects, onRunCreated }: Props) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 2 * * *');
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] = useState<CronPermissionMode>('auto');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [overlapPolicy, setOverlapPolicy] = useState<CronOverlapPolicy>('skip');
  const [preview, setPreview] = useState<{ runs: string[]; error: string | null }>({ runs: [], error: null });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const list = await api<ScheduledJob[]>('/api/cron');
      setJobs(list);
    } catch {
      // ignore initial load error
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (projects[0] && !projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  // Live "next 5 runs" preview while the expression or zone is edited.
  useEffect(() => {
    if (!formOpen || !cronExpr.trim()) return;
    let stale = false;
    const timer = setTimeout(() => {
      api<CronPreviewResponse>('/api/cron/preview', 'POST', { cronExpr: cronExpr.trim(), timeZone: timeZone.trim() })
        .then((res) => {
          if (!stale) setPreview({ runs: res.nextRuns, error: null });
        })
        .catch((err: unknown) => {
          if (!stale) setPreview({ runs: [], error: errorMessage(err) });
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [formOpen, cronExpr, timeZone]);

  const visibleJobs = jobs.filter((j) => projects.some((p) => p.id === j.projectId));

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || !name.trim() || !cronExpr.trim() || !prompt.trim()) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api<ScheduledJob>('/api/cron', 'POST', {
        projectId,
        name: name.trim(),
        cronExpr: cronExpr.trim(),
        prompt: prompt.trim(),
        permissionMode,
        enabled: true,
        timeZone: timeZone.trim() || undefined,
        overlapPolicy,
      });
      setJobs((prev) => [...prev, created]);
      setName('');
      setPrompt('');
      setFormOpen(false);
      setNotice(`Scheduled "${created.name}" (${created.cronExpr}).`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleEnabled = async (job: ScheduledJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      const updated = await api<ScheduledJob>(`/api/cron/${job.id}`, 'PATCH', {
        enabled: !job.enabled,
      });
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleTriggerNow = async (job: ScheduledJob) => {
    setBusyId(job.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ job: ScheduledJob; run: Run }>(`/api/cron/${job.id}/trigger`, 'POST', {});
      setJobs((prev) => prev.map((j) => (j.id === job.id ? res.job : j)));
      setNotice(`Triggered "${job.name}" → run ${res.run.id.slice(0, 8)} started.`);
      onRunCreated?.(res.run);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (job: ScheduledJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      await api<void>(`/api/cron/${job.id}`, 'DELETE');
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'project';

  return (
    <section className="panel" aria-labelledby="cron-title">
      <header className="panel-head">
        <div>
          <h2 id="cron-title">Scheduled Agent Jobs (Cron)</h2>
          <p className="muted">
            Recurring maintenance, nightly test runs, and automated audits. Quota-aware: pauses automatically during rate limits.
          </p>
        </div>
        <div className="actions">
          <span className="badge mono">{visibleJobs.filter((j) => j.enabled).length} ACTIVE</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setFormOpen((v) => !v)}
            disabled={projects.length === 0}
          >
            {formOpen ? 'Cancel' : '+ Schedule Job'}
          </button>
        </div>
      </header>

      {formOpen && (
        <form className="form" onSubmit={(e) => void handleCreate(e)} style={{ marginBottom: '0.75rem' }}>
          <div className="form-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className="muted small">Templates:</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setName(preset.name);
                  setCronExpr(preset.cronExpr);
                  setPrompt(preset.prompt);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="form-row">
            <select
              className="input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              style={{ maxWidth: '200px' }}
              required
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="input"
              placeholder="Job name (e.g. Nightly Test & Lint)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              type="text"
              className="input mono"
              placeholder="Cron (e.g. 0 2 * * * or @daily)"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              style={{ maxWidth: '180px' }}
              required
            />
            <input
              type="text"
              className="input mono"
              placeholder="Time zone (e.g. Europe/Istanbul)"
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              style={{ maxWidth: '180px' }}
              title="IANA time zone the schedule is evaluated in"
            />
            <select
              className="input"
              value={overlapPolicy}
              onChange={(e) => setOverlapPolicy(e.target.value as CronOverlapPolicy)}
              style={{ maxWidth: '200px' }}
              title="What happens when the job is due while its previous run is still going"
            >
              <option value="skip">Skip if still running</option>
              <option value="queue">Queue another run</option>
            </select>
            <select
              className="input"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as CronPermissionMode)}
              style={{ maxWidth: '170px' }}
              title="Scheduled runs are unattended, so they never stop to ask permission"
            >
              <option value="auto">Autonomous</option>
              <option value="bypassPermissions">Bypass permissions</option>
            </select>
          </div>

          <p className="muted small mono" aria-live="polite">
            {preview.error
              ? `Invalid schedule: ${preview.error}`
              : preview.runs.length > 0
                ? `Next runs: ${preview.runs.map((iso) => formatInZone(iso, timeZone)).join(' · ')}`
                : ' '}
          </p>

          <textarea
            className="input textarea"
            rows={2}
            placeholder="Prompt to execute on each scheduled run…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
          />

          <div className="form-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={creating}>
              {creating ? 'Saving…' : 'Create Scheduled Job'}
            </button>
          </div>
        </form>
      )}

      {notice && <p className="muted small mono" style={{ padding: '0 0.25rem' }}>{notice}</p>}
      {error && <p className="form-error">{error}</p>}

      {visibleJobs.length === 0 ? (
        <div className="empty">
          <p>No scheduled jobs configured.</p>
          <p className="muted">
            Click <strong>+ Schedule Job</strong> to run Claude on a recurring cron schedule (`0 2 * * *`, `@daily`, etc.).
          </p>
        </div>
      ) : (
        <ul className="list">
          {visibleJobs.map((job) => (
            <li key={job.id} className="row">
              <div className="row-main">
                <span className={`dot ${job.enabled ? 'dot-running' : 'dot-exited'}`} />
                <span className="row-title">{job.name}</span>
                <span className="badge badge-soft">{projectName(job.projectId)}</span>
                <span className="badge mono">{job.cronExpr}</span>
                <span className="badge badge-soft mono" title="Time zone the schedule runs in">
                  {job.timeZone}
                </span>
                {job.overlapPolicy === 'queue' && (
                  <span className="badge badge-soft" title="Due runs are queued even while the previous one runs">
                    queues overlaps
                  </span>
                )}
                <span className="row-meta mono">next: {formatInZone(job.nextRunAt, job.timeZone)}</span>
                {job.lastRunId && (
                  <Link href={`/runs/${job.lastRunId}/review`} className="badge mono">
                    last run ↗
                  </Link>
                )}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId === job.id}
                  onClick={() => void handleTriggerNow(job)}
                  title="Spawn a run for this scheduled job immediately"
                >
                  Run Now
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busyId === job.id}
                  onClick={() => void handleToggleEnabled(job)}
                >
                  {job.enabled ? 'Pause' : 'Enable'}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${job.name}`}
                  disabled={busyId === job.id}
                  onClick={() => void handleDelete(job)}
                >
                  <X className="icon" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

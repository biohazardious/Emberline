import type {
  DockerCleanupResponse,
  DockerContainer,
  DockerOverview,
  DockerProject,
  DockerProjectActionResponse,
  DockerProjectLogsResponse,
} from '@emberline/protocol';
import { Container, FileText, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { dockerEngineLine, dockerEngineOffState } from '../dockerEngine';
import {
  actionsFor,
  cleanupLines,
  cleanupResultText,
  confirmText,
  containerStateTone,
  type DockerAction,
  type DockerDone,
  doneStillCurrent,
  dockerErrorDetails,
  groupDockerProjects,
  ownerBadges,
  ownerSummary,
  portLink,
  projectServices,
  projectStatusTone,
} from '../dockerPage';
import { useApi } from '../hooks/useApi';
import { timeAgo } from '../time';

type ErrorDetails = { message: string; output: string | null };

/** An error in `role="alert"`, with the failed command's output (untrusted) as plain text. */
function DockerAlert({ error }: { error: ErrorDetails | string }) {
  const { message, output } = typeof error === 'string' ? { message: error, output: null } : error;
  return (
    <div className="banner banner-error docker-alert" role="alert">
      <p>{message}</p>
      {output && <pre className="docker-output mono">{output}</pre>}
    </div>
  );
}

const projectPath = (name: string) => `/api/docker/projects/${encodeURIComponent(name)}`;

function ContainerRow({ container }: { container: DockerContainer }) {
  const tone = containerStateTone(container.state);
  return (
    <li className="docker-container">
      <span className="mono docker-container-service" title={container.name}>
        {container.service ?? container.name}
      </span>
      <span className={`badge${tone ? ` badge-${tone}` : ''}`}>{container.state}</span>
      {container.ports.map((published) => {
        const { text, href } = portLink(published);
        // Only the engine's preview range is published on the host; other ports are shown, not linked.
        return href ? (
          <a key={published.port} className="mono docker-port" href={href} target="_blank" rel="noreferrer">
            {text}
          </a>
        ) : (
          <span
            key={published.port}
            className="mono muted docker-port"
            title="Published inside the Docker engine only, not on the host"
          >
            {text}
          </span>
        );
      })}
      <span className="mono muted small docker-image">{container.image}</span>
      <span className="muted small" title={container.createdAt}>
        {container.status} · created {container.runningFor}
      </span>
    </li>
  );
}

function LogsPanel({ project }: { project: DockerProject }) {
  const services = projectServices(project);
  const [service, setService] = useState('');
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = service ? `?service=${encodeURIComponent(service)}` : '';
    api<DockerProjectLogsResponse>(`${projectPath(project.name)}/logs${query}`)
      .then((res) => {
        if (!cancelled) setLogs(res.logs);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLogs(null);
        setError(dockerErrorDetails(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.name, service, reload]);

  return (
    <div className="docker-logs" aria-busy={loading}>
      <div className="docker-logs-head">
        {services.length > 1 && (
          <label className="docker-logs-service">
            <span className="muted small">Service</span>
            <select
              className="input"
              value={service}
              onChange={(e) => {
                // Another service's output must not stand in for this one's while it loads.
                setLogs(null);
                setService(e.target.value);
              }}
            >
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="muted small">Last 200 lines, at most 2000 characters</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={loading}
          onClick={() => setReload((n) => n + 1)}
        >
          <RefreshCw className={`icon${loading ? ' icon-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>
      {error && <DockerAlert error={error} />}
      {logs !== null && (
        <pre className="docker-output mono" tabIndex={0} aria-label={`Logs of ${project.name}`}>
          {logs || '(no output)'}
        </pre>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onStart,
  onDone,
}: {
  project: DockerProject;
  onStart: () => void;
  onDone: (done: DockerDone) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<DockerAction | null>(null);
  const [busy, setBusy] = useState<DockerAction | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const owner = ownerSummary(project.owner);
  const statusTone = projectStatusTone(project.status);

  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);

  async function run(action: DockerAction) {
    setConfirm(null);
    setError(null);
    setBusy(action);
    onStart();
    try {
      await api<DockerProjectActionResponse>(`${projectPath(project.name)}/${action}`, 'POST');
      await onDone({
        project: project.name,
        text: `${action === 'stop' ? 'Stopped' : 'Removed'} ${project.name}.`,
      });
    } catch (e) {
      setError(dockerErrorDetails(e));
    } finally {
      setBusy(null);
    }
  }

  const prompt = confirm ? confirmText(project, confirm) : null;
  const actions = actionsFor(project.owner);

  return (
    <li className="docker-project">
      <div className="docker-project-head">
        <strong className="mono docker-project-name">{project.name}</strong>
        {project.status && (
          <span className={`badge${statusTone ? ` badge-${statusTone}` : ''}`}>{project.status}</span>
        )}
        {ownerBadges(project.owner).map((b) => (
          <span key={b.text} className={`badge badge-${b.tone}`}>
            {b.text}
          </span>
        ))}
      </div>
      <p className="docker-owner small">
        <span className="muted">{owner.prefix}</span>
        {owner.text && owner.href && (
          <>
            {' '}
            <Link href={owner.href} className="mono">
              {owner.text}
            </Link>
          </>
        )}
        {owner.detail && <span className="muted"> · {owner.detail}</span>}
      </p>

      {project.containers.length > 0 ? (
        <ul className="docker-containers" aria-label={`Containers of ${project.name}`}>
          {project.containers.map((c) => (
            <ContainerRow key={c.name} container={c} />
          ))}
        </ul>
      ) : (
        <p className="muted small">No containers.</p>
      )}

      <div className="docker-actions">
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={logsOpen}
          onClick={() => setLogsOpen((open) => !open)}
        >
          <FileText className="icon" aria-hidden /> {logsOpen ? 'Hide logs' : 'Logs'}
        </button>
        {actions.includes('stop') && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            aria-pressed={confirm === 'stop'}
            onClick={() => setConfirm(confirm === 'stop' ? null : 'stop')}
          >
            <Square className="icon" aria-hidden /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm danger"
          disabled={busy !== null}
          aria-pressed={confirm === 'remove'}
          onClick={() => setConfirm(confirm === 'remove' ? null : 'remove')}
        >
          <Trash2 className="icon" aria-hidden /> {busy === 'remove' ? 'Removing…' : 'Remove'}
        </button>
      </div>

      {confirm && prompt && (
        <div className="docker-confirm" role="group" aria-label={`Confirm ${confirm} ${project.name}`}>
          <p>{prompt.question}</p>
          {prompt.warning && <p className="docker-confirm-warning">{prompt.warning}</p>}
          <div className="docker-actions">
            <button
              ref={confirmButton}
              type="button"
              className={`btn btn-sm${confirm === 'remove' ? ' danger' : ''}`}
              onClick={() => void run(confirm)}
            >
              {confirm === 'stop' ? 'Stop it' : 'Remove it'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <DockerAlert error={error} />}
      {logsOpen && <LogsPanel project={project} />}
    </li>
  );
}

function EngineCard({
  data,
  onStart,
  onCleaned,
}: {
  data: DockerOverview;
  onStart: () => void;
  onCleaned: () => Promise<void>;
}) {
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const lines = cleanupLines(data.cleanup, timeAgo);
  const sweeping = cleaning || data.cleanup.sweeping;

  async function cleanUp() {
    setCleaning(true);
    setResult(null);
    setError(null);
    onStart();
    try {
      setResult(cleanupResultText(await api<DockerCleanupResponse>('/api/docker/cleanup', 'POST')));
      await onCleaned();
    } catch (e) {
      setError(dockerErrorDetails(e));
    } finally {
      setCleaning(false);
    }
  }

  return (
    <section className="panel docker-engine" aria-label="Docker engine">
      <div className="docker-engine-head">
        {/* With `error` set the alert below gives the reason; the headline stays short. */}
        <p className="docker-engine-line">
          {dockerEngineLine(data.error ? { ...data.engine, error: undefined } : data.engine)}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={sweeping || !data.engine.available}
          onClick={() => void cleanUp()}
        >
          <RefreshCw className={`icon${sweeping ? ' icon-spin' : ''}`} aria-hidden />{' '}
          {sweeping ? 'Cleaning up…' : 'Clean up now'}
        </button>
      </div>
      <p className="muted small">
        {lines.sweep} {lines.prune}
      </p>
      {result &&
        (result.ok ? (
          <p className="small" role="status">
            {result.text}
          </p>
        ) : (
          <DockerAlert error={result.text} />
        ))}
      {error && <DockerAlert error={error} />}
      {data.error && <DockerAlert error={data.error} />}
      {data.disk.error && <DockerAlert error={`Disk use could not be read: ${data.disk.error}`} />}
      {data.disk.rows.length > 0 && (
        <table className="docker-disk">
          <caption className="sr-only">Disk use in the engine</caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Size</th>
              <th scope="col">Reclaimable</th>
            </tr>
          </thead>
          <tbody>
            {data.disk.rows.map((row) => (
              <tr key={row.type}>
                <th scope="row">{row.type}</th>
                <td className="mono">{row.size}</td>
                <td className="mono">{row.reclaimable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function DockerPage() {
  const { data, error: loadError, loading, refresh } = useApi<DockerOverview>('/api/docker', 10_000);
  const [done, setDone] = useState<DockerDone | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);

  const clearDone = useCallback(() => setDone(null), []);
  // Set after the refetch, so the line shows (and takes focus) once the list no longer has the project.
  const onDone = useCallback(
    async (next: DockerDone) => {
      await refresh();
      setDone(next);
    },
    [refresh],
  );
  // The card that had focus is gone after a Stop or Remove: focus moves to the line saying what happened.
  useEffect(() => {
    if (done) statusLine.current?.focus();
  }, [done]);
  // Once that project is listed again (something started it anew), the line no longer holds.
  useEffect(() => {
    if (done && data && !doneStillCurrent(done, data.projects)) setDone(null);
  }, [data, done]);

  const groups = data ? groupDockerProjects(data.projects) : [];
  const enabled = data?.engine.enabled ?? false;

  return (
    <div className="board-page docker-page">
      <div className="board-head">
        <div className="board-title">
          <Container className="icon" aria-hidden />
          <h1>Docker</h1>
        </div>
        <span className="muted small">Emberline's compose projects in the Docker engine</span>
      </div>

      {loadError !== undefined && <DockerAlert error={errorMessage(loadError)} />}
      {loading && !data && (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      )}

      {data && !enabled && (
        <div className="docker-empty">
          <Container className="icon" aria-hidden />
          <p>
            <strong>{dockerEngineOffState(data.engine).title}</strong>
          </p>
          <p className="muted small">
            {dockerEngineOffState(data.engine).text} The README's Docker engine section has the details.
          </p>
        </div>
      )}

      {data && enabled && (
        <>
          <EngineCard data={data} onStart={clearDone} onCleaned={refresh} />

          {done && doneStillCurrent(done, data.projects) && (
            <p ref={statusLine} className="small docker-done" role="status" tabIndex={-1}>
              {done.text}
            </p>
          )}
          {data.projectsError && (
            <DockerAlert error={`Projects could not be listed: ${data.projectsError}`} />
          )}
          {data.containersError && (
            <DockerAlert error={`Containers could not be listed: ${data.containersError}`} />
          )}

          {!data.error && groups.length === 0 && (
            <p className="muted">Emberline runs no compose projects in the engine right now.</p>
          )}

          {groups.map((group) => (
            <section key={group.kind} className="docker-group" aria-label={group.label}>
              <h2 className="inbox-group-head">
                {group.label} <span className="muted mono">{group.projects.length}</span>
              </h2>
              <p className="muted small docker-group-hint">{group.hint}</p>
              <ul className="docker-projects">
                {group.projects.map((p) => (
                  <ProjectCard key={p.name} project={p} onStart={clearDone} onDone={onDone} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

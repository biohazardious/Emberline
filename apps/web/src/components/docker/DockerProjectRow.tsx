import type {
  DockerContainer,
  DockerProject,
  DockerProjectActionResponse,
  DockerProjectLogsResponse,
  DockerPublishedPort,
} from '@emberline/protocol';
import { FileText, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import {
  actionsFor,
  confirmText,
  containerStateTone,
  type DockerAction,
  type DockerDone,
  dockerErrorDetails,
  ownerBadges,
  ownerSummary,
  portLink,
  projectServices,
  projectStatusTone,
} from '../../dockerPage';
import { DockerAlert, type ErrorDetails } from './DockerAlert';

const projectPath = (name: string) => `/api/docker/projects/${encodeURIComponent(name)}`;

function PublishedPortBadge({ published }: { published: DockerPublishedPort }) {
  const { text, href } = portLink(published);
  return href ? (
    <a className="mono docker-ux-port" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className="mono muted docker-ux-port">{text}</span>
  );
}

function ContainerRow({ container }: { container: DockerContainer }) {
  const tone = containerStateTone(container.state);
  return (
    <li className="docker-ux-container">
      <span className="mono docker-ux-container-service">{container.service ?? container.name}</span>
      {container.service && container.service !== container.name && (
        <span className="mono muted small">{container.name}</span>
      )}
      <span className={`badge${tone ? ` badge-${tone}` : ''}`}>{container.state}</span>
      {container.ports.map((published) => (
        <PublishedPortBadge key={published.port} published={published} />
      ))}
      <span className="mono muted docker-ux-image">{container.image}</span>
      <span className="muted small">
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
    <div className="docker-ux-logs" aria-busy={loading}>
      <div className="docker-ux-logs-head">
        {services.length > 1 && (
          <label className="docker-ux-logs-service">
            <span className="muted">Service</span>
            <select
              className="input"
              value={service}
              onChange={(e) => {
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
        <span className="muted small">Last 200 lines (max 2000 chars)</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={loading}
          onClick={() => setReload((n) => n + 1)}
        >
          <RefreshCw className={`icon${loading ? ' icon-spin' : ''}`} aria-hidden="true" /> Refresh
        </button>
      </div>
      {error && <DockerAlert error={error} />}
      {logs !== null && (
        <pre className="docker-ux-output mono" tabIndex={0} aria-label={`Logs of ${project.name}`}>
          {logs || '(no output)'}
        </pre>
      )}
    </div>
  );
}

export function DockerProjectRow({
  project,
  projectLabel,
  onStart,
  onDone,
}: {
  project: DockerProject;
  /** The Emberline project this row belongs to; shown under "All projects". */
  projectLabel?: string;
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
  const ports = project.containers.flatMap((c) => c.ports);

  return (
    <li className="docker-ux-project">
      <div className="docker-ux-project-bar">
        <div className="docker-ux-project-main">
          <strong className="mono docker-ux-project-name">{project.name}</strong>
          {projectLabel !== undefined && <span className="badge badge-soft">{projectLabel}</span>}
          {project.status && (
            <span className={`badge${statusTone ? ` badge-${statusTone}` : ''}`}>{project.status}</span>
          )}
          {ownerBadges(project.owner).map((b) => (
            <span key={b.text} className={`badge badge-${b.tone}`}>
              {b.text}
            </span>
          ))}
          {owner.text && owner.href && (
            <Link href={owner.href} className="mono small">
              {owner.text}
            </Link>
          )}
          {ports.map((published) => (
            <PublishedPortBadge key={published.port} published={published} />
          ))}
        </div>

        <div className="docker-ux-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={logsOpen}
            onClick={() => setLogsOpen((open) => !open)}
          >
            <FileText className="icon" aria-hidden="true" /> {logsOpen ? 'Hide logs' : 'Logs'}
          </button>
          {actions.includes('stop') && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              aria-pressed={confirm === 'stop'}
              onClick={() => setConfirm(confirm === 'stop' ? null : 'stop')}
            >
              <Square className="icon" aria-hidden="true" /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm danger"
            disabled={busy !== null}
            aria-pressed={confirm === 'remove'}
            onClick={() => setConfirm(confirm === 'remove' ? null : 'remove')}
          >
            <Trash2 className="icon" aria-hidden="true" /> {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>

      {confirm && prompt && (
        <div className="docker-ux-confirm" role="group" aria-label={`Confirm ${confirm} ${project.name}`}>
          <p>{prompt.question}</p>
          {prompt.warning && <p className="docker-ux-confirm-warning">{prompt.warning}</p>}
          <div className="docker-ux-actions">
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

      {logsOpen && (
        <div className="docker-ux-details">
          <p className="docker-ux-owner">
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
            <ul className="docker-ux-containers" aria-label={`Containers of ${project.name}`}>
              {project.containers.map((c) => (
                <ContainerRow key={c.name} container={c} />
              ))}
            </ul>
          ) : (
            <p className="muted small">No containers.</p>
          )}
          <LogsPanel project={project} />
        </div>
      )}
    </li>
  );
}

import type { AgentPersona, Ticket } from '@emberline/protocol';
import { Play, Sparkles } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { BoardExportMenu } from '../BoardExportMenu';
import { PERSONA_LIST } from '../PersonaBadge';
import { ico } from '../SectionState';
import { type BoardCtx, COLUMNS } from './boardMeta';

function QuickAdd({
  projectId,
  onCreated,
  onError,
}: {
  projectId: string;
  onCreated: (ticket: Ticket) => void;
  onError: (message: string | undefined) => void;
}) {
  const [title, setTitle] = useState('');
  const [persona, setPersona] = useState<AgentPersona>('coder');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    onError(undefined);
    try {
      onCreated(await api<Ticket>(`/api/projects/${projectId}/tickets`, 'POST', { title, persona }));
      setTitle('');
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="quick-add" onSubmit={(e) => void submit(e)}>
      <select
        className="input"
        aria-label="Ticket persona"
        style={{ width: 'auto', maxWidth: 'min(320px, 100%)', padding: '6px 8px', fontSize: '0.82rem' }}
        value={persona}
        onChange={(e) => setPersona(e.target.value as AgentPersona)}
        title="Assign specialist persona for this ticket"
      >
        {PERSONA_LIST.map((p) => (
          <option key={p.id} value={p.id}>
            [{p.shortLabel}] {p.label}
          </option>
        ))}
      </select>
      <input
        id="ticket-title"
        className="input"
        placeholder="New ticket title…"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button id="ticket-add" className="btn btn-primary" disabled={busy || !title.trim()}>
        Add
      </button>
    </form>
  );
}

export function BoardHeaderSection({
  ctx,
  loading,
  error,
  onRetry,
}: {
  ctx: BoardCtx;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => Promise<void>;
}) {
  const {
    pid,
    proj: project,
    tickets,
    auto,
    flipAuto,
    demo,
    flipDemo,
    openBp,
    openImp,
    back,
    patch,
    setErr,
  } = ctx;
  const [seeding, setSeeding] = useState(false);

  const seedTickets = async () => {
    setSeeding(true);
    setErr(undefined);
    try {
      const seeded = await api<Ticket[]>(`/api/projects/${pid}/seed-tickets`, 'POST', {});
      for (const t of seeded) patch(t);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <>
      <header className="board-head">
        <div className="board-title">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Back to the previous page"
            onClick={back}
          >
            ←
          </button>
          <div>
            <p className="eyebrow">{project?.name ?? (loading ? 'Loading…' : 'Project')} · Pipeline Board</p>
            <h1>{project?.name ?? 'Board'}</h1>
          </div>
        </div>
        <div className="board-controls">
          {project && (
            <>
              <Link href={`/projects/${project.id}/settings`} className="btn btn-sm">
                Project settings
              </Link>
              <button
                type="button"
                className={`btn btn-sm${demo ? ' btn-primary' : ''}`}
                onClick={flipDemo}
                title="View Project Status, Sync Worktrees & Play Live Demo"
              >
                {ico(Play)} Live Demo &amp; Status
              </button>
              <button type="button" className="btn btn-sm" onClick={openBp} title="Open PROJECT.md Blueprint">
                PROJECT.md
              </button>
            </>
          )}
          {(tickets?.length ?? 0) === 0 && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={seeding}
              onClick={() => void seedTickets()}
              title="Seed 4 starter tickets across PO, Architect, Coder, and QA personas"
            >
              {seeding ? 'Seeding…' : <>{ico(Sparkles)} Seed Starter Backlog</>}
            </button>
          )}
          <button
            id="pipeline-auto-start"
            type="button"
            className={`chip-toggle${auto ? ' active' : ''}`}
            aria-pressed={auto}
            title="When enabled, dragging a card into In progress automatically starts a Claude run"
            onClick={flipAuto}
          >
            <span className="dot" />
            Auto-dispatch on In progress
          </button>
          {project && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={openImp}
              title="Import issues from the project's GitHub, GitLab or Gitea remote"
            >
              Import issues
            </button>
          )}
          {project && <BoardExportMenu projectId={project.id} columns={COLUMNS} tickets={tickets} />}
          <QuickAdd projectId={pid} onCreated={patch} onError={setErr} />
        </div>
      </header>
      {error !== undefined && !project && (
        <div className="banner banner-error" role="alert">
          <span>Could not load project metadata: {errorMessage(error)}</span>
          {onRetry && (
            <button type="button" className="btn btn-sm" onClick={() => void onRetry()}>
              Retry
            </button>
          )}
        </div>
      )}
    </>
  );
}

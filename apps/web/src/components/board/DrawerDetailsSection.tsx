import type { Ticket, TicketStatus } from '@emberline/protocol';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { dependencyCandidates } from '../../ticketDeps';
import { timeAgo } from '../../time';
import { BOARD_COLUMNS, BOARD_PRIORITIES, IssueChips } from '../BoardCard';
import { ico } from '../SectionState';
import type { DrawerCtx } from './boardMeta';

export function DrawerDetailsSection({ ctx }: { ctx: DrawerCtx }) {
  const {
    ticket,
    allTickets,
    title,
    setTitle,
    body,
    setBody,
    priority,
    setPriority,
    dirty,
    busyAction,
    setBusyAction,
    save,
    onChanged,
    onMove,
  } = ctx;
  const [depError, setDepError] = useState<string>();
  const byId = new Map(allTickets.map((t) => [t.id, t]));
  const candidates = dependencyCandidates(ticket, allTickets);

  const setDependsOn = async (next: string[]) => {
    setBusyAction('deps');
    setDepError(undefined);
    try {
      onChanged(await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { dependsOn: next }));
    } catch (e) {
      setDepError(errorMessage(e));
    } finally {
      setBusyAction(undefined);
    }
  };

  return (
    <section className="drawer-section" aria-label="Details">
      <div className="drawer-section-head">
        <h2>Details</h2>
        <button
          id="drawer-save"
          type="button"
          className="btn btn-sm"
          disabled={!dirty || !!busyAction || !title.trim()}
          onClick={() => void save()}
        >
          {busyAction === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>

      <input
        id="drawer-title"
        className="input drawer-title"
        aria-label="Title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <IssueChips external={ticket.external} />
      <textarea
        id="drawer-body"
        className="input drawer-body"
        aria-label="Description"
        rows={5}
        placeholder="Details, acceptance criteria, files to inspect…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      {ticket.completion && (
        <section className="drawer-completion" aria-label="Completion">
          <div className="drawer-completion-head">
            <span className="drawer-label">Completion</span>
            {ticket.completion.blockers.length > 0 && (
              <span className="badge mono drawer-completion-blocked">blocked</span>
            )}
          </div>
          <p className="drawer-completion-summary">{ticket.completion.summary}</p>
          {ticket.completion.blockers.length > 0 && (
            <ul className="drawer-completion-blockers">
              {ticket.completion.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {ticket.completion.handoff && (
            <>
              <div className="muted small">Handoff</div>
              <p className="drawer-completion-handoff">{ticket.completion.handoff}</p>
            </>
          )}
          <div className="muted small mono">
            <Link href={`/runs/${ticket.completion.runId}/review`}>
              run {ticket.completion.runId.slice(0, 8)}
            </Link>
            {' · '}
            {timeAgo(ticket.completion.at)}
          </div>
        </section>
      )}

      <div className="drawer-grid-row">
        <label className="drawer-field" htmlFor="drawer-status">
          <span>Column</span>
          <select
            id="drawer-status"
            className="input"
            value={ticket.status}
            onChange={(e) => onMove(e.target.value as TicketStatus)}
          >
            {BOARD_COLUMNS.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="drawer-field" htmlFor="drawer-priority">
          <span>Priority</span>
          <select
            id="drawer-priority"
            className="input"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          >
            {BOARD_PRIORITIES.map((label, value) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="dep-editor">
        <label className="drawer-label" htmlFor="drawer-dep-add">
          Depends on
        </label>
        {ticket.dependsOn.length > 0 && (
          <ul className="dep-list">
            {ticket.dependsOn.map((id) => {
              const dep = byId.get(id);
              return (
                <li key={id} className="dep-item">
                  {dep ? (
                    <>
                      <Link
                        href={`/projects/${ticket.projectId}/board?ticket=${dep.id}`}
                        className="mono dep-key"
                      >
                        {dep.key}
                      </Link>
                      <span className="dep-title">{dep.title}</span>
                      <span className="badge badge-soft">{dep.status.replace('_', ' ')}</span>
                    </>
                  ) : (
                    <span className="mono muted dep-title">{id}</span>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove dependency ${dep?.key ?? id}`}
                    disabled={!!busyAction}
                    onClick={() => void setDependsOn(ticket.dependsOn.filter((d) => d !== id))}
                  >
                    {ico(X)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <select
          id="drawer-dep-add"
          className="input"
          value=""
          disabled={!!busyAction || candidates.length === 0}
          onChange={(e) => e.target.value && void setDependsOn([...ticket.dependsOn, e.target.value])}
        >
          <option value="">{candidates.length === 0 ? 'None available' : 'Add dependency…'}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.key} {c.title}
            </option>
          ))}
        </select>
        {depError && (
          <p className="form-error" role="alert">
            {depError}
          </p>
        )}
      </div>
    </section>
  );
}

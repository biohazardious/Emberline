import type { Ticket } from '@emberline/protocol';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { dependencyCandidates } from '../../ticketDeps';
import { timeAgo } from '../../time';
import { PersonaPicker, TaskTemplateBar } from '../PersonaBadge';
import { ico } from '../SectionState';
import { COLUMNS, type DrawerCtx, IssueChips, PRIORITIES } from './boardMeta';

export function DrawerDetailsSection({ ctx }: { ctx: DrawerCtx }) {
  const {
    t: ticket,
    all: allTickets,
    title,
    setTitle,
    body,
    setBody,
    prio: priority,
    setPrio,
    persona,
    setPersona,
    setMode,
    dirty,
    busy,
    setBusy,
    save,
    changed,
    move,
  } = ctx;
  const [depError, setDepError] = useState<string>();
  const byId = new Map(allTickets.map((t) => [t.id, t]));
  const candidates = dependencyCandidates(ticket, allTickets);

  const setDependsOn = async (next: string[]) => {
    setBusy('deps');
    setDepError(undefined);
    try {
      changed(await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { dependsOn: next }));
    } catch (e) {
      setDepError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <TaskTemplateBar
        onSelect={(tpl) => {
          setPersona(tpl.persona);
          setMode(tpl.permissionMode);
          if (!title.trim()) setTitle(tpl.titlePlaceholder);
          setBody(tpl.promptTemplate);
        }}
      />
      <input
        id="drawer-title"
        className="input drawer-title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <IssueChips external={ticket.external} />
      <textarea
        id="drawer-body"
        className="input drawer-body"
        rows={5}
        placeholder="Details, acceptance criteria, files to look at… (sent to the assigned agent with the title)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {ticket.completion && (
        <section className="drawer-completion" aria-label="Completion">
          <label className="drawer-label">
            Completion
            {ticket.completion.blockers.length > 0 && (
              <span
                className="badge mono"
                style={{ marginLeft: 8, borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                blocked
              </span>
            )}
          </label>
          <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{ticket.completion.summary}</p>
          {ticket.completion.blockers.length > 0 && (
            <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
              {ticket.completion.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {ticket.completion.handoff && (
            <>
              <div className="muted small">Handoff for dependent tickets</div>
              <p className="small" style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>
                {ticket.completion.handoff}
              </p>
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
      <label className="drawer-label">Specialist Persona</label>
      <PersonaPicker value={persona} onChange={setPersona} />
      <div className="drawer-row">
        <div className="segmented" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((label, value) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={priority === value}
              className={priority === value ? 'active' : ''}
              onClick={() => setPrio(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          id="drawer-save"
          className="btn btn-sm"
          disabled={!dirty || !!busy || !title.trim()}
          onClick={() => void save()}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>

      <label className="drawer-label" htmlFor="drawer-dep-add">
        Depends on
      </label>
      <div className="dep-editor">
        {ticket.dependsOn.length === 0 && <p className="muted small">No dependencies.</p>}
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
                  disabled={!!busy}
                  onClick={() => void setDependsOn(ticket.dependsOn.filter((d) => d !== id))}
                >
                  {ico(X)}
                </button>
              </li>
            );
          })}
        </ul>
        <select
          id="drawer-dep-add"
          className="input"
          value=""
          disabled={!!busy || candidates.length === 0}
          onChange={(e) => e.target.value && void setDependsOn([...ticket.dependsOn, e.target.value])}
        >
          <option value="">{candidates.length === 0 ? 'No tickets to add' : 'Add a dependency…'}</option>
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

      <label className="drawer-label" htmlFor="drawer-status">
        Column
      </label>
      <div id="drawer-status" className="segmented segmented-wrap" role="radiogroup" aria-label="Column">
        {COLUMNS.map((c) => (
          <button
            key={c.status}
            type="button"
            role="radio"
            aria-checked={ticket.status === c.status}
            className={ticket.status === c.status ? 'active' : ''}
            onClick={() => move(c.status)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </>
  );
}

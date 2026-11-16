import type { AgentPersona, Run, Ticket, TicketStatus } from '@emberline/protocol';
import { Check } from 'lucide-react';
import { type DragEvent, type FormEvent, useState } from 'react';
import { api, errorMessage } from '../api';
import { issueHref } from '../issueImport';
import {
  overlapWaitingFor,
  overlapWaitingLabel,
  overlapWaitingTitle,
  waitingLabel,
  waitingTitle,
} from '../ticketDeps';
import { PERSONA_LIST, PersonaBadge } from './PersonaBadge';
import { RunStatePill } from './RunStatePill';
import './board/board-ux.css';

export const BOARD_COLUMNS: { status: TicketStatus; label: string; hint: string }[] = [
  { status: 'backlog', label: 'Backlog', hint: 'Ideas and not-yet-ready work' },
  { status: 'ready', label: 'Ready', hint: 'Specified and ready to hand to an agent' },
  {
    status: 'in_progress',
    label: 'In progress',
    hint: 'Drop here to dispatch agent (or monitor active run)',
  },
  { status: 'review', label: 'Review', hint: 'Agent finished its turn; review or send a follow-up' },
  { status: 'done', label: 'Done', hint: 'Accepted; runs never move tickets out of here' },
];

export const BOARD_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;

function conflictCardLabel(lastEvent: string | null | undefined): string | null {
  if (lastEvent === 'conflict_auto_resolved') return 'auto-resolved';
  if (lastEvent === 'conflict_resolver_started') return 'resolving conflicts';
  if (lastEvent === 'conflict_heal_failed') return 'conflict';
  return null;
}

export function QuickAdd({
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
        className="input quick-add-persona"
        aria-label="Ticket persona"
        value={persona}
        onChange={(e) => setPersona(e.target.value as AgentPersona)}
      >
        {PERSONA_LIST.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
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

/** The issue a ticket was imported from: `#123` linking to it, its labels, whether it is closed or needs triage. */
export function IssueChips({ external }: { external: Ticket['external'] }) {
  if (!external) return null;
  const href = issueHref(external.url);
  return (
    <div className="card-issue">
      {href ? (
        <a
          className="badge badge-soft mono issue-chip"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          #{external.number}
        </a>
      ) : (
        <span className="badge badge-soft mono">#{external.number}</span>
      )}
      {external.triage && <span className="badge badge-warn">needs triage</span>}
      {external.state === 'closed' && <span className="badge badge-soft">closed</span>}
      {external.labels.map((l) => (
        <span key={l} className="badge badge-soft card-issue-label">
          {l}
        </span>
      ))}
    </div>
  );
}

/** Selection mode: a click (shift-click for a range) or Enter/Space picks the card instead of opening it. */
export interface CardSelection {
  selected: boolean;
  onToggle: (range: boolean) => void;
}

export function TicketCard({
  ticket,
  run,
  dragging,
  dropBefore,
  selection,
  onOpen,
  onDragStart,
  onDragOver,
}: {
  ticket: Ticket;
  run: Run | undefined;
  dragging: boolean;
  dropBefore: boolean;
  selection?: CardSelection;
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const live = run && !run.endedAt;
  const overlapWait = overlapWaitingFor(ticket);
  const conflictNote = conflictCardLabel(run?.lastEvent);
  const activate = (range: boolean) => (selection ? selection.onToggle(range) : onOpen());
  return (
    <>
      {dropBefore && <li className="drop-marker" aria-hidden="true" />}
      <li
        id={`ticket-${ticket.key}`}
        className={`card prio-${ticket.priority}${dragging ? ' dragging' : ''}${live ? ` card-live card-${run.state}` : ''}${selection ? ' card-selectable' : ''}${selection?.selected ? ' card-selected' : ''}`}
        draggable={!selection}
        tabIndex={0}
        role={selection ? 'checkbox' : undefined}
        aria-checked={selection ? selection.selected : undefined}
        aria-label={`${ticket.key} ${ticket.title}`}
        onClick={(e) => activate(e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate(e.shiftKey);
          }
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
      >
        <div className="card-top">
          {selection && (
            <span className="card-check" aria-hidden="true">
              {selection.selected && <Check className="icon" />}
            </span>
          )}
          <span className="card-key mono">{ticket.key}</span>
          <PersonaBadge persona={ticket.persona} />
          <span className="card-prio mono">
            <span className="prio-dot" aria-hidden="true" />
            {BOARD_PRIORITIES[ticket.priority]}
          </span>
        </div>
        <p className="card-title">{ticket.title}</p>
        <IssueChips external={ticket.external} />
        {waitingLabel(ticket.blockedBy) && (
          <span className="card-waiting mono" title={waitingTitle(ticket.blockedBy)}>
            {waitingLabel(ticket.blockedBy)}
          </span>
        )}
        {overlapWait && (
          <span
            className="card-waiting card-overlap-wait mono"
            tabIndex={0}
            title={overlapWaitingTitle(overlapWait)}
            aria-label={overlapWaitingTitle(overlapWait).replace(/\n/g, ', ')}
          >
            {overlapWaitingLabel(overlapWait)}
          </span>
        )}
        {run && (
          <div className="card-foot">
            <RunStatePill
              state={run.state}
              cancelled={run.cancelled}
              autoRetry={run.autoRetry}
              handedOffTo={run.handedOffTo}
            />
            {conflictNote && <span className="card-conflict-note mono">{conflictNote}</span>}
          </div>
        )}
      </li>
    </>
  );
}

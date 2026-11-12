import type { AgentPersona, Ticket, TicketStatus, Run } from '@emberline/protocol';
import { Coins, Wrench } from 'lucide-react';
import { type DragEvent, type FormEvent, useState } from 'react';
import { api, errorMessage } from '../api';
import { issueHref } from '../issueImport';
import { waitingLabel, waitingTitle } from '../ticketDeps';
import { timeAgo } from '../time';
import { PERSONA_LIST, PersonaBadge } from './PersonaBadge';
import { RunStatePill } from './RunStatePill';

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
          title="Open the issue"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          #{external.number}
        </a>
      ) : (
        <span className="badge badge-soft mono">#{external.number}</span>
      )}
      {external.triage && (
        <span
          className="badge badge-warn"
          title="Label sync imported this from an author who is not in Trusted authors. Automatic dispatch skips it until you move or edit it."
        >
          needs triage
        </span>
      )}
      {external.state === 'closed' && <span className="badge badge-soft">closed</span>}
      {external.labels.map((l) => (
        <span key={l} className="badge badge-soft card-issue-label">
          {l}
        </span>
      ))}
    </div>
  );
}

export function TicketCard({
  ticket,
  run,
  dragging,
  dropBefore,
  onOpen,
  onDragStart,
  onDragOver,
}: {
  ticket: Ticket;
  run: Run | undefined;
  dragging: boolean;
  dropBefore: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const live = run && !run.endedAt;
  const shortBranch = run?.branch?.replace(/^emberline\//, '');
  return (
    <>
      {dropBefore && <li className="drop-marker" aria-hidden="true" />}
      <li
        id={`ticket-${ticket.key}`}
        className={`card prio-${ticket.priority}${dragging ? ' dragging' : ''}${live ? ` card-live card-${run.state}` : ''}`}
        draggable
        tabIndex={0}
        aria-label={`${ticket.key} ${ticket.title}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
      >
        <div className="card-top">
          <span className="card-key mono">{ticket.key}</span>
          <PersonaBadge persona={ticket.persona} />
          {shortBranch && <span className="card-branch mono">{shortBranch}</span>}
          <span className="prio-dot" title={`${BOARD_PRIORITIES[ticket.priority]} priority`} />
        </div>
        <p className="card-title">{ticket.title}</p>
        <IssueChips external={ticket.external} />
        {waitingLabel(ticket.blockedBy) && (
          <span className="card-waiting mono" title={waitingTitle(ticket.blockedBy)}>
            {waitingLabel(ticket.blockedBy)}
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
            {run.telemetry && run.telemetry.totalTokens > 0 && (
              <span
                className="card-event mono"
                style={{ fontVariantNumeric: 'tabular-nums' }}
                title={`Input: ${run.telemetry.inputTokens.toLocaleString()} tok · Output: ${run.telemetry.outputTokens.toLocaleString()} tok · Tools: ${run.telemetry.toolCalls}`}
              >
                <Coins className="icon" aria-hidden /> {(run.telemetry.totalTokens / 1000).toFixed(1)}k
                {run.telemetry.toolCalls > 0 ? (
                  <>
                    {' · '}
                    <Wrench className="icon" aria-hidden />
                    {run.telemetry.toolCalls}
                  </>
                ) : (
                  ''
                )}
              </span>
            )}
            {run.lastEvent && <span className="card-event mono">{run.lastEvent}</span>}
            <span className="card-meta mono">{timeAgo(run.stateChangedAt)}</span>
          </div>
        )}
      </li>
    </>
  );
}

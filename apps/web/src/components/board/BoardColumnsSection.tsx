import type { Run, Ticket } from '@emberline/protocol';
import { Coins, Wrench } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { blockingMessage } from '../../reviewComments';
import { waitingLabel, waitingTitle } from '../../ticketDeps';
import { timeAgo } from '../../time';
import { PersonaBadge } from '../PersonaBadge';
import { RunStatePill } from '../RunStatePill';
import { ico, SectionState } from '../SectionState';
import { type BoardCtx, COLUMNS, type DropTarget, IssueChips, PRIORITIES } from './boardMeta';

function TicketCard({
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
          <span className="prio-dot" title={`${PRIORITIES[ticket.priority]} priority`} />
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
                {ico(Coins)} {(run.telemetry.totalTokens / 1000).toFixed(1)}k
                {run.telemetry.toolCalls > 0 ? (
                  <>
                    {' · '}
                    {ico(Wrench)}
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

export function BoardColumnsSection({
  ctx,
  loading,
  loadError,
  onRetry,
}: {
  ctx: BoardCtx;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => Promise<void>;
}) {
  const { tickets, cols, runs, auto, err, blocked, missing, clrBlocked, clrMissing, move, open } = ctx;
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<DropTarget>();

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const ticket = tickets?.find((t) => t.id === dragId);
    if (ticket && drop) void move(ticket, drop);
    setDragId(undefined);
    setDrop(undefined);
  };

  return (
    <>
      {err && (
        <div className="banner banner-error" role="alert">
          {err}
        </div>
      )}
      {blocked && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            {blockingMessage(blocked.count)} on {blocked.ticket.key}. It was not moved to Done.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void move(blocked.ticket, blocked.target, { force: true })}
          >
            Merge anyway
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clrBlocked}>
            Cancel
          </button>
        </div>
      )}
      {missing && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            The worktree of {missing.ticket.key}&apos;s run is gone and its work isn&apos;t in main. Nothing
            was merged.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void move(missing.ticket, missing.target, { skipMerge: true })}
          >
            Move to Done without merging
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clrMissing}>
            Cancel
          </button>
        </div>
      )}

      {tickets === undefined ? (
        <SectionState
          loading={loading}
          error={loadError}
          onRetry={onRetry}
          loadingText="Loading board tickets…"
          emptyText="No tickets loaded yet."
          errorPrefix="Could not load tickets"
          ariaLabel="Board columns"
        />
      ) : (
        <div
          className="board"
          onDragEnd={() => {
            setDragId(undefined);
            setDrop(undefined);
          }}
        >
          {COLUMNS.map((col) => {
            const list = cols.get(col.status) ?? [];
            const isTarget = drop?.status === col.status;
            return (
              <section
                key={col.status}
                id={`col-${col.status}`}
                className={`board-col board-col-${col.status}${isTarget ? ' drop-target' : ''}`}
                aria-label={col.label}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  if (
                    e.target === e.currentTarget ||
                    (e.target as HTMLElement).classList.contains('board-cards')
                  ) {
                    setDrop({ status: col.status, beforeId: null });
                  }
                }}
                onDrop={onDrop}
              >
                <header className="board-col-head" title={col.hint}>
                  <span className="board-col-dot" aria-hidden="true" />
                  <h2>{col.label}</h2>
                  {col.status === 'in_progress' && auto && (
                    <span className="badge mono" title="Drop a card here to auto-start Claude">
                      auto
                    </span>
                  )}
                  <span className="board-count">{list.length}</span>
                </header>
                <ol className="board-cards">
                  {list.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      run={runs.get(ticket.id)}
                      dragging={dragId === ticket.id}
                      dropBefore={drop?.beforeId === ticket.id && dragId !== ticket.id}
                      onOpen={() => open(ticket.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', ticket.key);
                        setDragId(ticket.id);
                      }}
                      onDragOver={(e) => {
                        if (!dragId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        const beforeId = after ? (list[list.indexOf(ticket) + 1]?.id ?? null) : ticket.id;
                        setDrop({ status: col.status, beforeId });
                      }}
                    />
                  ))}
                  {isTarget && drop?.beforeId === null && <li className="drop-marker" aria-hidden="true" />}
                </ol>
                {list.length === 0 && !isTarget && <p className="board-empty">{col.hint}</p>}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

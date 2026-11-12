import { type DragEvent, useState } from 'react';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import { blockingMessage } from '../../reviewComments';
import { BoardBulkBar } from '../BoardBulkBar';
import { BOARD_COLUMNS, TicketCard } from '../BoardCard';
import { BoardFilterBar, MobileColumnNav } from '../BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../ErrorBoundary';
import { SyncResolutionBanner } from '../HoldRecovery';
import type { BoardCtx, DropTarget } from './boardMeta';

export function BoardColumnsSection({
  ctx,
  loading,
  loadError,
  onRetry,
  projectError,
  onRetryProject,
}: {
  ctx: BoardCtx;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void | Promise<void>;
  projectError?: unknown;
  onRetryProject?: () => void | Promise<void>;
}) {
  const {
    projectId,
    project,
    tickets,
    allColumns,
    visibleColumns,
    columnCounts,
    latestRun,
    autoStart,
    bulkSelection,
    onBulkApplied,
    filter,
    filterActive,
    filteredCount,
    updateFilter,
    error,
    blockedDrop,
    missingDrop,
    resolvingNotice,
    clearBlockedDrop,
    clearMissingDrop,
    clearResolvingNotice,
    moveTicket,
    openTicket,
  } = ctx;
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<DropTarget>();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const ticket = tickets?.find((t) => t.id === dragId);
    const target = drop;
    setDragId(undefined);
    setDrop(undefined);
    if (ticket && target) void moveTicket(ticket, target);
  };

  return (
    <>
      {Boolean(projectError && !project) && (
        <ViewErrorBanner
          label="Could not load project details"
          error={projectError}
          onRetry={onRetryProject}
        />
      )}
      {Boolean(loadError) && (
        <ViewErrorBanner label="Could not load board tickets" error={loadError} onRetry={onRetry} />
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {resolvingNotice && <SyncResolutionBanner notice={resolvingNotice} onDismiss={clearResolvingNotice} />}
      {blockedDrop && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            {blockingMessage(blockedDrop.count)} on {blockedDrop.ticket.key}. It was not moved to Done.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void moveTicket(blockedDrop.ticket, blockedDrop.target, { force: true })}
          >
            Merge anyway
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clearBlockedDrop}>
            Cancel
          </button>
        </div>
      )}
      {missingDrop && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            The worktree of {missingDrop.ticket.key}&apos;s run is gone and its work isn&apos;t in main.
            Nothing was merged.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void moveTicket(missingDrop.ticket, missingDrop.target, { skipMerge: true })}
          >
            Move to Done without merging
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clearMissingDrop}>
            Cancel
          </button>
        </div>
      )}

      {((tickets?.length ?? 0) > 0 || filterActive) && (
        <BoardFilterBar
          tickets={tickets ?? []}
          latestRunByTicket={latestRun}
          filter={filter}
          shown={filteredCount}
          onChange={updateFilter}
        />
      )}

      {bulkSelection.active && (
        <BoardBulkBar
          projectId={projectId}
          columns={BOARD_COLUMNS}
          selection={bulkSelection.selection}
          onApplied={onBulkApplied}
          onExit={() => bulkSelection.setActive(false)}
        />
      )}

      {loading && !tickets ? (
        <ViewLoadingState label="Loading project tickets…" />
      ) : !tickets && !loadError ? (
        <div className="empty">
          <p>No tickets available for this project yet.</p>
        </div>
      ) : (
        <>
          <MobileColumnNav columns={BOARD_COLUMNS} counts={columnCounts} />
          {filterActive && filteredCount === 0 && (tickets?.length ?? 0) > 0 && (
            <div className="empty board-filter-empty">
              <p>No tickets match the current search or filters.</p>
              <button type="button" className="btn btn-sm" onClick={() => updateFilter(EMPTY_BOARD_FILTER)}>
                Clear filters
              </button>
            </div>
          )}
          <div
            className="board"
            onDragEnd={() => {
              setDragId(undefined);
              setDrop(undefined);
            }}
          >
            {BOARD_COLUMNS.map((col) => {
              const list = visibleColumns.get(col.status) ?? [];
              const totalInCol = (allColumns.get(col.status) ?? []).length;
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
                    {col.status === 'in_progress' && autoStart && (
                      <span className="badge mono" title="Drop a card here to auto-start Claude">
                        auto
                      </span>
                    )}
                    {bulkSelection.active && list.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost board-col-select"
                        aria-label={`${bulkSelection.columnSelected(list.map((t) => t.id)) ? 'Unselect' : 'Select'} every shown ticket in ${col.label}`}
                        onClick={() => bulkSelection.toggleColumn(list.map((t) => t.id))}
                      >
                        {bulkSelection.columnSelected(list.map((t) => t.id)) ? 'None' : 'All'}
                      </button>
                    )}
                    <span className="board-count mono">
                      {filterActive && list.length !== totalInCol
                        ? `${list.length}/${totalInCol}`
                        : list.length}
                    </span>
                  </header>
                  <ol className="board-cards">
                    {list.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        run={latestRun.get(ticket.id)}
                        dragging={dragId === ticket.id}
                        dropBefore={drop?.beforeId === ticket.id && dragId !== ticket.id}
                        selection={
                          bulkSelection.active
                            ? {
                                selected: bulkSelection.isSelected(ticket.id),
                                onToggle: (range) => bulkSelection.toggle(ticket.id, range),
                              }
                            : undefined
                        }
                        onOpen={() => openTicket(ticket.id)}
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
                  {list.length === 0 && !isTarget && (
                    <p className="board-empty">
                      {filterActive && totalInCol > 0 ? 'No matching tickets' : col.hint}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

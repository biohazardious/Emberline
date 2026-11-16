import { Eraser, Package } from 'lucide-react';
import { Link } from 'wouter';
import type { FleetFilter } from './FleetToolbar';

export function FleetEmptyState({
  searchQuery,
  filter,
  completedCount,
  gcBusy,
  onClearSearch,
  onViewHistory,
  onGarbageCollect,
}: {
  searchQuery: string;
  filter: FleetFilter;
  completedCount: number;
  gcBusy: boolean;
  onClearSearch: () => void;
  onViewHistory: () => void;
  onGarbageCollect: () => void;
}) {
  const hasSearch = searchQuery.trim() !== '';

  return (
    <div className="empty fleet-empty">
      <p>
        {hasSearch
          ? 'No agent sessions match your search.'
          : filter === 'active' && completedCount > 0
            ? `No live agent sessions running right now (${completedCount} finished session${completedCount === 1 ? '' : 's'} archived in History).`
            : 'No agent sessions match the selected filter.'}
      </p>
      <p className="muted small fleet-empty-actions">
        {hasSearch ? (
          <button type="button" className="btn btn-sm" onClick={onClearSearch}>
            Clear search
          </button>
        ) : (
          <>
            <span>
              Start a ticket from a project board or launch a run from the <Link href="/">Overview</Link>.
            </span>
            {filter === 'active' && completedCount > 0 && (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onViewHistory}>
                  <Package className="icon" aria-hidden /> View history ({completedCount})
                </button>
                <button type="button" className="btn btn-sm" disabled={gcBusy} onClick={onGarbageCollect}>
                  <Eraser className="icon" aria-hidden /> Clean up finished
                </button>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

import { Circle, Eraser, Monitor, Package, Square, Terminal } from 'lucide-react';
import type { FormEvent } from 'react';
import { AllProjectsToggle } from '../AllProjectsToggle';
import { SearchInput } from '../BoardFilterBar';
import { HelpHint } from '../ui/HelpHint';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';
import { PageHeader } from '../ui/PageHeader';

export type FleetFilter = 'active' | 'queued' | 'completed' | 'all';
export type GridLayout = 'grid' | 'cols' | 'single';
export type FleetViewMode = 'live' | 'thumbnails';

export interface FleetCounts {
  active: number;
  queued: number;
  completed: number;
  total: number;
}

export interface FleetToolbarProps {
  counts: FleetCounts;
  filter: FleetFilter;
  onChangeFilter: (next: FleetFilter) => void;
  layout: GridLayout;
  onChangeLayout: (next: GridLayout) => void;
  view: FleetViewMode;
  onChangeView: (next: FleetViewMode) => void;
  searchQuery: string;
  onChangeSearchQuery: (next: string) => void;
  showSearch: boolean;
  activeProjectId?: string | null;
  all: boolean;
  onChangeAll: (next: boolean) => void;
  bulkTitles: { stopAll: string; cleanUp: string };
  gcBusy: boolean;
  stoppingAll: boolean;
  onGarbageCollect: (keepRecent?: number) => void;
  onStopAllActive: () => void;
  selectedCount: number;
  bulkPrompt: string;
  onChangeBulkPrompt: (next: string) => void;
  bulkBusy: boolean;
  onSubmitBulkPrompt: (e: FormEvent) => void;
  onClearSelection: () => void;
}

export function FleetToolbar({
  counts,
  filter,
  onChangeFilter,
  layout,
  onChangeLayout,
  view,
  onChangeView,
  searchQuery,
  onChangeSearchQuery,
  showSearch,
  activeProjectId,
  all,
  onChangeAll,
  bulkTitles,
  gcBusy,
  stoppingAll,
  onGarbageCollect,
  onStopAllActive,
  selectedCount,
  bulkPrompt,
  onChangeBulkPrompt,
  bulkBusy,
  onSubmitBulkPrompt,
  onClearSelection,
}: FleetToolbarProps) {
  const moreItems: MoreMenuItem[] = [
    {
      id: 'fleet-view-toggle',
      label: view === 'live' ? 'Show thumbnails' : 'Show live',
      description: view === 'live' ? 'Text snapshots only' : 'Attach live terminals in view',
      icon: <Monitor className="icon" aria-hidden />,
      onSelect: () => onChangeView(view === 'live' ? 'thumbnails' : 'live'),
    },
    {
      id: 'fleet-gc-btn',
      label: gcBusy ? 'Cleaning…' : 'Clean up finished',
      description: bulkTitles.cleanUp,
      icon: <Eraser className="icon" aria-hidden />,
      disabled: gcBusy || counts.completed === 0,
      onSelect: () => onGarbageCollect(0),
    },
    {
      id: 'fleet-stop-all',
      label: stoppingAll ? 'Stopping…' : 'Stop all',
      description: bulkTitles.stopAll,
      icon: <Square className="icon" aria-hidden />,
      danger: true,
      disabled: stoppingAll || counts.active === 0,
      onSelect: onStopAllActive,
    },
  ];

  return (
    <>
      <PageHeader
        title="Fleet"
        icon={<Terminal className="icon" aria-hidden />}
        meta={
          <>
            <span className="badge mono fleet-count-badge">{counts.active}</span>
            <HelpHint topic="fleet">
              Supervise live agent sessions. Finished terminals close automatically while keeping recent
              history.
            </HelpHint>
          </>
        }
        actions={
          <div className="fleet-toolbar-controls">
            {showSearch && (
              <SearchInput
                id="fleet-search"
                className="fleet-search"
                ariaLabel="Filter fleet panes"
                placeholder="Filter panes by ticket, branch, provider…"
                value={searchQuery}
                onChange={onChangeSearchQuery}
              />
            )}

            <div className="segmented segmented-scroll" role="tablist" aria-label="Fleet filter">
              <button
                id="fleet-filter-active"
                type="button"
                role="tab"
                aria-selected={filter === 'active'}
                className={filter === 'active' ? 'active' : ''}
                onClick={() => onChangeFilter('active')}
              >
                <Circle className="icon fleet-live-dot" aria-hidden fill="currentColor" /> Live (
                {counts.active})
              </button>
              <button
                id="fleet-filter-queued"
                type="button"
                role="tab"
                aria-selected={filter === 'queued'}
                className={filter === 'queued' ? 'active' : ''}
                onClick={() => onChangeFilter('queued')}
              >
                Queued ({counts.queued})
              </button>
              <button
                id="fleet-filter-completed"
                type="button"
                role="tab"
                aria-selected={filter === 'completed'}
                className={filter === 'completed' ? 'active' : ''}
                onClick={() => onChangeFilter('completed')}
              >
                <Package className="icon" aria-hidden /> History ({counts.completed})
              </button>
              <button
                id="fleet-filter-all"
                type="button"
                role="tab"
                aria-selected={filter === 'all'}
                className={filter === 'all' ? 'active' : ''}
                onClick={() => onChangeFilter('all')}
              >
                All ({counts.total})
              </button>
            </div>

            <div className="segmented hide-sm" role="radiogroup" aria-label="Grid layout">
              <button
                type="button"
                role="radio"
                aria-checked={layout === 'grid'}
                className={layout === 'grid' ? 'active' : ''}
                onClick={() => onChangeLayout('grid')}
              >
                2×2
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={layout === 'cols'}
                className={layout === 'cols' ? 'active' : ''}
                onClick={() => onChangeLayout('cols')}
              >
                2×1
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={layout === 'single'}
                className={layout === 'single' ? 'active' : ''}
                onClick={() => onChangeLayout('single')}
              >
                1×1
              </button>
            </div>

            {activeProjectId && <AllProjectsToggle on={all} onChange={onChangeAll} />}

            <MoreMenu items={moreItems} ariaLabel="Fleet actions" />
          </div>
        }
      />

      {selectedCount > 0 && (
        <form className="fleet-bulk-bar" onSubmit={onSubmitBulkPrompt}>
          <span className="mono">{selectedCount} selected</span>
          <input
            type="text"
            className="input"
            value={bulkPrompt}
            onChange={(e) => onChangeBulkPrompt(e.target.value)}
            placeholder="Prompt to send to every selected agent…"
            aria-label="Prompt for the selected agents"
          />
          <button
            type="submit"
            className={`btn btn-sm${!activeProjectId || !all ? ' btn-primary' : ''}`}
            disabled={bulkBusy || !bulkPrompt.trim()}
          >
            {bulkBusy ? 'Sending…' : 'Send'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearSelection}>
            Clear
          </button>
        </form>
      )}
    </>
  );
}

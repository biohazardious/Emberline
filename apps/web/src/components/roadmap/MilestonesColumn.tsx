import type {
  AgentId,
  AgentModelId,
  RoadmapCategory,
  RoadmapItem,
  RoadmapItemStatus,
  RoadmapMilestone,
} from '@emberline/protocol';
import { ChevronRight, Rocket, SquareKanban, X } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';
import { Link } from 'wouter';
import {
  EMPTY_ROADMAP_FILTER,
  ROADMAP_CATEGORIES,
  ROADMAP_STATUSES,
  type RoadmapFilter,
  toggled,
} from '../../roadmapFilter';
import { SearchInput } from '../BoardFilterBar';
import { PersonaBadge } from '../PersonaBadge';
import { SectionState } from '../SectionState';
import {
  CATEGORY_META,
  ROADMAP_STATUS_LABEL,
  RoadmapPriorityBadge,
  RoadmapStateBadge,
  RouteBadgeSelect,
} from './RoadmapBadges';
import './roadmap-ux.css';

export function MilestonesColumn({
  projectId,
  totalMilestoneCount,
  filteredRoadmap,
  loading,
  loadError,
  onRetry,
  itemFilter,
  onItemFilterChange,
  filterActive,
  statusCounts,
  categoryCounts,
  selectedItems,
  onToggleItem,
  onToggleItemDone,
  onDeleteItem,
  onDispatchSingleItem,
  onDispatchMilestone,
  onDeleteMilestone,
  inlineMsInputs,
  onInlineMsInputChange,
  onInlineMilestoneAdd,
  enabledProviders,
  onChangeRoute,
  busy,
}: {
  projectId: string;
  totalMilestoneCount: number;
  filteredRoadmap: {
    milestones: Array<{ milestone: RoadmapMilestone; items: RoadmapItem[] }>;
    shown: number;
    total: number;
  };
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void | Promise<void>;
  itemFilter: RoadmapFilter;
  onItemFilterChange: (updater: (prev: RoadmapFilter) => RoadmapFilter) => void;
  filterActive: boolean;
  statusCounts: Record<RoadmapItemStatus, number>;
  categoryCounts: Record<RoadmapCategory, number>;
  selectedItems: ReadonlySet<string>;
  onToggleItem: (id: string) => void;
  onToggleItemDone: (item: RoadmapItem) => void;
  onDeleteItem: (itemId: string) => void;
  onDispatchSingleItem: (itemId: string) => void;
  onDispatchMilestone: (msId: string, msCode: string, undispatchedIds: string[]) => void;
  onDeleteMilestone: (msId: string, msCode: string) => void;
  inlineMsInputs: Record<string, string>;
  onInlineMsInputChange: (msId: string, text: string) => void;
  onInlineMilestoneAdd: (msId: string, msCode: string) => void;
  enabledProviders: AgentId[];
  onChangeRoute: (id: string, agent: AgentId, model: AgentModelId) => void;
  busy: string | null;
}) {
  const [collapsedMilestones, setCollapsedMilestones] = useState<Set<string>>(() => new Set());

  if (loading || loadError !== undefined) {
    return (
      <SectionState
        loading={loading}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading project milestones…"
        errorPrefix="Could not load project milestones"
      />
    );
  }

  const toggleMilestone = (msId: string) => {
    setCollapsedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(msId)) next.delete(msId);
      else next.add(msId);
      return next;
    });
  };

  const handleMilestoneKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, msId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleMilestone(msId);
    }
  };

  return (
    <section className="panel roadmap-column">
      <header className="panel-head roadmap-column-head">
        <h2 className="roadmap-column-title">Milestones</h2>
        <span className="badge mono roadmap-count-badge">{`${totalMilestoneCount} milestones`}</span>
      </header>

      <div className="roadmap-filter" aria-label="Filter roadmap items">
        <div className="roadmap-filter-row">
          <SearchInput
            className="roadmap-search"
            ariaLabel="Search roadmap items"
            placeholder="Search items, ticket keys or milestones…"
            value={itemFilter.query}
            onChange={(query) => onItemFilterChange((f) => ({ ...f, query }))}
          />
          {filterActive && (
            <>
              <span className="muted mono roadmap-filter-count">
                {`${filteredRoadmap.shown} of ${filteredRoadmap.total} items`}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onItemFilterChange(() => EMPTY_ROADMAP_FILTER)}
              >
                <X className="icon" aria-hidden="true" /> Clear filter
              </button>
            </>
          )}
        </div>
        <div className="roadmap-filter-row" role="group" aria-label="Status">
          {ROADMAP_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip-btn${itemFilter.statuses.includes(status) ? ' chip-on' : ''}`}
              aria-pressed={itemFilter.statuses.includes(status)}
              onClick={() => onItemFilterChange((f) => ({ ...f, statuses: toggled(f.statuses, status) }))}
            >
              {`${ROADMAP_STATUS_LABEL[status]} ${statusCounts[status]}`}
            </button>
          ))}
          <span className="roadmap-filter-sep" aria-hidden="true" />
          {ROADMAP_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={`chip-btn${itemFilter.categories.includes(category) ? ' chip-on' : ''}`}
              aria-pressed={itemFilter.categories.includes(category)}
              onClick={() =>
                onItemFilterChange((f) => ({ ...f, categories: toggled(f.categories, category) }))
              }
            >
              {`${CATEGORY_META[category].label} ${categoryCounts[category]}`}
            </button>
          ))}
        </div>
      </div>

      <div className="roadmap-milestone-list">
        {filteredRoadmap.milestones.length === 0 && (
          <p className="muted roadmap-empty-text">
            {filterActive ? 'No roadmap milestones match the filter.' : 'No milestones defined yet.'}
          </p>
        )}
        {filteredRoadmap.milestones.map(({ milestone: ms, items: shownItems }) => {
          const doneCount = ms.items.filter((i) => i.status === 'done').length;
          const pct = ms.items.length > 0 ? Math.round((doneCount / ms.items.length) * 100) : 0;
          const undispatchedIds = ms.items.filter((i) => i.status !== 'done').map((i) => i.id);
          const isCollapsed = collapsedMilestones.has(ms.id);
          const bodyId = `milestone-body-${ms.id}`;

          return (
            <div key={ms.id} className="roadmap-milestone-group">
              <div className="roadmap-milestone-head">
                <button
                  type="button"
                  className="roadmap-milestone-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={bodyId}
                  onClick={() => toggleMilestone(ms.id)}
                  onKeyDown={(e) => handleMilestoneKeyDown(e, ms.id)}
                >
                  <ChevronRight
                    className={`icon roadmap-milestone-chevron${!isCollapsed ? ' is-open' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="badge mono roadmap-milestone-code">{ms.code}</span>
                  <span className="roadmap-milestone-title">{ms.title}</span>
                  <span className="muted mono roadmap-milestone-progress">
                    {`${doneCount}/${ms.items.length} (${pct}%)`}
                  </span>
                </button>

                <div className="roadmap-milestone-actions">
                  {undispatchedIds.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={() => onDispatchMilestone(ms.id, ms.code, undispatchedIds)}
                    >
                      {busy === `ms-${ms.id}` ? (
                        'Starting…'
                      ) : (
                        <>
                          <Rocket className="icon" aria-hidden="true" /> {`Run ${ms.code}`}
                        </>
                      )}
                    </button>
                  )}
                  {totalMilestoneCount > 1 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null}
                      aria-label={`Delete milestone ${ms.code}`}
                      onClick={() => onDeleteMilestone(ms.id, ms.code)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <progress
                className={`roadmap-progress roadmap-milestone-bar${pct === 100 ? ' is-done' : ''}`}
                max={100}
                value={pct}
                aria-label={`${ms.code} progress`}
              />

              {!isCollapsed && (
                <div id={bodyId} className="roadmap-milestone-body">
                  {ms.description && <p className="muted roadmap-milestone-desc">{ms.description}</p>}

                  {ms.items.length > 0 && shownItems.length === 0 ? (
                    <p className="muted roadmap-empty-text">{`No items in ${ms.code} match the filter.`}</p>
                  ) : ms.items.length === 0 ? (
                    <p className="muted roadmap-empty-text">
                      {`No items in ${ms.code} yet. Generate a roadmap above or add an item below.`}
                    </p>
                  ) : (
                    <ul className="roadmap-item-list">
                      {shownItems.map((item) => {
                        const isDone = item.status === 'done';
                        const isChecked = selectedItems.has(item.id);
                        return (
                          <li
                            key={item.id}
                            className={`roadmap-item-row${isDone ? ' is-done' : ''}${
                              isChecked ? ' is-selected' : ''
                            }`}
                          >
                            <div className="roadmap-item-main">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                aria-label={`Select ${item.title}`}
                                onChange={() => onToggleItem(item.id)}
                              />
                              <span className={`roadmap-item-title${isDone ? ' is-done' : ''}`}>
                                {item.title}
                              </span>
                            </div>

                            <div className="roadmap-item-meta">
                              <RoadmapStateBadge status={item.status} />
                              <RoadmapPriorityBadge priority={item.priority} />
                              <PersonaBadge persona={item.persona} />
                              <RouteBadgeSelect
                                agent={item.preferredAgent}
                                model={item.preferredModel}
                                persona={item.persona}
                                enabledProviders={enabledProviders}
                                disabled={busy !== null}
                                onChange={(nextAgent, nextModel) =>
                                  onChangeRoute(item.id, nextAgent, nextModel)
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => onToggleItemDone(item)}
                              >
                                {isDone ? 'Reopen' : 'Mark done'}
                              </button>
                              {item.ticketKey ? (
                                <Link
                                  href={`/projects/${projectId}/board`}
                                  className="badge mono roadmap-ticket-link"
                                >
                                  <SquareKanban className="icon" aria-hidden="true" /> {item.ticketKey}
                                </Link>
                              ) : (
                                !isDone && (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={busy !== null}
                                    onClick={() => onDispatchSingleItem(item.id)}
                                  >
                                    {busy === `item-${item.id}` ? 'Starting…' : 'Dispatch'}
                                  </button>
                                )
                              )}
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                aria-label={`Delete ${item.title}`}
                                onClick={() => onDeleteItem(item.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <div className="roadmap-inline-add">
                    <input
                      className="input roadmap-inline-input"
                      placeholder={`Add item to ${ms.code}…`}
                      value={inlineMsInputs[ms.id] ?? ''}
                      onChange={(e) => onInlineMsInputChange(ms.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onInlineMilestoneAdd(ms.id, ms.code);
                        }
                      }}
                    />
                    {(inlineMsInputs[ms.id] ?? '').trim() && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() => onInlineMilestoneAdd(ms.id, ms.code)}
                      >
                        Add item
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

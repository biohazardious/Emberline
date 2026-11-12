import type {
  AgentId,
  AgentModelId,
  RoadmapCategory,
  RoadmapItem,
  RoadmapItemStatus,
  RoadmapMilestone,
} from '@emberline/protocol';
import { Map as MapIcon, Rocket, Sparkles, SquareKanban, X } from 'lucide-react';
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
import { CATEGORY_META, ROADMAP_STATUS_LABEL, ROADMAP_STATUS_MARK, RouteBadgeSelect } from './RoadmapBadges';

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
  return (
    <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>
            <MapIcon className="icon" aria-hidden /> Project Milestones &amp; Roadmap
          </h2>
          <p className="muted">
            Track milestone delivery, check off completed items, or dispatch any roadmap item to the Kanban
            board.
          </p>
        </div>
        <span className="badge mono">{totalMilestoneCount} milestones</span>
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
              <span className="muted small mono">
                {filteredRoadmap.shown} of {filteredRoadmap.total} items
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onItemFilterChange(() => EMPTY_ROADMAP_FILTER)}
              >
                <X className="icon" aria-hidden /> Clear
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
              {ROADMAP_STATUS_LABEL[status]} {statusCounts[status]}
            </button>
          ))}
          <span className="roadmap-filter-sep" aria-hidden />
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
              {CATEGORY_META[category].label} {categoryCounts[category]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filteredRoadmap.milestones.length === 0 && (
          <p className="muted small" style={{ margin: '4px 0' }}>
            {filterActive ? 'No roadmap milestones match the filter.' : 'No milestones defined yet.'}
          </p>
        )}
        {filteredRoadmap.milestones.map(({ milestone: ms, items: shownItems }) => {
          const doneCount = ms.items.filter((i) => i.status === 'done').length;
          const pct = ms.items.length > 0 ? Math.round((doneCount / ms.items.length) * 100) : 0;
          const undispatchedIds = ms.items.filter((i) => i.status !== 'done').map((i) => i.id);

          return (
            <div
              key={ms.id}
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="badge mono" style={{ fontWeight: 700 }}>
                      {ms.code}
                    </span>
                    <strong style={{ fontSize: '0.92rem' }}>{ms.title}</strong>
                    <span className="muted mono" style={{ fontSize: '0.75rem' }}>
                      {doneCount}/{ms.items.length} ({pct}%)
                    </span>
                  </div>
                  {ms.description && (
                    <p className="muted" style={{ margin: '3px 0 0', fontSize: '0.76rem' }}>
                      {ms.description}
                    </p>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {undispatchedIds.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={() => onDispatchMilestone(ms.id, ms.code, undispatchedIds)}
                      title={`Create Kanban tickets for all remaining items in ${ms.code} and start execution`}
                    >
                      {busy === `ms-${ms.id}` ? (
                        'Starting…'
                      ) : (
                        <>
                          <Rocket className="icon" aria-hidden /> Run {ms.code}
                        </>
                      )}
                    </button>
                  )}
                  {totalMilestoneCount > 1 && (
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={busy !== null}
                      onClick={() => onDeleteMilestone(ms.id, ms.code)}
                      title={`Remove milestone ${ms.code}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              <div
                style={{
                  width: '100%',
                  height: 5,
                  borderRadius: 999,
                  background: 'var(--bg)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: pct === 100 ? 'var(--ok)' : 'var(--accent)',
                  }}
                />
              </div>

              {ms.items.length > 0 && shownItems.length === 0 ? (
                <p className="muted small" style={{ margin: '2px 0' }}>
                  No items in {ms.code} match the filter.
                </p>
              ) : ms.items.length === 0 ? (
                <p className="muted small" style={{ margin: '2px 0' }}>
                  No items in {ms.code} yet. Click{' '}
                  <strong>
                    <Sparkles className="icon" aria-hidden /> Auto-Generate Roadmap
                  </strong>{' '}
                  above, promote a brainstorm idea, or type below.
                </p>
              ) : (
                <ul className="list" style={{ margin: 0 }}>
                  {shownItems.map((item) => {
                    const isDone = item.status === 'done';
                    const isChecked = selectedItems.has(item.id);
                    return (
                      <li
                        key={item.id}
                        className="row"
                        style={{
                          padding: '8px 10px',
                          opacity: isDone ? 0.72 : 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flex: 1,
                            minWidth: 200,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => onToggleItem(item.id)}
                            title="Select for batch dispatch"
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost mono"
                            style={{ padding: '2px 6px', fontSize: '0.72rem' }}
                            onClick={() => onToggleItemDone(item)}
                            title={isDone ? 'Mark as planned' : 'Mark as done'}
                          >
                            {ROADMAP_STATUS_MARK[item.status]}{' '}
                            {ROADMAP_STATUS_LABEL[item.status].toUpperCase()}
                          </button>
                          <span
                            style={{
                              fontSize: '0.84rem',
                              fontWeight: 500,
                              textDecoration: isDone ? 'line-through' : 'none',
                            }}
                          >
                            {item.title}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <PersonaBadge persona={item.persona} />
                          <RouteBadgeSelect
                            agent={item.preferredAgent}
                            model={item.preferredModel}
                            persona={item.persona}
                            enabledProviders={enabledProviders}
                            disabled={busy !== null}
                            onChange={(nextAgent, nextModel) => onChangeRoute(item.id, nextAgent, nextModel)}
                          />
                          {item.ticketKey ? (
                            <Link
                              href={`/projects/${projectId}/board`}
                              className="badge mono"
                              style={{ fontSize: '0.7rem', textDecoration: 'none' }}
                              title="View linked ticket on Kanban Board"
                            >
                              <SquareKanban className="icon" aria-hidden /> {item.ticketKey}
                            </Link>
                          ) : (
                            !isDone && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                                disabled={busy !== null}
                                onClick={() => onDispatchSingleItem(item.id)}
                                title="Create Kanban ticket and start specialist agent"
                              >
                                {busy === `item-${item.id}` ? (
                                  '…'
                                ) : (
                                  <>
                                    <Rocket className="icon" aria-hidden /> Dispatch
                                  </>
                                )}
                              </button>
                            )
                          )}
                          <button
                            type="button"
                            className="icon-btn"
                            title="Remove from roadmap"
                            onClick={() => onDeleteItem(item.id)}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                <input
                  className="input"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '5px 8px' }}
                  placeholder={`+ Add task to ${ms.code} and press Enter (auto-routes persona & model)…`}
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
                    style={{ padding: '4px 10px', fontSize: '0.74rem' }}
                    disabled={busy !== null}
                    onClick={() => onInlineMilestoneAdd(ms.id, ms.code)}
                  >
                    Add
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

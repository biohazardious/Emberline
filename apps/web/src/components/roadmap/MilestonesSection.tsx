import { Map as MapIcon, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  countRoadmapCategories,
  countRoadmapStatuses,
  EMPTY_ROADMAP_FILTER,
  filterRoadmap,
  isRoadmapFilterActive,
  parseRoadmapFilter,
  ROADMAP_CATEGORIES,
  ROADMAP_STATUSES,
  type RoadmapFilter,
  toggled,
} from '../../roadmapFilter';
import { ico, SectionState } from '../SectionState';
import { MilestoneCard } from './MilestoneCard';
import { CATEGORY_META, RM_PANEL_COL, ROADMAP_STATUS_LABEL, type RoadmapStudioCtx } from './roadmapMeta';

function readStoredFilter(key: string): RoadmapFilter {
  try {
    return parseRoadmapFilter(localStorage.getItem(key));
  } catch {
    return EMPTY_ROADMAP_FILTER;
  }
}

function writeStoredFilter(key: string, filter: RoadmapFilter): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(filter));
    return true;
  } catch {
    return false;
  }
}

export function MilestonesSection({
  ctx,
  sel,
  toggle,
}: {
  ctx: RoadmapStudioCtx;
  sel: Set<string>;
  toggle: (id: string) => void;
}) {
  const { pid, rm: roadmap, load, errObj, retry } = ctx;
  const filterKey = `emberline.roadmap.filter.${pid}`;
  const [itemFilter, setItemFilter] = useState<RoadmapFilter>(() => readStoredFilter(filterKey));

  useEffect(() => {
    writeStoredFilter(filterKey, itemFilter);
  }, [filterKey, itemFilter]);

  const milestones = useMemo(() => roadmap?.milestones ?? [], [roadmap?.milestones]);
  const filteredRoadmap = useMemo(() => filterRoadmap(milestones, itemFilter), [milestones, itemFilter]);
  const statusCounts = useMemo(() => countRoadmapStatuses(milestones), [milestones]);
  const categoryCounts = useMemo(() => countRoadmapCategories(milestones), [milestones]);
  const filterActive = isRoadmapFilterActive(itemFilter);

  if (!roadmap) {
    return (
      <SectionState
        loading={load}
        error={errObj}
        onRetry={retry}
        loadingText="Loading project milestones…"
        emptyText="No milestones available."
        errorPrefix="Could not load project milestones"
      />
    );
  }

  return (
    <section className="panel" style={RM_PANEL_COL}>
      <header className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{ico(MapIcon)} Project Milestones &amp; Roadmap</h2>
          <p className="muted">
            Track milestone delivery, check off completed items, or dispatch any roadmap item to the Kanban
            board.
          </p>
        </div>
        <span className="badge mono">{roadmap.milestones.length} milestones</span>
      </header>

      <div className="roadmap-filter" aria-label="Filter roadmap items">
        <div className="roadmap-filter-row">
          <label className="roadmap-search">
            {ico(Search)}
            <input
              className="input"
              type="search"
              placeholder="Search items, ticket keys or milestones…"
              value={itemFilter.query}
              onChange={(e) => setItemFilter((f) => ({ ...f, query: e.target.value }))}
            />
          </label>
          {filterActive && (
            <>
              <span className="muted small mono">
                {filteredRoadmap.shown} of {filteredRoadmap.total} items
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setItemFilter(EMPTY_ROADMAP_FILTER)}
              >
                {ico(X)} Clear
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
              onClick={() => setItemFilter((f) => ({ ...f, statuses: toggled(f.statuses, status) }))}
            >
              {ROADMAP_STATUS_LABEL[status]} ({statusCounts[status]})
            </button>
          ))}
        </div>
        <div className="roadmap-filter-row" role="group" aria-label="Category">
          {ROADMAP_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={`chip-btn${itemFilter.categories.includes(category) ? ' chip-on' : ''}`}
              aria-pressed={itemFilter.categories.includes(category)}
              onClick={() => setItemFilter((f) => ({ ...f, categories: toggled(f.categories, category) }))}
            >
              {CATEGORY_META[category].icon} {CATEGORY_META[category].label} ({categoryCounts[category]})
            </button>
          ))}
        </div>
      </div>

      {filteredRoadmap.shown === 0 && filterActive && (
        <div className="empty">
          <p className="muted">No roadmap items match this filter.</p>
          <button type="button" className="btn btn-sm" onClick={() => setItemFilter(EMPTY_ROADMAP_FILTER)}>
            Show all {filteredRoadmap.total} items
          </button>
        </div>
      )}

      <div style={RM_PANEL_COL}>
        {filteredRoadmap.milestones.map(({ milestone: ms, items: shownItems }) => (
          <MilestoneCard
            key={ms.id}
            ctx={ctx}
            ms={ms}
            items={shownItems}
            canDel={roadmap.milestones.length > 1}
            sel={sel}
            toggle={toggle}
          />
        ))}
      </div>
    </section>
  );
}

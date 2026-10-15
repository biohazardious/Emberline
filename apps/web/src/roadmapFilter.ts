import type { RoadmapCategory, RoadmapItem, RoadmapItemStatus, RoadmapMilestone } from '@emberline/protocol';

export const ROADMAP_STATUSES: readonly RoadmapItemStatus[] = ['idea', 'planned', 'in_progress', 'done'];
export const ROADMAP_CATEGORIES: readonly RoadmapCategory[] = [
  'feature',
  'ui_ux',
  'architecture',
  'performance',
  'qa_security',
];

/** Which roadmap items to show. An empty status or category list means "all". */
export interface RoadmapFilter {
  statuses: RoadmapItemStatus[];
  categories: RoadmapCategory[];
  query: string;
}

export const EMPTY_ROADMAP_FILTER: RoadmapFilter = { statuses: [], categories: [], query: '' };

export function isRoadmapFilterActive(filter: RoadmapFilter): boolean {
  return filter.statuses.length > 0 || filter.categories.length > 0 || filter.query.trim() !== '';
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when the item passes the status and category choices and every search term appears in the
 * item (title, description, ticket key) or in its milestone (code, title), so "M2" finds M2's items.
 */
export function roadmapItemMatches(
  item: RoadmapItem,
  milestone: RoadmapMilestone,
  filter: RoadmapFilter,
): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(item.status)) return false;
  if (filter.categories.length > 0 && !filter.categories.includes(item.category)) return false;
  const words = terms(filter.query);
  if (words.length === 0) return true;
  const haystack = [item.title, item.description, item.ticketKey ?? '', milestone.code, milestone.title]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface FilteredMilestone {
  milestone: RoadmapMilestone;
  items: RoadmapItem[];
}

/** Every milestone with the items that pass the filter, plus how many items are shown in total. */
export function filterRoadmap(
  milestones: readonly RoadmapMilestone[],
  filter: RoadmapFilter,
): { milestones: FilteredMilestone[]; shown: number; total: number } {
  let shown = 0;
  let total = 0;
  const result = milestones.map((milestone) => {
    const items = milestone.items.filter((item) => roadmapItemMatches(item, milestone, filter));
    shown += items.length;
    total += milestone.items.length;
    return { milestone, items };
  });
  return { milestones: result, shown, total };
}

/** Item counts per status across all milestones, for the filter chips. */
export function countRoadmapStatuses(
  milestones: readonly RoadmapMilestone[],
): Record<RoadmapItemStatus, number> {
  const counts: Record<RoadmapItemStatus, number> = { idea: 0, planned: 0, in_progress: 0, done: 0 };
  for (const milestone of milestones) for (const item of milestone.items) counts[item.status] += 1;
  return counts;
}

/** Item counts per category across all milestones, for the filter chips. */
export function countRoadmapCategories(
  milestones: readonly RoadmapMilestone[],
): Record<RoadmapCategory, number> {
  const counts: Record<RoadmapCategory, number> = {
    feature: 0,
    ui_ux: 0,
    architecture: 0,
    performance: 0,
    qa_security: 0,
  };
  for (const milestone of milestones) for (const item of milestone.items) counts[item.category] += 1;
  return counts;
}

/** Adds the value when absent, removes it when present. */
export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** A saved filter from storage; anything malformed falls back to "show everything". */
export function parseRoadmapFilter(raw: string | null): RoadmapFilter {
  if (!raw) return EMPTY_ROADMAP_FILTER;
  try {
    const value = JSON.parse(raw) as Partial<RoadmapFilter>;
    return {
      statuses: Array.isArray(value.statuses)
        ? value.statuses.filter((s) => ROADMAP_STATUSES.includes(s))
        : [],
      categories: Array.isArray(value.categories)
        ? value.categories.filter((c) => ROADMAP_CATEGORIES.includes(c))
        : [],
      query: typeof value.query === 'string' ? value.query : '',
    };
  } catch {
    return EMPTY_ROADMAP_FILTER;
  }
}

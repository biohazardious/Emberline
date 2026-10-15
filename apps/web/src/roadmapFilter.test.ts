import type { RoadmapItem, RoadmapMilestone } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  countRoadmapStatuses,
  EMPTY_ROADMAP_FILTER,
  filterRoadmap,
  isRoadmapFilterActive,
  parseRoadmapFilter,
  toggled,
} from './roadmapFilter';

const item = (id: string, overrides: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id,
  milestoneId: 'm',
  title: `Item ${id}`,
  description: '',
  category: 'feature',
  persona: 'coder',
  preferredAgent: 'claude',
  preferredModel: 'auto',
  priority: 2,
  status: 'planned',
  ticketId: null,
  ticketKey: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  ...overrides,
});

const milestones: RoadmapMilestone[] = [
  {
    id: 'm1',
    code: 'M1',
    title: 'Core gameplay',
    description: '',
    status: 'active',
    items: [
      item('a', { title: 'Flap physics', status: 'done' }),
      item('b', { title: 'Pipe spawner', status: 'in_progress', category: 'architecture' }),
      item('c', { title: 'Score counter', description: 'shows the best score', status: 'planned' }),
    ],
  },
  {
    id: 'm2',
    code: 'M2',
    title: 'Android release',
    description: '',
    status: 'planned',
    items: [
      item('d', { title: 'Clean APK build', status: 'idea', category: 'qa_security', ticketKey: 'FBA-94' }),
    ],
  },
];

const shownIds = (filter = EMPTY_ROADMAP_FILTER) =>
  filterRoadmap(milestones, filter).milestones.flatMap((m) => m.items.map((i) => i.id));

describe('roadmap filter', () => {
  it('shows everything without a filter', () => {
    expect(shownIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(isRoadmapFilterActive(EMPTY_ROADMAP_FILTER)).toBe(false);
  });

  it('combines several statuses (hide done = every status but done)', () => {
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, statuses: ['planned', 'in_progress', 'idea'] })).toEqual([
      'b',
      'c',
      'd',
    ]);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, statuses: ['done'] })).toEqual(['a']);
  });

  it('filters by category and status together', () => {
    expect(
      shownIds({ ...EMPTY_ROADMAP_FILTER, statuses: ['in_progress'], categories: ['architecture'] }),
    ).toEqual(['b']);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, statuses: ['done'], categories: ['architecture'] })).toEqual(
      [],
    );
  });

  it('searches titles, descriptions, ticket keys and milestones, every word must match', () => {
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, query: 'best' })).toEqual(['c']);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, query: 'fba-94' })).toEqual(['d']);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, query: 'm2' })).toEqual(['d']);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, query: 'score  counter' })).toEqual(['c']);
    expect(shownIds({ ...EMPTY_ROADMAP_FILTER, query: 'score pipe' })).toEqual([]);
  });

  it('keeps every milestone and reports shown and total counts', () => {
    const res = filterRoadmap(milestones, { ...EMPTY_ROADMAP_FILTER, statuses: ['done'] });
    expect(res.milestones.map((m) => [m.milestone.code, m.items.length])).toEqual([
      ['M1', 1],
      ['M2', 0],
    ]);
    expect([res.shown, res.total]).toEqual([1, 4]);
  });

  it('counts statuses, toggles choices and survives a malformed saved filter', () => {
    expect(countRoadmapStatuses(milestones)).toEqual({ idea: 1, planned: 1, in_progress: 1, done: 1 });
    expect(toggled(['done'], 'done')).toEqual([]);
    expect(toggled(['done'], 'idea')).toEqual(['done', 'idea']);
    expect(parseRoadmapFilter('{"statuses":["done","bogus"],"query":3}')).toEqual({
      statuses: ['done'],
      categories: [],
      query: '',
    });
    expect(parseRoadmapFilter('not json')).toEqual(EMPTY_ROADMAP_FILTER);
  });
});

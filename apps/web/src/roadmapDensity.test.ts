// @vitest-environment happy-dom
import type { ProjectRoadmapState } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrainstormingColumn } from './components/roadmap/BrainstormingColumn';
import { MilestonesColumn } from './components/roadmap/MilestonesColumn';
import { RoadmapHeaderPanel } from './components/roadmap/RoadmapHeaderPanel';
import { cleanup, renderDom } from './domRender';
import {
  countRoadmapCategories,
  countRoadmapStatuses,
  EMPTY_ROADMAP_FILTER,
  filterRoadmap,
} from './roadmapFilter';
import { visibleWordCount } from './uxDensity';

afterEach(cleanup);

/**
 * 0.9.3 baseline word counts measured with `visibleWordCount` against `ROADMAP_DENSITY_FIXTURE`
 * before EMB-47 simplified the Roadmap header, Milestones column and Ideas column:
 * - RoadmapHeaderPanel (empty selection): 65 visible words (75% budget = 48 words)
 * - BrainstormingColumn (1 suggestion): 82 visible words
 * - MilestonesColumn (2 milestones, 4 items): 120 visible words
 * - Combined default view: 267 visible words (75% budget = 200 words)
 */
export const ROADMAP_HEADER_093_WORDS = 65;
export const ROADMAP_HEADER_WORD_BUDGET = Math.floor(ROADMAP_HEADER_093_WORDS * 0.75);
export const ROADMAP_IDEAS_093_WORDS = 82;
export const ROADMAP_MILESTONES_093_WORDS = 120;
export const ROADMAP_TOTAL_093_WORDS =
  ROADMAP_HEADER_093_WORDS + ROADMAP_IDEAS_093_WORDS + ROADMAP_MILESTONES_093_WORDS;
export const ROADMAP_TOTAL_WORD_BUDGET = Math.floor(ROADMAP_TOTAL_093_WORDS * 0.75);

export const ROADMAP_DENSITY_FIXTURE: ProjectRoadmapState = {
  projectId: 'p1',
  visionSummary:
    'Self-hosted platform that runs official AI coding CLIs against a ticket board in isolated git worktrees.',
  totalItems: 4,
  completedItems: 1,
  completionPercent: 25,
  milestones: [
    {
      id: 'm1',
      code: 'M1',
      title: 'Core gameplay',
      description: 'Core mechanics and loop',
      status: 'active',
      items: [
        {
          id: 'a',
          milestoneId: 'm1',
          title: 'Flap physics',
          description: '',
          category: 'feature',
          persona: 'coder',
          preferredAgent: 'claude',
          preferredModel: 'auto',
          priority: 2,
          status: 'done',
          ticketId: null,
          ticketKey: null,
          createdAt: '2026-10-15T00:00:00.000Z',
        },
        {
          id: 'b',
          milestoneId: 'm1',
          title: 'Pipe spawner',
          description: '',
          category: 'architecture',
          persona: 'architect',
          preferredAgent: 'claude',
          preferredModel: 'auto',
          priority: 2,
          status: 'in_progress',
          ticketId: null,
          ticketKey: null,
          createdAt: '2026-10-15T00:00:00.000Z',
        },
        {
          id: 'c',
          milestoneId: 'm1',
          title: 'Score counter',
          description: 'shows the best score',
          category: 'feature',
          persona: 'coder',
          preferredAgent: 'claude',
          preferredModel: 'auto',
          priority: 1,
          status: 'planned',
          ticketId: null,
          ticketKey: null,
          createdAt: '2026-10-15T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'm2',
      code: 'M2',
      title: 'Android release',
      description: 'Packaging and store readiness',
      status: 'planned',
      items: [
        {
          id: 'd',
          milestoneId: 'm2',
          title: 'Clean APK build',
          description: '',
          category: 'qa_security',
          persona: 'qa',
          preferredAgent: 'claude',
          preferredModel: 'auto',
          priority: 3,
          status: 'idea',
          ticketId: 't-94',
          ticketKey: 'FBA-94',
          createdAt: '2026-10-15T00:00:00.000Z',
        },
      ],
    },
  ],
  suggestions: [
    {
      id: 's1',
      title: 'Add offline leaderboard cache',
      rationale: 'Keep high scores available when the device has no network connection.',
      implementationPrompt: 'Cache top 50 scores in local storage.',
      category: 'feature',
      impact: 'high',
      effort: 'small',
      persona: 'coder',
      preferredAgent: 'claude',
      preferredModel: 'sonnet',
      suggestedMilestoneCode: 'M2',
    },
  ],
  updatedAt: '2026-10-15T00:00:00.000Z',
};

describe('Roadmap density guard (AC-6.5)', () => {
  it('keeps the roadmap header with an empty selection at or below 75% of its 0.9.3 word count', async () => {
    const { container } = await renderDom(
      createElement(RoadmapHeaderPanel, {
        projectName: 'Emberline',
        roadmap: ROADMAP_DENSITY_FIXTURE,
        busy: null,
        isAgentBrainstorming: false,
        onAutoGenerate: () => undefined,
        onOpenBoard: () => undefined,
        quickAddTarget: 'auto',
        onQuickAddTargetChange: () => undefined,
        quickAddText: '',
        onQuickAddTextChange: () => undefined,
        onSmartQuickAdd: () => undefined,
        selectedSuggestionsCount: 0,
        selectedItemsCount: 0,
        onClearSelection: () => undefined,
        onDispatchSelected: () => undefined,
        banner: null,
        error: null,
      }),
    );

    const words = visibleWordCount(container);
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThanOrEqual(ROADMAP_HEADER_WORD_BUDGET);
  });

  it('keeps the combined default roadmap view at or below 75% of its 0.9.3 word count', async () => {
    const { container } = await renderDom(
      createElement(
        'div',
        null,
        createElement(RoadmapHeaderPanel, {
          projectName: 'Emberline',
          roadmap: ROADMAP_DENSITY_FIXTURE,
          busy: null,
          isAgentBrainstorming: false,
          onAutoGenerate: () => undefined,
          onOpenBoard: () => undefined,
          quickAddTarget: 'auto',
          onQuickAddTargetChange: () => undefined,
          quickAddText: '',
          onQuickAddTextChange: () => undefined,
          onSmartQuickAdd: () => undefined,
          selectedSuggestionsCount: 0,
          selectedItemsCount: 0,
          onClearSelection: () => undefined,
          onDispatchSelected: () => undefined,
          banner: null,
          error: null,
        }),
        createElement(MilestonesColumn, {
          projectId: 'p1',
          totalMilestoneCount: ROADMAP_DENSITY_FIXTURE.milestones.length,
          filteredRoadmap: filterRoadmap(ROADMAP_DENSITY_FIXTURE.milestones, EMPTY_ROADMAP_FILTER),
          itemFilter: EMPTY_ROADMAP_FILTER,
          onItemFilterChange: () => undefined,
          filterActive: false,
          statusCounts: countRoadmapStatuses(ROADMAP_DENSITY_FIXTURE.milestones),
          categoryCounts: countRoadmapCategories(ROADMAP_DENSITY_FIXTURE.milestones),
          selectedItems: new Set<string>(),
          onToggleItem: () => undefined,
          onToggleItemDone: () => undefined,
          onDeleteItem: () => undefined,
          onDispatchSingleItem: () => undefined,
          onDispatchMilestone: () => undefined,
          onDeleteMilestone: () => undefined,
          inlineMsInputs: {},
          onInlineMsInputChange: () => undefined,
          onInlineMilestoneAdd: () => undefined,
          enabledProviders: ['claude'],
          onChangeRoute: () => undefined,
          busy: null,
        }),
        createElement(BrainstormingColumn, {
          projectName: 'Emberline',
          filteredSuggestions: ROADMAP_DENSITY_FIXTURE.suggestions,
          selectedSuggestions: new Set<string>(),
          onToggleSuggestion: () => undefined,
          onToggleSelectAllSuggestions: () => undefined,
          onClearAllSuggestions: () => undefined,
          onBuildAllSuggestions: () => undefined,
          brainstormFocus: '',
          onBrainstormFocusChange: () => undefined,
          categoryFilter: 'all',
          onCategoryFilterChange: () => undefined,
          onBrainstorm: () => undefined,
          busy: null,
          isAgentBrainstorming: false,
          activeBrainstormRun: undefined,
          enabledProviders: ['claude'],
          onChangeRoute: () => undefined,
          onQuickPromoteSuggestion: () => undefined,
          onDismissSuggestion: () => undefined,
        }),
      ),
    );

    const totalWords = visibleWordCount(container);
    expect(totalWords).toBeLessThanOrEqual(ROADMAP_TOTAL_WORD_BUDGET);
  });
});

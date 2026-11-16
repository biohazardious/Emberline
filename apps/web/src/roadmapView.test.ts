// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactorySettings, type ProjectRoadmapState } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { RoadmapHeaderPanel } from './components/roadmap/RoadmapHeaderPanel';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import { RoadmapPage } from './pages/RoadmapPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

function fireKey(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function makeSettings(): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
    enabledProviders: ['claude', 'codex'],
    personaAgents: {},
    personaRoutes: {
      product_owner: defaultChain,
      architect: defaultChain,
      ui_ux: defaultChain,
      coder: defaultChain,
      dba: defaultChain,
      qa: defaultChain,
      security: defaultChain,
    },
  });
}

const BASE_ROADMAP: ProjectRoadmapState = {
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

function cloneRoadmap(overrides: Partial<ProjectRoadmapState> = {}): ProjectRoadmapState {
  return structuredClone({
    ...BASE_ROADMAP,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('Roadmap view (EMB-47)', () => {
  it('reaches both generation modes from the Generate roadmap MoreMenu and shows the architect working state', async () => {
    const onAutoGenerate = vi.fn();
    const onOpenBoard = vi.fn();
    const view = await renderDom(
      createElement(RoadmapHeaderPanel, {
        projectName: 'Emberline',
        roadmap: cloneRoadmap(),
        busy: null,
        isAgentBrainstorming: false,
        onAutoGenerate,
        onOpenBoard,
        quickAddTarget: 'auto',
        onQuickAddTargetChange: () => undefined,
        quickAddText: '',
        onQuickAddTextChange: () => undefined,
        onSmartQuickAdd: (e) => e.preventDefault(),
        selectedSuggestionsCount: 0,
        selectedItemsCount: 0,
        onClearSelection: () => undefined,
        onDispatchSelected: () => undefined,
        banner: null,
        error: null,
      }),
    );

    const h1s = view.container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Roadmap');
    expect(view.container.textContent).toContain('Emberline');
    expect(view.container.textContent).toContain('1/4 done (25%)');
    expect(view.container.textContent).not.toContain('Studio');

    // Vision summary clamps to two lines and expands with "Show more".
    const visionP = view.container.querySelector('.roadmap-vision')!;
    expect(visionP.classList.contains('is-clamped')).toBe(true);
    const showMoreBtn = getButton('Show more', view.container);
    expect(showMoreBtn.getAttribute('aria-expanded')).toBe('false');
    await click(showMoreBtn);
    expect(visionP.classList.contains('is-expanded')).toBe(true);
    expect(getButton('Show less', view.container).getAttribute('aria-expanded')).toBe('true');

    // Open Generate roadmap MoreMenu and trigger instant mode.
    await click(getButton('Generate roadmap', view.container));
    const instantBtn = view.container.querySelector<HTMLButtonElement>('#roadmap-autogen-instant-btn')!;
    expect(instantBtn).not.toBeNull();
    expect(instantBtn.textContent).toContain('From PROJECT.md (instant)');
    await click(instantBtn);
    expect(onAutoGenerate).toHaveBeenCalledWith('instant');

    // Reopen Generate roadmap MoreMenu and trigger architect agent mode.
    await click(getButton('Generate roadmap', view.container));
    const agentBtn = view.container.querySelector<HTMLButtonElement>('#roadmap-autogen-agent-btn')!;
    expect(agentBtn).not.toBeNull();
    expect(agentBtn.textContent).toContain('With the architect agent');
    expect(agentBtn.disabled).toBe(false);
    await click(agentBtn);
    expect(onAutoGenerate).toHaveBeenCalledWith('agent');

    // When the architect agent is working, the menu item reflects its working state and is disabled.
    await view.rerender(
      createElement(RoadmapHeaderPanel, {
        projectName: 'Emberline',
        roadmap: cloneRoadmap(),
        busy: null,
        isAgentBrainstorming: true,
        onAutoGenerate,
        onOpenBoard,
        quickAddTarget: 'auto',
        onQuickAddTargetChange: () => undefined,
        quickAddText: '',
        onQuickAddTextChange: () => undefined,
        onSmartQuickAdd: (e) => e.preventDefault(),
        selectedSuggestionsCount: 0,
        selectedItemsCount: 0,
        onClearSelection: () => undefined,
        onDispatchSelected: () => undefined,
        banner: null,
        error: null,
      }),
    );
    await click(getButton('Generate roadmap', view.container));
    const workingAgentBtn = view.container.querySelector<HTMLButtonElement>('#roadmap-autogen-agent-btn')!;
    expect(workingAgentBtn.textContent).toContain('Architect working…');
    expect(workingAgentBtn.disabled).toBe(true);

    await click(getButton('Open board', view.container));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('shows the selection bar only while items or ideas are selected and sends them to the board', async () => {
    const roadmapState = cloneRoadmap();
    const dispatchedPayloads: unknown[] = [];

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1': () => ({
          id: 'p1',
          name: 'Emberline',
          slug: 'emberline',
          repoPath: '/workspace',
          defaultBranch: 'main',
          createdAt: '2026-10-15T00:00:00.000Z',
        }),
        'GET /api/projects/p1/roadmap': () => roadmapState,
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/runs': () => [],
        'POST /api/projects/p1/roadmap/dispatch': (body) => {
          dispatchedPayloads.push(body);
          return {
            roadmap: roadmapState,
            createdTickets: [{ id: 't1', key: 'EMB-99', title: 'Pipe spawner' }],
            startedRun: null,
          };
        },
      }),
    );

    const { container } = await renderDom(createElement(RoadmapPage, { projectId: 'p1' }), {
      path: '/projects/p1/roadmap',
    });

    await waitFor(() => expect(container.textContent).toContain('Core gameplay'));

    // With nothing selected, the selection bar is absent.
    expect(container.querySelector('.roadmap-selection-bar')).toBeNull();
    expect(queryButton('Send to board', container)).toBeNull();
    expect(queryButton('Clear selection', container)).toBeNull();

    // Select one milestone item and one idea suggestion.
    const itemCheckbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"][aria-label="Select Pipe spawner"]',
    )!;
    expect(itemCheckbox).not.toBeNull();
    await click(itemCheckbox);

    const selectionBar = container.querySelector('.roadmap-selection-bar')!;
    expect(selectionBar).not.toBeNull();
    expect(selectionBar.textContent).toContain('1 selected (0 ideas, 1 item)');

    const ideaCheckbox = container.querySelector<HTMLInputElement>('.roadmap-idea-checkbox')!;
    await click(ideaCheckbox);
    expect(selectionBar.textContent).toContain('2 selected (1 idea, 1 item)');

    // Send selected items to the board (autoStart = false).
    await click(getButton('Send to board', container));
    await waitFor(() => expect(dispatchedPayloads).toHaveLength(1));
    expect(dispatchedPayloads[0]).toEqual({
      itemIds: ['b'],
      suggestionIds: ['s1'],
      autoStart: false,
    });

    // Selection is cleared after dispatch, hiding the selection bar again.
    await waitFor(() => expect(container.querySelector('.roadmap-selection-bar')).toBeNull());
  });

  it('collapses and expands a milestone group by keyboard (Enter and Space) and supports inline item and idea actions', async () => {
    let roadmapState = cloneRoadmap();
    const calls: Array<{ endpoint: string; body: unknown }> = [];

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1': () => ({
          id: 'p1',
          name: 'Emberline',
          slug: 'emberline',
          repoPath: '/workspace',
          defaultBranch: 'main',
          createdAt: '2026-10-15T00:00:00.000Z',
        }),
        'GET /api/projects/p1/roadmap': () => roadmapState,
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/runs': () => [],
        'POST /api/projects/p1/roadmap/brainstorm': (body) => {
          calls.push({ endpoint: 'POST brainstorm', body });
          return { roadmap: roadmapState, agentRun: null };
        },
        'POST /api/projects/p1/roadmap/items': (body) => {
          calls.push({ endpoint: 'POST items', body });
          const payload = body as { milestoneId: string; title: string };
          roadmapState = cloneRoadmap({
            milestones: roadmapState.milestones.map((m) =>
              m.id === payload.milestoneId
                ? {
                    ...m,
                    items: [
                      ...m.items,
                      {
                        id: 'new-item',
                        milestoneId: m.id,
                        title: payload.title,
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
                      },
                    ],
                  }
                : m,
            ),
          });
          return roadmapState;
        },
        'PATCH /api/projects/p1/roadmap/items/c': (body) => {
          calls.push({ endpoint: 'PATCH item c', body });
          return roadmapState;
        },
        'DELETE /api/projects/p1/roadmap/items/s1': (body) => {
          calls.push({ endpoint: 'DELETE s1', body });
          roadmapState = cloneRoadmap({ suggestions: [] });
          return roadmapState;
        },
      }),
    );

    const { container } = await renderDom(createElement(RoadmapPage, { projectId: 'p1' }), {
      path: '/projects/p1/roadmap',
    });

    await waitFor(() => expect(container.textContent).toContain('Core gameplay'));

    // Headings and primary button check.
    const h2s = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(h2s).toEqual(['Milestones', 'Ideas']);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);

    // Items render title, persona, priority and state badges.
    expect(container.querySelectorAll('.roadmap-state-badge').length).toBeGreaterThanOrEqual(4);
    expect(container.querySelectorAll('.roadmap-priority-badge').length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).toContain('High');
    expect(container.textContent).toContain('Urgent');
    expect(container.textContent).toContain('In progress');

    // Milestone M1 toggle button collapses on Enter and expands on Space.
    const m1Toggle = container.querySelector<HTMLButtonElement>(
      'button.roadmap-milestone-toggle[aria-controls="milestone-body-m1"]',
    )!;
    expect(m1Toggle).not.toBeNull();
    expect(m1Toggle.getAttribute('aria-expanded')).toBe('true');
    expect(m1Toggle.textContent).toContain('1/3 (33%)');
    expect(container.textContent).toContain('Flap physics');

    await act(async () => fireKey(m1Toggle, 'Enter'));
    expect(m1Toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#milestone-body-m1')).toBeNull();
    expect(container.textContent).not.toContain('Flap physics');

    await act(async () => fireKey(m1Toggle, ' '));
    expect(m1Toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#milestone-body-m1')).not.toBeNull();
    expect(container.textContent).toContain('Flap physics');

    // Inline add to M1.
    const m1Input = container.querySelector<HTMLInputElement>(
      '#milestone-body-m1 input.roadmap-inline-input',
    )!;
    await typeInto(m1Input, 'Add sound effects');
    await click(getButton('Add item', container.querySelector('#milestone-body-m1')!));
    await waitFor(() =>
      expect(calls).toContainEqual({
        endpoint: 'POST items',
        body: { milestoneId: 'm1', title: 'Add sound effects' },
      }),
    );

    // Dismiss suggestion row.
    expect(getButton('Add to roadmap', container)).toBeTruthy();
    await click(getButton('Dismiss', container));
    await waitFor(() => expect(calls.some((c) => c.endpoint === 'DELETE s1')).toBe(true));

    // Suggest ideas button in Ideas prompt box.
    const focusInput = container.querySelector<HTMLInputElement>('#brainstorm-focus-input')!;
    await typeInto(focusInput, 'accessibility');
    await click(container.querySelector<HTMLButtonElement>('#brainstorm-instant-btn')!);
    await waitFor(() =>
      expect(calls).toContainEqual({
        endpoint: 'POST brainstorm',
        body: { focus: 'accessibility', mode: 'instant', leadPersona: 'product_owner' },
      }),
    );
  });

  it('enforces zero static inline styles in roadmap components and token-only >=0.8rem CSS', () => {
    const css = readFileSync(resolve(HERE, 'components/roadmap/roadmap-ux.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);

    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }

    const files = [
      'pages/RoadmapPage.tsx',
      'components/roadmap/RoadmapHeaderPanel.tsx',
      'components/roadmap/MilestonesColumn.tsx',
      'components/roadmap/BrainstormingColumn.tsx',
      'components/roadmap/RoadmapBadges.tsx',
    ];
    for (const rel of files) {
      const source = readFileSync(resolve(HERE, rel), 'utf8');
      expect(source).not.toContain('style={{');
      expect(source.split('\n').length).toBeLessThan(450);
    }
  });
});

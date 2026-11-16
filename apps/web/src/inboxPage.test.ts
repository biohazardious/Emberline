// @vitest-environment happy-dom
import type { Project, Run, RunRecovery } from '@emberline/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, renderDom } from './domRender';
import { InboxPage } from './pages/InboxPage';
import { renderStatic } from './staticRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(cleanup);

const run = (id: string, projectId: string): Run =>
  ({
    id,
    projectId,
    ticketId: null,
    title: 'Fix it',
    agent: 'claude',
    persona: 'coder',
    state: 'waiting_input',
    prompt: '',
    permissionMode: 'default',
    branch: null,
    worktreePath: '',
    terminalId: null,
    agentSessionId: null,
    lastEvent: null,
    stateChangedAt: '2026-10-18T12:00:00.000Z',
    createdAt: '2026-10-18T11:00:00.000Z',
    endedAt: null,
    resumable: false,
    cancelled: false,
    attention: {
      reason: 'question',
      detail: null,
      since: '2026-10-18T11:59:00.000Z',
      occurrence: `${id}:question:e1`,
    },
    reviewReady: false,
  }) as Run;

const page = (runs: Run[], activeProjectId: string | null, cached: Record<string, unknown> = {}) =>
  renderStatic(
    createElement(InboxPage, {
      runs,
      seen: {},
      activeProjectId,
      projectName: activeProjectId ? 'Alpha' : undefined,
      onOpenRun: () => undefined,
      onDismiss: () => undefined,
    }),
    cached,
  );

describe('InboxPage', () => {
  it('without an active project has no toggle and reveals all-projects scope in HelpHint', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [],
        'GET /api/notices': () => [],
      }),
    );
    const html = page([], null);
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('Nothing needs you right now.');

    const view = await renderDom(
      createElement(InboxPage, {
        runs: [],
        seen: {},
        activeProjectId: null,
        onOpenRun: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="About inbox"]')!);
    expect(view.container.textContent).toContain('Runs that need you, across all projects');
  });
  it('scoped to a project says what it leaves out', () => {
    const html = page([run('r2', 'p2')], 'p1', { '/api/projects': [] as Project[] });
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Nothing in this project needs you right now.');
    expect(html).toContain('>1 more in other projects</button>');
  });
  it('shows no "Project" placeholder while the project list is not loaded', () => {
    expect(page([run('r1', 'p1')], null)).not.toContain('>Project<');
  });
  it('names agents as people read them, an old Gemini CLI run as removed', () => {
    const html = page([run('r1', 'p1'), { ...run('r2', 'p1'), agent: 'gemini' }], null);
    expect(html).toContain('>Claude</span>');
    expect(html).toContain('>Gemini CLI (removed)</span>');
    expect(html).not.toContain('>gemini</span>');
  });
  it('offers an Answer button, not an inline reply box, for a question', () => {
    const html = page([run('r1', 'p1')], null);
    expect(html).toContain('>Answer</button>');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('inbox-reply');
  });
  it("offers no Answer on a held run that can't take a prompt", () => {
    const held = {
      ...run('r1', 'p1'),
      state: 'done',
      attention: { reason: 'blocked', detail: 'no key', since: '2026-10-18T11:59:00.000Z', occurrence: 'o' },
    } as Run;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const recovery = (delivery: RunRecovery['delivery']): RunRecovery => ({
      hold: 'completion_blocked',
      label: 'Blocked',
      why: 'The agent is blocked.',
      delivery,
      suggestions: [],
    });
    const render = () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(InboxPage, {
            runs: [held],
            seen: {},
            activeProjectId: null,
            onOpenRun: () => undefined,
            onDismiss: () => undefined,
          }),
        ),
      );
    client.setQueryData(['run-recovery', 'r1'], recovery('session'));
    expect(render()).toContain('>Answer</button>');
    client.setQueryData(['run-recovery', 'r1'], recovery('none'));
    const html = render();
    expect(html).not.toContain('>Answer</button>');
    expect(html).toContain('This run can&#x27;t take a prompt any more.');
  });
});

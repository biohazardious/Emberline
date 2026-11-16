// @vitest-environment happy-dom
import { FactorySettings, type McpServerEntry, type SkillPluginEntry } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { SettingsPage } from './pages/SettingsPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
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

describe('Automation view (Settings → Automation)', () => {
  it('renders all 16 controls under grouped headings with n-of-m switch counts, toggles one control per group, clamps numbers onBlur, and saves the full PATCH payload', async () => {
    const savedPatches: Record<string, unknown>[] = [];
    const themeChanges: Array<'dark' | 'light'> = [];
    const initial = makeSettings();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'PATCH /api/factory/settings': (body) => {
          const patch = body as Record<string, unknown>;
          savedPatches.push(patch);
          return makeSettings(patch as Partial<FactorySettings>);
        },
      }),
    );

    const view = await renderDom(
      createElement(SettingsPage, {
        theme: 'dark',
        onChangeTheme: (next) => themeChanges.push(next),
      }),
      { path: '/settings' },
    );

    await waitFor(() => expect(view.container.textContent).toContain('Appearance'));

    const headings = [...view.container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      'Appearance',
      'Queue',
      'Quality gates',
      'Merging',
      'Storage',
      'Commit identity',
    ]);

    expect(view.container.textContent).toContain('1 of 2 on');
    expect(view.container.textContent).toContain('4 of 5 on');
    expect(view.container.textContent).toContain('4 of 4 on');

    // 1. Appearance: switch theme to Light via segmented radio control
    const lightRadio = view.container.querySelector<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="Theme"] button[role="radio"]:last-child',
    )!;
    expect(lightRadio.textContent?.trim()).toBe('Light');
    await click(lightRadio);
    expect(themeChanges).toEqual(['light']);

    // 2. Queue: toggle "Pull from backlog" and test clamping on "Parallel tickets per project"
    const pullBacklogSwitch = view.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Pull from backlog"]',
    )!;
    expect(pullBacklogSwitch.getAttribute('aria-checked')).toBe('false');
    await click(pullBacklogSwitch);
    expect(pullBacklogSwitch.getAttribute('aria-checked')).toBe('true');
    expect(view.container.textContent).toContain('2 of 2 on');

    const parallelInput = view.container.querySelector<HTMLInputElement>('#setting-parallel-tickets')!;
    await typeInto(parallelInput, '9');
    await act(async () => {
      parallelInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(parallelInput.value).toBe('4');

    const budgetInput = view.container.querySelector<HTMLInputElement>('#setting-daily-budget')!;
    await typeInto(budgetInput, '0');
    expect(budgetInput.value).toBe('0');

    const depthInput = view.container.querySelector<HTMLInputElement>('#setting-ticket-depth')!;
    await typeInto(depthInput, '5');
    expect(depthInput.value).toBe('5');

    // 3. Quality gates: toggle "Diff audit"
    const diffAuditSwitch = view.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Diff audit"]',
    )!;
    expect(diffAuditSwitch.getAttribute('aria-checked')).toBe('true');
    await click(diffAuditSwitch);
    expect(diffAuditSwitch.getAttribute('aria-checked')).toBe('false');
    expect(view.container.textContent).toContain('3 of 5 on');

    // 4. Merging: toggle "Move verified tickets to Done"
    const moveDoneSwitch = view.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Move verified tickets to Done"]',
    )!;
    expect(moveDoneSwitch.getAttribute('aria-checked')).toBe('true');
    await click(moveDoneSwitch);
    expect(moveDoneSwitch.getAttribute('aria-checked')).toBe('false');
    expect(view.container.textContent).toContain('3 of 4 on');

    // 5. Storage: test clamping on "Build outputs archive (GB)"
    const quotaInput = view.container.querySelector<HTMLInputElement>('#setting-build-outputs-quota')!;
    await typeInto(quotaInput, '0.1');
    await act(async () => {
      quotaInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(quotaInput.value).toBe('0.5');

    // 6. Commit identity: update Name and Email
    const nameInput = [...view.container.querySelectorAll('label.field')]
      .find((l) => l.textContent?.includes('Name'))
      ?.querySelector('input') as HTMLInputElement;
    const emailInput = [...view.container.querySelectorAll('label.field')]
      .find((l) => l.textContent?.includes('Email'))
      ?.querySelector('input') as HTMLInputElement;
    await typeInto(nameInput, 'Ada Lovelace');
    await typeInto(emailInput, 'ada@emberline.dev');

    await click(getButton('Save', view.container));
    await waitFor(() => expect(savedPatches).toHaveLength(1));

    expect(savedPatches[0]).toMatchObject({
      theme: 'light',
      autoPickupReady: true,
      autoPickupBacklog: true,
      maxParallelTicketsPerProject: 4,
      maxAutoRunsPerProjectPerDay: 0,
      maxTicketDepth: 5,
      selfHealingBuildGate: true,
      antiSlopGate: false,
      secretGuardGate: true,
      requireCompletionSignal: true,
      crossProviderCritic: false,
      autoSyncToMain: true,
      autoResolveAdditiveConflicts: true,
      serializeOverlappingTickets: true,
      autoMoveToDone: false,
      buildOutputsQuotaGb: 0.5,
      commitIdentity: { name: 'Ada Lovelace', email: 'ada@emberline.dev' },
    });
  });

  it('keeps every 0.9.3 explanation fact reachable behind each SettingRow disclosure', async () => {
    const initial = makeSettings();
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
      }),
    );

    const view = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );
    await waitFor(() => expect(view.container.textContent).toContain('Quality gates'));

    // Before opening disclosures, detailed technical terms are hidden
    expect(view.container.textContent).not.toContain('.emberline/worktree.yml');
    expect(view.container.textContent).not.toContain('@ts-ignore');
    expect(view.container.textContent).not.toContain('AKIA...');

    // Open all Details disclosures on the tab
    const disclosureTriggers = [
      ...view.container.querySelectorAll<HTMLButtonElement>('.ui-disclosure-trigger'),
    ];
    expect(disclosureTriggers.length).toBe(15);
    for (const btn of disclosureTriggers) {
      await click(btn);
    }

    const fullText = view.container.textContent ?? '';
    expect(fullText).toContain('.emberline/worktree.yml');
    expect(fullText).toContain('CI=true');
    expect(fullText).toContain('@ts-ignore');
    expect(fullText).toContain('strings, template literals and JSX is not scanned');
    expect(fullText).toContain('AKIA...');
    expect(fullText).toContain('.env.example');
    expect(fullText).toContain('0 = unlimited');
    expect(fullText).toContain('Manual starts are not limited');
    expect(fullText).toContain('0.5 and 1000 GB');
    expect(fullText).toContain('less than 1 GB free');
  });
});

describe('MCP and skills view (Settings → MCP and skills)', () => {
  it('adds, edits, enables, disables and removes MCP servers and skills and saves the updated registry', async () => {
    const savedPatches: Record<string, unknown>[] = [];
    const initial = makeSettings();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'PATCH /api/factory/settings': (body) => {
          const patch = body as Record<string, unknown>;
          savedPatches.push(patch);
          return makeSettings(patch as Partial<FactorySettings>);
        },
      }),
    );

    const view = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );

    await waitFor(() => expect(view.container.textContent).toContain('Appearance'));
    await click(getButton('MCP and skills', view.container));

    await waitFor(() => expect(view.container.textContent).toContain('MCP servers'));
    expect(view.container.textContent).toContain('1 of 6 on');
    expect(view.container.textContent).toContain('Skills');
    expect(view.container.textContent).toContain('4 of 4 on');

    // Toggle Context7 MCP server on
    const context7Switch = view.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Context7 Live Library Docs"]',
    )!;
    expect(context7Switch.getAttribute('aria-checked')).toBe('false');
    await click(context7Switch);
    expect(context7Switch.getAttribute('aria-checked')).toBe('true');
    expect(view.container.textContent).toContain('2 of 6 on');

    // Open Details on Playwright MCP server and edit command, args, env, and persona scope
    const firstDisclosure = view.container.querySelector<HTMLButtonElement>('.ui-disclosure-trigger')!;
    await click(firstDisclosure);

    const cmdInput = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Command for Playwright Live Browser (CDP)"]',
    )!;
    await typeInto(cmdInput, 'custom-playwright-mcp');

    const envInput = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Environment variables for Playwright Live Browser (CDP)"]',
    )!;
    await typeInto(envInput, 'CDP_PORT=9222\nHEADLESS=true');

    // Add a custom MCP server
    await click(getButton('Add server', view.container));
    const addBoxInputs = [...view.container.querySelectorAll<HTMLInputElement>('.settings-add-box input')];
    await typeInto(addBoxInputs[0]!, 'Stripe MCP');
    await typeInto(addBoxInputs[1]!, 'stripe-mcp');
    const submitServerBtn = [
      ...view.container.querySelectorAll<HTMLButtonElement>('.settings-add-box button'),
    ].find((b) => b.textContent?.trim() === 'Add server')!;
    await click(submitServerBtn);

    expect(view.container.textContent).toContain('Stripe MCP');
    expect(view.container.textContent).toContain('3 of 7 on');

    // Open Details on first skill and edit rule text
    const allDisclosures = [...view.container.querySelectorAll<HTMLButtonElement>('.ui-disclosure-trigger')];
    const firstSkillDisclosure = allDisclosures[7]!;
    await click(firstSkillDisclosure);

    const ruleTextarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Rule text for High-Craft UI & Design Systems Skill"]',
    )!;
    await typeInto(ruleTextarea, 'UPDATED UI SKILL RULE');

    // Add a custom skill
    await click(getButton('Add skill', view.container));
    const skillBox = view.container.querySelector('.settings-add-box')!;
    const skillInputs = [...skillBox.querySelectorAll<HTMLInputElement>('input')];
    const skillTextarea = skillBox.querySelector<HTMLTextAreaElement>('textarea')!;
    await typeInto(skillInputs[0]!, 'Hexagonal Domain Rules');
    await typeInto(skillInputs[1]!, 'Enforces domain boundaries.');
    await typeInto(skillTextarea, 'Keep domain pure and free of framework imports.');
    const submitSkillBtn = [...skillBox.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Add skill',
    )!;
    await click(submitSkillBtn);

    expect(view.container.textContent).toContain('Hexagonal Domain Rules');
    expect(view.container.textContent).toContain('5 of 5 on');

    // Save and verify PATCH payload
    await click(getButton('Save', view.container));
    await waitFor(() => expect(savedPatches).toHaveLength(1));

    const savedServers = savedPatches[0]!.mcpServers as McpServerEntry[];
    const savedSkills = savedPatches[0]!.skillPlugins as SkillPluginEntry[];

    expect(savedServers).toHaveLength(7);
    const playwrightSrv = savedServers.find((s) => s.id === 'playwright')!;
    expect(playwrightSrv.command).toBe('custom-playwright-mcp');
    expect(playwrightSrv.env).toEqual({ CDP_PORT: '9222', HEADLESS: 'true' });

    const stripeSrv = savedServers.find((s) => s.id === 'stripe-mcp')!;
    expect(stripeSrv.name).toBe('Stripe MCP');
    expect(stripeSrv.builtIn).toBe(false);

    expect(savedSkills).toHaveLength(5);
    const uiSkill = savedSkills.find((s) => s.id === 'modern-ui-craft')!;
    expect(uiSkill.instructions).toBe('UPDATED UI SKILL RULE');

    const hexSkill = savedSkills.find((s) => s.id === 'hexagonal-domain-rules')!;
    expect(hexSkill.name).toBe('Hexagonal Domain Rules');
    expect(hexSkill.builtIn).toBe(false);

    // Remove the custom MCP server and custom skill
    const removeStripeBtn = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Stripe MCP"]',
    )!;
    await click(removeStripeBtn);
    expect(view.container.textContent).not.toContain('Stripe MCP');

    const removeHexBtn = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Hexagonal Domain Rules"]',
    )!;
    await click(removeHexBtn);
    expect(view.container.textContent).not.toContain('Hexagonal Domain Rules');
  });
});

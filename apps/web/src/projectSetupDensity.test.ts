// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ContainerPreviewOptionsResponse,
  ForgeAccountsResponse,
  Project,
  ProjectPreviewResponse,
  ProjectSettingsResponse,
  ProjectSshKeyResponse,
  RepositoryStatus,
  SshKeyPublic,
  WorktreeConfigStatusResponse,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { StepSummary } from './components/wizard/StepSummary';
import { ProjectWizard } from './components/wizard/WizardShell';
import { initialWizardState, type WizardState, wizardReducer } from './components/wizard/wizardLogic';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-render visible word counts measured with `visibleWordCount(container)`
 * against the standard fixtures below before the M6 redesign.
 */
export const PROJECT_SETUP_093_BASELINE_WORDS = {
  projectSettingsPage: 302,
  wizardSummaryStep: 133,
} as const;

export const PROJECT_SETUP_WORD_BUDGET_RATIO = 0.75;

const project: Project = {
  id: 'p1',
  name: 'Shop',
  slug: 'shop',
  path: '/workspaces/shop',
  repoUrl: 'https://github.com/alice/shop.git',
  defaultBranch: 'main',
  appType: 'web_saas',
  description: '',
  techStack: null,
  createdAt: '2026-11-10T09:00:00.000Z',
};

const repoStatus: RepositoryStatus = {
  isGitRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  hasCommits: true,
  originUrl: 'https://github.com/alice/shop.git',
  originHost: 'github.com',
  transport: 'https',
  account: { id: 'a1', provider: 'github', serverUrl: 'https://github.com', username: 'alice' },
  connected: true,
  mainState: 'ahead',
  ahead: 1,
  behind: 0,
  remoteError: null,
  checkedAt: '2026-11-10T09:00:00.000Z',
  mainTip: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Initial commit' },
  keepMainPushed: false,
  lastMainPushError: null,
  pushTarget: 'integration_branch',
  integrationBranch: 'emberline/integration',
  workingBranch: 'main',
  keepPushedBranch: 'emberline/integration',
  commitIdentity: null,
  factoryCommitIdentity: { name: 'Emberline AI Factory', email: 'factory@emberline.local' },
  originHasCredentials: false,
  originMasked: false,
};

const gateSettings: ProjectSettingsResponse = {
  gates: { secretGuardGate: false, antiSlopGate: true },
  effective: {
    selfHealingBuildGate: true,
    antiSlopGate: true,
    secretGuardGate: false,
    crossProviderCritic: false,
    autoSyncToMain: true,
    requireCompletionSignal: true,
  },
  global: {
    selfHealingBuildGate: true,
    antiSlopGate: false,
    secretGuardGate: true,
    crossProviderCritic: false,
    autoSyncToMain: true,
    requireCompletionSignal: true,
  },
};

const worktreeStatus: WorktreeConfigStatusResponse = {
  approved: {
    content: 'version: 1\nchecks:\n  build: pnpm build\n',
    sha256: 'a'.repeat(64),
    approvedAt: '2026-11-10T09:00:00.000Z',
    approvedBy: 'person',
  },
  head: {
    content: 'version: 1\nchecks:\n  build: pnpm build\n',
    sha256: 'a'.repeat(64),
  },
  headError: null,
  changed: false,
  removed: false,
  diff: '',
  errors: [],
  unusable: false,
};

const containerPreviewOptions: ContainerPreviewOptionsResponse = {
  available: true,
  reason: null,
  file: 'compose.yaml',
  services: [{ name: 'web', ports: [3000] }],
  commandPreview: true,
};

const sshKey: SshKeyPublic = {
  publicKey: 'ssh-ed25519 AAAAshared emberline',
  fingerprint: 'SHA256:shared',
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
};

const projectSshKey: ProjectSshKeyResponse = {
  choice: 'shared',
  key: null,
  shared: sshKey,
};

const accounts: ForgeAccountsResponse = {
  accounts: [
    {
      id: 'a1',
      provider: 'github',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      username: 'alice',
      tokenConfigured: true,
      scopesHint: 'repo',
      source: 'settings',
    },
  ],
  legacyTokenUnmatched: false,
};

const previewData: ProjectPreviewResponse = {
  projectMd: '# Shop\n',
  claudeMd: '# Claude\n',
  worktreeYml: 'version: 1\n',
  starterFiles: ['package.json', 'tsconfig.json'],
  tickets: [
    { key: 'SHOP-1', title: 'Bootstrap workspace', persona: 'architect', dependsOn: [] },
    { key: 'SHOP-2', title: 'Deploy setup', persona: 'architect', dependsOn: ['SHOP-1'] },
  ],
  gates: {},
  materials: [],
  notes: ['Runs install dependencies before the build gate.'],
};

function makeSummaryWizardState(): WizardState {
  let s = initialWizardState();
  s = wizardReducer(s, { type: 'source', source: 'preset' });
  s = wizardReducer(s, { type: 'field', field: 'name', value: 'Shop' });
  s = wizardReducer(s, { type: 'appType', appType: 'web_saas' });
  s = wizardReducer(s, {
    type: 'field',
    field: 'vision',
    value: 'An online store with a product catalogue, cart and checkout.',
  });
  return { ...s, step: 'summary', furthest: 4 };
}

function installRoutes(overrides: Record<string, (body?: unknown) => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [project],
      'GET /api/projects/p1/repository': () => repoStatus,
      'GET /api/projects/p1/settings': () => gateSettings,
      'GET /api/projects/p1/worktree-config': () => worktreeStatus,
      'GET /api/projects/p1/container-preview': () => containerPreviewOptions,
      'POST /api/projects/p1/container-preview/diff': () => ({
        content: 'version: 1\n',
        diff: '+preview:\n+  service: web\n',
        baseSha256: 'a'.repeat(64),
      }),
      'GET /api/projects/p1/ssh-key': () => projectSshKey,
      'GET /api/forge/accounts': () => accounts,
      'POST /api/projects/preview': () => previewData,
      'GET /api/workspaces/folders': () => ({ folders: [] }),
      'GET /api/factory/settings': () => ({
        selfHealingBuildGate: true,
        antiSlopGate: true,
        secretGuardGate: true,
        crossProviderCritic: false,
        autoSyncToMain: true,
        requireCompletionSignal: true,
        personaRoutes: {},
      }),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  installRoutes();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  sessionStorage.clear();
});

describe('AC-6.5 Project settings and Wizard summary density budget (at most 75% of 0.9.3 words)', () => {
  it('keeps ProjectSettingsPage default view at or below 75% of 0.9.3 words', async () => {
    const view = await renderDom(createElement(ProjectSettingsPage, { projectId: 'p1' }), {
      path: '/projects/p1/settings',
    });
    await waitFor(() => expect(view.container.textContent).toContain('Self-healing build'));
    await waitFor(() => expect(view.container.textContent).toContain('https://github.com/alice/shop.git'));
    await waitFor(() => expect(view.container.textContent).toContain('SHA256:shared'));

    const words = visibleWordCount(view.container);
    const budget = Math.floor(
      PROJECT_SETUP_093_BASELINE_WORDS.projectSettingsPage * PROJECT_SETUP_WORD_BUDGET_RATIO,
    );
    expect(words).toBeLessThanOrEqual(budget);
  });

  it('keeps the wizard StepSummary default view at or below 75% of 0.9.3 words', async () => {
    const summaryState = makeSummaryWizardState();
    const view = await renderDom(
      createElement(StepSummary, {
        state: summaryState,
        dispatch: () => undefined,
        preview: {
          preview: { kind: 'new', data: previewData },
          ready: true,
          error: null,
          loading: false,
        },
        onEdit: () => undefined,
      }),
    );

    const words = visibleWordCount(view.container);
    const budget = Math.floor(
      PROJECT_SETUP_093_BASELINE_WORDS.wizardSummaryStep * PROJECT_SETUP_WORD_BUDGET_RATIO,
    );
    expect(words).toBeLessThanOrEqual(budget);
  });
});

describe('Project settings and Wizard interactive flows and disclosures', () => {
  it('renders PageHeader and all 5 sections, toggles gates, opens repository editors and Danger zone', async () => {
    const gatePatches: unknown[] = [];
    const repoPatches: unknown[] = [];
    installRoutes({
      'PATCH /api/projects/p1/settings': (body) => {
        gatePatches.push(body);
        return gateSettings;
      },
      'PATCH /api/projects/p1/repository': (body) => {
        repoPatches.push(body);
        return repoStatus;
      },
    });

    const view = await renderDom(createElement(ProjectSettingsPage, { projectId: 'p1' }), {
      path: '/projects/p1/settings',
    });
    await waitFor(() => expect(view.container.textContent).toContain('Self-healing build'));
    await waitFor(() => expect(view.container.textContent).toContain('https://github.com/alice/shop.git'));

    // PageHeader has single h1 and project name meta without an eyebrow
    expect(view.container.querySelectorAll('h1')).toHaveLength(1);
    expect(view.container.querySelector('h1')?.textContent).toBe('Project settings');
    expect(view.container.querySelector('.eyebrow')).toBeNull();

    // All 5 sections exist
    const headings = [...view.container.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Repository', 'Gates', 'Worktree config', 'Container preview', 'Danger zone']);

    // Toggle a gate switch
    const selfHealSwitch = view.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Self-healing build"]',
    )!;
    await click(selfHealSwitch);
    await waitFor(() => expect(gatePatches).toEqual([{ gates: { selfHealingBuildGate: false } }]));

    // Edit commit identity row
    await click(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Edit commit identity"]')!,
    );
    expect(view.container.textContent).toContain('Use for this project');

    // Edit push target row
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Edit push target"]')!);
    expect(view.container.textContent).toContain('Keep pushed pushes to');

    // Danger zone opens ProjectDeleteConfirm and cancels cleanly
    await click(getButton('Remove project', view.container));
    expect(view.container.textContent).toContain('Remove “Shop”?');
    await click(getButton('Cancel', view.container));
    expect(view.container.textContent).not.toContain('Remove “Shop”?');
  });

  it('expands disclosures and Edit links in StepSummary and preserves Playwright wizard selectors', async () => {
    const editedSteps: string[] = [];
    const summaryState = makeSummaryWizardState();
    const summaryView = await renderDom(
      createElement(StepSummary, {
        state: summaryState,
        dispatch: () => undefined,
        preview: {
          preview: { kind: 'new', data: previewData },
          ready: true,
          error: null,
          loading: false,
        },
        onEdit: (step) => editedSteps.push(step),
      }),
    );

    // Edit links jump back to type, stack and factory steps
    await click(summaryView.container.querySelector<HTMLButtonElement>('button[aria-label="Edit project"]')!);
    await click(summaryView.container.querySelector<HTMLButtonElement>('button[aria-label="Edit stack"]')!);
    await click(summaryView.container.querySelector<HTMLButtonElement>('button[aria-label="Edit factory"]')!);
    expect(editedSteps).toEqual(['type', 'stack', 'factory']);

    // Preview files disclosure reveals the generated file tabs
    expect(summaryView.container.textContent).not.toContain('# Shop');
    await click(getButton('Preview files', summaryView.container));
    expect(summaryView.container.textContent).toContain('# Shop');
    await cleanup();

    // Verify Playwright selectors on ProjectWizard for importing a Git URL
    installRoutes({
      'POST /api/projects': () => ({
        project: { ...project, id: 'p2', importSource: 'url' },
        terminalId: 't1',
      }),
      'GET /api/projects/p2/import-status': () => ({
        status: 'ready',
        exitCode: 0,
        terminalId: 't1',
        tail: '',
      }),
      'GET /api/projects/p2/detect': () => ({
        detected: {
          appType: 'web',
          choices: {},
          files: { projectMd: true, claudeMd: false, worktreeYml: false, agentsMd: false },
          worktreeYml: null,
        },
        suggestions: { claudeMd: '# Claude\n' },
      }),
      'POST /api/projects/p2/adopt/preview': () => ({
        files: { 'CLAUDE.md': '# Claude\n' },
        ignored: [],
        commitMessage: 'Add Emberline project files',
      }),
    });

    const wizardView = await renderDom(
      createElement(ProjectWizard, {
        open: true,
        runnerDown: false,
        onClose: () => undefined,
        onCreated: () => undefined,
        onProjectsChanged: () => undefined,
      }),
    );

    const dialog = wizardView.container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h3')?.textContent).toBe('Start');

    const importLabel = [...dialog.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Import a Git URL'),
    )!;
    await click(importLabel.querySelector('input')!);
    await click(getButton('Next', dialog.querySelector('footer')!));

    expect(dialog.querySelector('h3')?.textContent).toBe('Repository');
    const urlInput = dialog.querySelector<HTMLInputElement>('#wizard-repo-url')!;
    await typeInto(urlInput, 'https://github.com/alice/shop.git');
    await click(getButton('Clone', dialog.querySelector('footer')!));

    await waitFor(() => expect(dialog.querySelector('h3')?.textContent).toBe('Stack'));
    await click(getButton('Next', dialog.querySelector('footer')!));

    expect(dialog.querySelector('h3')?.textContent).toBe('Factory');
    const importOnlyLabel = [...dialog.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Import only'),
    )!;
    const importOnlyInput = importOnlyLabel.querySelector('input')!;
    expect(importOnlyInput.checked).toBe(true);
    await click(getButton('Next', dialog.querySelector('footer')!));

    expect(dialog.querySelector('h3')?.textContent).toBe('Summary');
    await waitFor(() =>
      expect(getButton('Finish import', dialog.querySelector('footer')!).disabled).toBe(false),
    );
  });

  it('enforces token-only colours, >= 0.8rem font sizes, zero inline styles and < 450 lines in target files', () => {
    for (const cssRel of ['components/project-settings-ux.css', 'components/wizard/wizard-ux.css']) {
      const css = readFileSync(resolve(HERE, cssRel), 'utf8');
      expect(css, `${cssRel} must not contain hardcoded hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, `${cssRel} must not contain px font-size`).not.toMatch(/font-size:\s*[0-9.]+px/);
      const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const rem of fontSizes) {
        expect(rem).toBeGreaterThanOrEqual(0.8);
      }
    }

    const targetFiles = [
      'pages/ProjectSettingsPage.tsx',
      'components/ProjectSettingsPanel.tsx',
      'components/projectSettings/ProjectGatesSection.tsx',
      'components/projectSettings/WorktreeConfigSection.tsx',
      'components/projectSettings/ProjectDangerSection.tsx',
      'components/projectSettings/RepositoryRemoteForms.tsx',
      'components/RepositoryPanel.tsx',
      'components/RepositoryCommitIdentity.tsx',
      'components/RepositoryPushTarget.tsx',
      'components/ProjectSshKey.tsx',
      'components/HostKeyTrust.tsx',
      'components/ImportRecovery.tsx',
      'components/ContainerPreviewBox.tsx',
      'components/WorktreeEditor.tsx',
      'components/ProjectDeleteConfirm.tsx',
      'components/wizard/WizardShell.tsx',
      'components/wizard/WizardChrome.tsx',
      'components/wizard/ImportProgress.tsx',
      'components/wizard/ImportSshHelp.tsx',
      'components/wizard/StepSummary.tsx',
      'components/wizard/SummaryFilesSection.tsx',
      'components/wizard/StepStart.tsx',
      'components/wizard/StepType.tsx',
      'components/wizard/StepStack.tsx',
      'components/wizard/StepFactory.tsx',
      'components/wizard/ReferenceMaterial.tsx',
      'components/wizard/MaterialList.tsx',
      'components/wizard/RepoSshKey.tsx',
    ];
    for (const rel of targetFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});

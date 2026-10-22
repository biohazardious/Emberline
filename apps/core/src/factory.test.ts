import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decoratePromptWithPersona, PERSONA_CATALOG } from '@emberline/adapter-claude';
import { GitBranchName } from '@emberline/protocol';
import type {
  ActiveProjectPreference,
  CreateProjectResponse,
  FactorySettings,
  ProjectBlueprintResponse,
  ProjectCheckpoint,
  ProjectRecommendation,
  ProjectStatusSummary,
  TaskTemplate,
  Ticket,
  WorkspaceFileContentResponse,
  WorkspaceFileListResponse,
} from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db/index.js';
import { auditWorktreeSlop } from './factory/service.js';
import { getProviderEnvFromSettings, updateFactorySettings } from './factory/settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('AI Coding Factory (F1–F4)', () => {
  it('decorates non-coder prompts with specialist persona instructions', () => {
    expect(decoratePromptWithPersona('Build login page', 'coder')).toBe('Build login page');
    const qaPrompt = decoratePromptWithPersona('Verify login edge cases', 'qa');
    expect(qaPrompt).toContain(PERSONA_CATALOG.qa.roleTitle);
    expect(qaPrompt).toContain('Verify login edge cases');
  });

  it('creates a wizard project with PROJECT.md, CLAUDE.md, git init, starter tickets, and active project persistence', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const headers = authHeaders(cookie);

    const createRes = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        name: 'Pulse Analytics',
        mode: 'wizard',
        appType: 'web_saas',
        description: 'Real-time product analytics SaaS for engineering teams.',
        techStack: {
          language: 'TypeScript',
          frontend: 'React 19',
          backend: 'Fastify',
          database: 'PostgreSQL + Drizzle',
          styling: 'Tailwind CSS',
          testing: 'Vitest + Playwright',
        },
        architectureNotes: 'Keep ingestion and query modules decoupled.',
        referenceDocs: '### Spec\nEvents endpoint accepts batched JSON payloads.',
        initGit: true,
        seedStarterTickets: true,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { project } = createRes.json() as CreateProjectResponse;
    expect(project.slug).toBe('pulse-analytics');
    expect(project.appType).toBe('web_saas');
    expect(project.techStack?.database).toBe('PostgreSQL + Drizzle');

    // Verify PROJECT.md, CLAUDE.md, and .git were created on disk
    expect(existsSync(path.join(project.path, 'PROJECT.md'))).toBe(true);
    expect(existsSync(path.join(project.path, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(project.path, '.git'))).toBe(true);
    const onDiskBlueprint = readFileSync(path.join(project.path, 'PROJECT.md'), 'utf8');
    expect(onDiskBlueprint).toContain('Pulse Analytics');
    expect(onDiskBlueprint).toContain('PostgreSQL + Drizzle');
    expect(onDiskBlueprint).toContain('Keep ingestion and query modules decoupled.');

    // Verify active project preference was persisted automatically
    const activeRes = await t.app.inject({ url: '/api/projects/active', headers: { cookie } });
    expect(activeRes.statusCode).toBe(200);
    expect((activeRes.json() as ActiveProjectPreference).activeProjectId).toBe(project.id);

    // Verify 4 starter tickets were seeded with specialist personas
    const ticketsRes = await t.app.inject({
      url: `/api/projects/${project.id}/tickets`,
      headers: { cookie },
    });
    expect(ticketsRes.statusCode).toBe(200);
    const seeded = ticketsRes.json() as Ticket[];
    expect(seeded).toHaveLength(4);
    expect(
      seeded
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((tk) => tk.persona),
    ).toEqual(['product_owner', 'architect', 'coder', 'qa']);

    // Verify blueprint GET & PUT endpoints
    const bpGet = await t.app.inject({
      url: `/api/projects/${project.id}/blueprint`,
      headers: { cookie },
    });
    expect(bpGet.statusCode).toBe(200);
    const bpData = bpGet.json() as ProjectBlueprintResponse;
    expect(bpData.exists).toBe(true);
    expect(bpData.content).toContain('Pulse Analytics');

    const bpPut = await t.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/blueprint`,
      headers,
      payload: {
        content:
          '# Updated Blueprint\n\nCustom updated content for Pulse Analytics with more than eighty characters so advisor sees a complete spec.',
      },
    });
    expect(bpPut.statusCode).toBe(200);
    expect((bpPut.json() as ProjectBlueprintResponse).content).toContain('# Updated Blueprint');

    // Verify Smart Project Advisor recommendations
    const recsRes = await t.app.inject({
      url: `/api/projects/${project.id}/recommendations`,
      headers: { cookie },
    });
    expect(recsRes.statusCode).toBe(200);
    const recs = recsRes.json() as ProjectRecommendation[];
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some((r) => r.id === 'dispatch-next-ticket')).toBe(true);

    // Faz F9: Checkpoints list on git-initialized wizard project
    const checkpointsRes = await t.app.inject({
      url: `/api/projects/${project.id}/checkpoints`,
      headers: { cookie },
    });
    expect(checkpointsRes.statusCode).toBe(200);
    const checkpoints = checkpointsRes.json() as ProjectCheckpoint[];
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints[0]?.subject).toContain('chore: initialize project blueprint');
  });

  it('serves ready-made task templates and supports manual project seeding & switching', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const headers = authHeaders(cookie);

    const tplRes = await t.app.inject({ url: '/api/factory/templates', headers: { cookie } });
    expect(tplRes.statusCode).toBe(200);
    const templates = tplRes.json() as TaskTemplate[];
    expect(templates.length).toBeGreaterThanOrEqual(7);
    expect(templates.some((tp) => tp.persona === 'dba')).toBe(true);
    expect(templates.some((tp) => tp.persona === 'security')).toBe(true);

    // Create a blank manual project without starter tickets
    const p1Res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Blank Service', mode: 'manual', seedStarterTickets: false },
    });
    const p1 = (p1Res.json() as CreateProjectResponse).project;
    // Runs need git for worktrees and review, so manual projects get a repository too.
    expect(existsSync(path.join(p1.path, '.git'))).toBe(true);

    // Advisor should recommend creating PROJECT.md and seeding starter backlog
    const recsBefore = (
      await t.app.inject({ url: `/api/projects/${p1.id}/recommendations`, headers: { cookie } })
    ).json() as ProjectRecommendation[];
    expect(recsBefore.some((r) => r.id === 'create-blueprint')).toBe(true);
    expect(recsBefore.some((r) => r.id === 'seed-starter-backlog')).toBe(true);

    // Seed tickets on demand via POST /api/projects/:id/seed-tickets
    const seedRes = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${p1.id}/seed-tickets`,
      headers,
      payload: {},
    });
    expect(seedRes.statusCode).toBe(200);
    expect((seedRes.json() as Ticket[]).length).toBe(4);

    // Create a second project and switch back to p1 via PUT /api/projects/active
    const p2Res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Second App' },
    });
    const p2 = (p2Res.json() as CreateProjectResponse).project;
    expect(
      (
        (
          await t.app.inject({ url: '/api/projects/active', headers: { cookie } })
        ).json() as ActiveProjectPreference
      ).activeProjectId,
    ).toBe(p2.id);

    const switchRes = await t.app.inject({
      method: 'PUT',
      url: '/api/projects/active',
      headers,
      payload: { activeProjectId: p1.id },
    });
    expect(switchRes.statusCode).toBe(200);
    expect((switchRes.json() as ActiveProjectPreference).activeProjectId).toBe(p1.id);

    // Create a compiled dist/index.html bundle inside p1's workspace and verify status + demo serving
    const distDir = path.join(p1.path, 'dist', 'assets');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      path.join(p1.path, 'dist', 'index.html'),
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><h1>Flappy Demo</h1></body></html>',
    );
    writeFileSync(path.join(distDir, 'app.js'), 'console.log("flappy ready");');

    const statusRes = await t.app.inject({
      url: `/api/projects/${p1.id}/status`,
      headers: { cookie },
    });
    expect(statusRes.statusCode).toBe(200);
    const status = statusRes.json() as ProjectStatusSummary;
    expect(status.ticketCounts.total).toBe(4);
    expect(status.targets[0]?.demoEntryRelPath).toBe('dist/index.html');
    expect(status.targets[0]?.demoUrl).toBe(`/api/projects/${p1.id}/demo/main/`);

    const demoRedirect = await t.app.inject({
      url: `/api/projects/${p1.id}/demo/main/`,
      headers: { cookie },
    });
    expect(demoRedirect.statusCode).toBe(302);
    const demoBase = String(demoRedirect.headers.location);
    expect(demoBase).toMatch(/^\/api\/demo\/[\w-]+\.[\w-]+\/$/);

    const demoHtmlRes = await t.app.inject({ url: demoBase });
    expect(demoHtmlRes.statusCode).toBe(200);
    expect(demoHtmlRes.headers['content-type']).toContain('text/html');
    expect(demoHtmlRes.body).toContain(`<base href="${demoBase}">`);
    expect(demoHtmlRes.body).toContain('src="./assets/app.js"');
    expect(demoHtmlRes.body).toContain('emberline:demo-error');

    const demoJsRes = await t.app.inject({ url: `${demoBase}assets/app.js` });
    expect(demoJsRes.statusCode).toBe(200);
    expect(demoJsRes.headers['content-type']).toContain('application/javascript');
    expect(demoJsRes.body).toContain('flappy ready');

    // Verify agent self-task delegation (PO creating specialist tickets for coder & ui_ux)
    const delegateRes = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${p2.id}/delegate-tickets`,
      headers,
      payload: {
        autoDispatch: false,
        tickets: [
          {
            title: 'Backend: Implement score counter engine & persistence',
            persona: 'coder',
            priority: 3,
            body: 'Track score increments when passing pipes.',
          },
          {
            title: 'UI/UX: Design score counter HUD overlay',
            persona: 'ui_ux',
            priority: 2,
            body: 'Render score badge and animations.',
          },
        ],
      },
    });
    expect(delegateRes.statusCode).toBe(201);
    const delegated = delegateRes.json() as Ticket[];
    expect(delegated).toHaveLength(2);
    expect(delegated.map((tk) => tk.persona)).toEqual(['coder', 'ui_ux']);
    expect(delegated.every((tk) => tk.status === 'ready')).toBe(true);

    // Phase F7 & F10: Factory Settings (Theme, Auto-Pilot, Multi-Provider Persona Routing)
    const getSettingsRes = await t.app.inject({
      url: '/api/factory/settings',
      headers: { cookie },
    });
    expect(getSettingsRes.statusCode).toBe(200);
    const initialSettings = getSettingsRes.json() as FactorySettings;
    expect(initialSettings.theme).toBe('dark');
    expect(initialSettings.autoPickupReady).toBe(true);

    const patchSettingsRes = await t.app.inject({
      method: 'PATCH',
      url: '/api/factory/settings',
      headers,
      payload: {
        theme: 'light',
        autoPickupBacklog: true,
        personaAgents: {
          ui_ux: 'gemini',
          coder: 'claude',
        },
        geminiApiKey: 'test-gemini-key-123',
      },
    });
    expect(patchSettingsRes.statusCode).toBe(200);
    const updatedSettings = patchSettingsRes.json() as FactorySettings;
    expect(updatedSettings.theme).toBe('light');
    expect(updatedSettings.autoPickupBacklog).toBe(true);
    expect(updatedSettings.personaAgents.ui_ux).toBe('gemini');
    expect(updatedSettings.geminiKeyConfigured).toBe(true);

    // Phase F8: Code Explorer file tree, read, write, and delete APIs
    const writeFileRes = await t.app.inject({
      method: 'PUT',
      url: `/api/projects/${p1.id}/files/content`,
      headers,
      payload: {
        targetId: 'main',
        path: 'src/scoreCounter.ts',
        content: 'export const incrementScore = (s: number) => s + 1;\n',
      },
    });
    expect(writeFileRes.statusCode).toBe(200);

    const readFileRes = await t.app.inject({
      url: `/api/projects/${p1.id}/files/content?targetId=main&path=src%2FscoreCounter.ts`,
      headers: { cookie },
    });
    expect(readFileRes.statusCode).toBe(200);
    expect((readFileRes.json() as WorkspaceFileContentResponse).content).toContain('incrementScore');

    const listFilesRes = await t.app.inject({
      url: `/api/projects/${p1.id}/files?targetId=main`,
      headers: { cookie },
    });
    expect(listFilesRes.statusCode).toBe(200);
    const fileList = listFilesRes.json() as WorkspaceFileListResponse;
    expect(fileList.entries.some((f) => f.path === 'src/scoreCounter.ts')).toBe(true);

    const deleteFileRes = await t.app.inject({
      method: 'DELETE',
      url: `/api/projects/${p1.id}/files`,
      headers,
      payload: { targetId: 'main', path: 'src/scoreCounter.ts' },
    });
    expect(deleteFileRes.statusCode).toBe(200);

    // Phase F12 & F13: Anti-AI-Slop + Pre-Commit Secret & Credential Guard
    expect(updatedSettings.mcpServers.length).toBeGreaterThanOrEqual(4);
    expect(updatedSettings.skillPlugins.length).toBeGreaterThanOrEqual(4);
    expect(updatedSettings.secretGuardGate).toBe(true);

    const slopFile = path.join(p1.path, 'src', 'slopExample.tsx');
    mkdirSync(path.dirname(slopFile), { recursive: true });
    writeFileSync(
      slopFile,
      [
        'export function BadCard(props: any) {',
        '  // TODO: implement real handler later',
        '  console.log("debug card", props);',
        '  return <div style={{ background: "linear-gradient(135deg, #6366f1, #ec4899)" }} />;',
        '}',
      ].join('\n'),
      'utf8',
    );
    const slopReport = await auditWorktreeSlop({
      runId: 'test-run-slop',
      workspacePath: p1.path,
    });
    expect(slopReport.passed).toBe(false);
    expect(slopReport.secretGuardPassed).toBe(true);
    expect(slopReport.errorCount).toBeGreaterThanOrEqual(2);
    expect(slopReport.issues.map((i) => i.category)).toEqual(
      expect.arrayContaining(['type_evasion', 'unfinished_stub', 'debug_leftover', 'vibe_ui_cliche']),
    );
    expect(slopReport.autoFixPrompt).toContain('Anti-AI-Slop & Code Hygiene Gate');

    // Verify Pre-Commit Secret & Credential Guard detects leaked keys and redacts the secret in snippet
    writeFileSync(
      path.join(p1.path, '.env'),
      'OPENAI_API_KEY="sk-proj-1234567890abcdefghijklmnop"\n', // gitleaks:allow (fake key)
      'utf8',
    );
    const secretReport = await auditWorktreeSlop({
      runId: 'test-run-secret',
      workspacePath: p1.path,
    });
    expect(secretReport.passed).toBe(false);
    expect(secretReport.secretGuardPassed).toBe(false);
    expect(secretReport.secretLeakCount).toBeGreaterThanOrEqual(1);
    const leakIssue = secretReport.issues.find(
      (i) => i.category === 'secret_leak' && i.snippet.includes('REDACTED'),
    );
    expect(leakIssue).toBeDefined();
    expect(leakIssue?.snippet).not.toContain('1234567890abcdefghijklmnop');
    expect(secretReport.autoFixPrompt).toContain('PRE-COMMIT SECRET & CREDENTIAL GUARD BLOCK');
  });

  it('gives each agent only the API keys it needs (S14)', () => {
    const { db, close } = openDb(':memory:');
    try {
      updateFactorySettings(db, {
        anthropicApiKey: 'sk-ant-test',
        openaiApiKey: 'sk-openai-test',
        geminiApiKey: 'gem-test',
      });
      expect(getProviderEnvFromSettings(db, 'claude')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test' });
      expect(getProviderEnvFromSettings(db, 'codex')).toEqual({ OPENAI_API_KEY: 'sk-openai-test' });
      expect(getProviderEnvFromSettings(db, 'antigravity')).toEqual({
        GEMINI_API_KEY: 'gem-test',
        GOOGLE_API_KEY: 'gem-test',
      });
      expect(Object.keys(getProviderEnvFromSettings(db, 'aider')).sort()).toEqual([
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'OPENAI_API_KEY',
      ]);
      expect(getProviderEnvFromSettings(db, 'copilot')).toEqual({});
      expect(getProviderEnvFromSettings(db, 'unknown-agent')).toEqual({});
    } finally {
      close();
    }
  });

  it('accepts only branch names that git cannot read as options (S19)', () => {
    for (const ok of ['main', 'release/1.2', 'feature/a_b-c', 'v1.0']) {
      expect(GitBranchName.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['-x', '--output=x', 'a..b', 'a//b', 'a/', '.hidden', 'a/.b', 'x.lock', 'a b', '']) {
      expect(GitBranchName.safeParse(bad).success).toBe(false);
    }
  });
});

describe('dependency-aware PO prompt', () => {
  it('orders work with ref/dependsOn instead of persona priorities', async () => {
    const { buildFactoryOrchestratorPrompt } = await import('./factory/orchestration.js');
    const prompt = buildFactoryOrchestratorPrompt('Build an APK', true, '', 4);
    expect(prompt).toContain('"ref"');
    expect(prompt).toContain('"dependsOn"');
    for (const ref of ['brand-assets', 'android-shell', 'apk-build']) expect(prompt).toContain(ref);
    expect(prompt).toContain(
      'Emberline starts each ticket as soon as every ticket it depends on is merged into main, up to 4 tickets of this project at once; tickets without dependencies start right away.',
    );
    expect(prompt).not.toContain('Priority 3 - High');
    expect(prompt).toContain('Order the work');
    expect(prompt).toContain('Autonomous Execution Rule');
    expect(prompt).toContain(
      'priority (0–3) only breaks ties between tickets that are ready at the same time',
    );
    expect(prompt).toContain(
      'lowercase letters, digits and hyphens, start with a letter or digit, up to 40 characters',
    );
    expect(prompt).toContain('up to 10 `dependsOn` entries');
    expect(prompt).toContain('e.g. `MPG-12`');
  });

  it('defaults the prompt to the default parallel ticket limit', async () => {
    const { buildFactoryOrchestratorPrompt } = await import('./factory/orchestration.js');
    expect(buildFactoryOrchestratorPrompt('Build an APK')).toContain(
      'up to 2 tickets of this project at once',
    );
  });

  it('blueprint instructions no longer promise sequential dispatch', async () => {
    const { generateClaudeInstructions } = await import('./factory/blueprint.js');
    const text = generateClaudeInstructions('Demo');
    expect(text).not.toContain('sequentially');
    expect(text).toContain('"ref"');
    expect(text).toContain('"dependsOn"');
    expect(text).toContain('The `[Factory]` ticket (`product_owner`) plans the project');
    expect(text).toContain('only when its own ticket asks for a follow-up');
    expect(text).not.toContain('When acting as `product_owner` or `architect`');
  });
});

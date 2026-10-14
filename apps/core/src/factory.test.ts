import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decoratePromptWithPersona, PERSONA_CATALOG } from '@emberline/adapter-claude';
import type {
  ActiveProjectPreference,
  CreateProjectResponse,
  ProjectBlueprintResponse,
  ProjectRecommendation,
  TaskTemplate,
  Ticket,
} from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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
    const headers = { ...CSRF, cookie };

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
      payload: { content: '# Updated Blueprint\n\nCustom updated content for Pulse Analytics with more than eighty characters so advisor sees a complete spec.' },
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
  });

  it('serves ready-made task templates and supports manual project seeding & switching', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const headers = { ...CSRF, cookie };

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
      ((await t.app.inject({ url: '/api/projects/active', headers: { cookie } })).json() as ActiveProjectPreference)
        .activeProjectId,
    ).toBe(p2.id);

    const switchRes = await t.app.inject({
      method: 'PUT',
      url: '/api/projects/active',
      headers,
      payload: { activeProjectId: p1.id },
    });
    expect(switchRes.statusCode).toBe(200);
    expect((switchRes.json() as ActiveProjectPreference).activeProjectId).toBe(p1.id);
  });
});

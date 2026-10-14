import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ActiveProjectPreference,
  CreateProjectBody,
  type CreateProjectResponse,
  type Project,
  type ProjectAppType,
  type ProjectBlueprintResponse,
  type ProjectRecommendation,
  type ProjectTechStack,
  type TaskTemplate,
  type Ticket,
  UpdateProjectBlueprintBody,
} from '@emberline/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects, settings } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  computeProjectRecommendations,
  generateClaudeInstructions,
  generateProjectBlueprint,
  initLocalGitRepository,
  readProjectBlueprint,
  seedStarterTickets,
  TASK_TEMPLATES,
  writeProjectBlueprint,
} from '../factory/service.js';
import type { CoreDeps } from '../server.js';

type ProjectRow = typeof projects.$inferSelect;

const ACTIVE_PROJECT_KEY = 'ui.activeProjectId';

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  repoUrl: row.repoUrl,
  defaultBranch: row.defaultBranch,
  path: row.path,
  appType: (row.appType as ProjectAppType) ?? 'custom',
  description: row.description ?? '',
  techStack: (row.techStack as ProjectTechStack | null) ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** Letters NFKD does not decompose into ASCII base + combining mark. */
const TRANSLITERATE: Record<string, string> = { ı: 'i', ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd', þ: 'th' };

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[ıßøæœłđþ]/g, (ch) => TRANSLITERATE[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function registerProjectRoutes(app: FastifyInstance, { db, config, ptyd, tickets, runs }: CoreDeps): void {
  const saveActiveProjectId = (activeProjectId: string | null) => {
    db.insert(settings)
      .values({ key: ACTIVE_PROJECT_KEY, value: { activeProjectId } })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { activeProjectId } },
      })
      .run();
  };

  app.get('/api/projects', async (): Promise<Project[]> =>
    db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(toProject),
  );

  app.get('/api/projects/active', async (): Promise<ActiveProjectPreference> => {
    const row = db.select().from(settings).where(eq(settings.key, ACTIVE_PROJECT_KEY)).get();
    const savedId =
      row && typeof row.value === 'object' && row.value && 'activeProjectId' in row.value
        ? ((row.value as { activeProjectId: string | null }).activeProjectId ?? null)
        : null;
    if (savedId && db.select().from(projects).where(eq(projects.id, savedId)).get()) {
      return { activeProjectId: savedId };
    }
    const first = db.select().from(projects).orderBy(asc(projects.createdAt)).get();
    return { activeProjectId: first?.id ?? null };
  });

  app.put('/api/projects/active', async (request): Promise<ActiveProjectPreference> => {
    const body = ActiveProjectPreference.parse(request.body);
    if (body.activeProjectId) {
      const exists = db.select().from(projects).where(eq(projects.id, body.activeProjectId)).get();
      if (!exists) throw notFound('no such project');
    }
    saveActiveProjectId(body.activeProjectId);
    return { activeProjectId: body.activeProjectId };
  });

  app.get('/api/factory/templates', async (): Promise<readonly TaskTemplate[]> => TASK_TEMPLATES);

  app.post('/api/projects', async (request, reply): Promise<CreateProjectResponse> => {
    const body = CreateProjectBody.parse(request.body);
    const slug = slugify(body.name);
    if (!slug) throw badRequest('name must contain at least one letter or digit');
    if (db.select().from(projects).where(eq(projects.slug, slug)).get()) {
      throw conflict(`a project with slug "${slug}" already exists`);
    }

    const id = randomUUID();
    const projectPath = path.join(config.workspacesDir, slug);
    let terminalId: string | null = null;

    if (body.repoUrl) {
      if (existsSync(projectPath)) throw conflict(`directory already exists: ${projectPath}`);
      // Clone inside the runner so it uses the runner's git credentials; the UI can watch it live.
      const session = await ptyd.get().spawn({
        file: 'git',
        args: ['clone', '--progress', '--', body.repoUrl, projectPath],
        cwd: config.workspacesDir,
        meta: { kind: 'clone', projectId: id, title: `git clone · ${body.name}` },
      });
      terminalId = session.id;
    } else {
      await mkdir(projectPath, { recursive: true });
      const shouldWriteBlueprint =
        body.mode === 'wizard' ||
        Boolean(body.description.trim()) ||
        Boolean(body.techStack) ||
        Boolean(body.architectureNotes?.trim()) ||
        Boolean(body.referenceDocs?.trim());
      if (shouldWriteBlueprint) {
        const blueprintContent = generateProjectBlueprint({
          name: body.name,
          appType: body.appType,
          description: body.description,
          techStack: body.techStack ?? null,
          architectureNotes: body.architectureNotes,
          referenceDocs: body.referenceDocs,
        });
        await writeFile(path.join(projectPath, 'PROJECT.md'), blueprintContent, 'utf8');
        await writeFile(path.join(projectPath, 'CLAUDE.md'), generateClaudeInstructions(body.name), 'utf8');
      }
      const shouldInitGit = body.initGit ?? body.mode === 'wizard';
      if (shouldInitGit) {
        await initLocalGitRepository(projectPath, body.defaultBranch);
      }
    }

    const row: ProjectRow = {
      id,
      name: body.name,
      slug,
      repoUrl: body.repoUrl ?? null,
      defaultBranch: body.defaultBranch,
      path: projectPath,
      appType: body.appType,
      description: body.description,
      techStack: body.techStack ?? null,
      createdAt: new Date(),
    };
    db.insert(projects).values(row).run();
    const project = toProject(row);

    saveActiveProjectId(project.id);

    if (body.seedStarterTickets) {
      seedStarterTickets(project, tickets);
    }

    reply.code(201);
    return { project, terminalId };
  });

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/blueprint',
    async (request): Promise<ProjectBlueprintResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      return readProjectBlueprint(toProject(row));
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/projects/:id/blueprint',
    async (request): Promise<ProjectBlueprintResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = UpdateProjectBlueprintBody.parse(request.body);
      await mkdir(row.path, { recursive: true });
      return writeProjectBlueprint(toProject(row), body.content);
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/seed-tickets', async (request): Promise<Ticket[]> => {
    const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
    if (!row) throw notFound('no such project');
    return seedStarterTickets(toProject(row), tickets);
  });

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/recommendations',
    async (request): Promise<ProjectRecommendation[]> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const project = toProject(row);
      const blueprint = await readProjectBlueprint(project);
      const projectTickets = tickets.list(project.id);
      const projectRuns = runs.list().filter((r) => r.projectId === project.id);
      return computeProjectRecommendations(project, blueprint, projectTickets, projectRuns);
    },
  );

  /** Removes the project record only; files in the workspace are left untouched on purpose. */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const result = db.delete(projects).where(eq(projects.id, request.params.id)).run();
    if (result.changes === 0) throw notFound('no such project');
    return { ok: true };
  });
}

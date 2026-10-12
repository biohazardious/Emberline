import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CreateProjectBody, type CreateProjectResponse, type Project } from '@emberline/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../server.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';

type ProjectRow = typeof projects.$inferSelect;

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  repoUrl: row.repoUrl,
  defaultBranch: row.defaultBranch,
  path: row.path,
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

export function registerProjectRoutes(app: FastifyInstance, { db, config, ptyd }: CoreDeps): void {
  app.get('/api/projects', async (): Promise<Project[]> =>
    db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(toProject),
  );

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
    }

    const row: ProjectRow = {
      id,
      name: body.name,
      slug,
      repoUrl: body.repoUrl ?? null,
      defaultBranch: body.defaultBranch,
      path: projectPath,
      createdAt: new Date(),
    };
    db.insert(projects).values(row).run();
    reply.code(201);
    return { project: toProject(row), terminalId };
  });

  /** Removes the project record only; files in the workspace are left untouched on purpose. */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const result = db.delete(projects).where(eq(projects.id, request.params.id)).run();
    if (result.changes === 0) throw notFound('no such project');
    return { ok: true };
  });
}

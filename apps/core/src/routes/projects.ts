import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ActiveProjectPreference,
  AgentCreateTicketsPayload,
  BrainstormRequestBody,
  type BrainstormResponse,
  BrowserActionBody,
  type BrowserViewportSnapshot,
  BuildDemoBody,
  type BuildDemoResponse,
  type ClaudeUsageTelemetry,
  CreateMilestoneBody,
  CreateProjectBody,
  type CreateProjectResponse,
  CreateRoadmapItemBody,
  DeleteWorkspaceFileBody,
  DispatchRoadmapItemsBody,
  type DispatchRoadmapItemsResponse,
  FactoryRequestBody,
  type FactoryRequestResponse,
  type FactorySettings,
  type Project,
  type ProjectAppType,
  type ProjectBlueprintResponse,
  type ProjectCheckpoint,
  type ProjectRecommendation,
  type ProjectRoadmapState,
  type ProjectStatusSummary,
  type ProjectTechStack,
  PROVIDER_REGISTRY,
  ProviderLoginBody,
  type ProviderLoginResponse,
  RollbackCheckpointBody,
  SyncWorktreeBody,
  type SyncWorktreeResponse,
  type TaskTemplate,
  type Ticket,
  UpdateFactorySettingsBody,
  UpdateProjectBlueprintBody,
  UpdateRoadmapItemBody,
  UploadWorkspaceFilesBody,
  type UploadWorkspaceFilesResponse,
  type WorkspaceFileContentResponse,
  type WorkspaceFileListResponse,
  WriteWorkspaceFileBody,
} from '@emberline/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { projects, settings } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { getRunnerBrowserState, getRunnerClaudeUsage, performRunnerBrowserAction } from '../factory/browser-daemon.js';
import {
  addRoadmapItem,
  addRoadmapMilestone,
  deleteRoadmapItem,
  dispatchRoadmapItems,
  getProjectRoadmap,
  runProjectBrainstorm,
  updateRoadmapItem,
} from '../factory/roadmap.js';
import {
  buildWorkspaceDemo,
  captureBrowserViewportSnapshot,
  computeProjectRecommendations,
  computeProjectStatusSummary,
  deleteWorkspaceFileEntry,
  exportProjectTarGz,
  generateClaudeInstructions,
  generateProjectBlueprint,
  getFactorySettings,
  initLocalGitRepository,
  listProjectCheckpoints,
  listWorkspaceFilesFlat,
  readProjectBlueprint,
  readWorkspaceFileContent,
  readWorkspaceFileRaw,
  rollbackProjectCheckpoint,
  seedStarterTickets,
  serveWorkspaceDemoAsset,
  syncWorktreeToMainWorkspace,
  TASK_TEMPLATES,
  updateFactorySettings,
  uploadWorkspaceFiles,
  writeProjectBlueprint,
  writeWorkspaceFileContent,
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

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/status',
    async (request): Promise<ProjectStatusSummary> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const project = toProject(row);
      const projectTickets = tickets.list(project.id);
      const projectRuns = runs.list().filter((r) => r.projectId === project.id);
      return computeProjectStatusSummary({
        project,
        tickets: projectTickets,
        runs: projectRuns,
        autoChainActive: tickets.isAutoChainActive(project.id),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/factory-request',
    async (request, reply): Promise<FactoryRequestResponse> => {
      const body = FactoryRequestBody.parse(request.body);
      const result = await tickets.submitFactoryRequest(request.params.id, body);
      reply.code(201);
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/delegate-tickets',
    async (request, reply): Promise<Ticket[]> => {
      const body = AgentCreateTicketsPayload.parse(request.body);
      const created = await tickets.createDelegatedTickets(request.params.id, body);
      reply.code(201);
      return created;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/run-pipeline',
    async (request) => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      tickets.setAutoChain(row.id, true);
      const started = await tickets.dispatchNextReadyTicket(row.id);
      return {
        ok: true,
        autoChainActive: tickets.isAutoChainActive(row.id),
        started,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/sync-worktree',
    async (request): Promise<SyncWorktreeResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const project = toProject(row);
      const body = SyncWorktreeBody.parse(request.body);
      const run = runs.get(body.runId);
      if (!run || run.projectId !== project.id) throw notFound('no such run for this project');
      const ticket = run.ticketId ? tickets.get(run.ticketId) : null;
      return syncWorktreeToMainWorkspace({
        worktreePath: run.worktreePath,
        mainWorkspacePath: project.path,
        ticketKey: ticket?.key ?? null,
        runId: run.id,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/build-demo',
    async (request): Promise<BuildDemoResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const project = toProject(row);
      const body = BuildDemoBody.parse(request.body ?? {});
      let workspacePath = project.path;
      if (body.targetId !== 'main') {
        const run = runs.get(body.targetId);
        if (!run || run.projectId !== project.id) throw notFound('no such run target for this project');
        workspacePath = run.worktreePath;
      }
      return buildWorkspaceDemo({
        projectId: project.id,
        targetId: body.targetId,
        workspacePath,
      });
    },
  );

  const handleDemoRequest = async (
    projectId: string,
    targetId: string,
    subPath: string,
    reply: FastifyReply,
  ) => {
    const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    const project = toProject(row);
    let workspacePath = project.path;
    if (targetId !== 'main') {
      const run = runs.get(targetId);
      if (!run || run.projectId !== project.id) throw notFound('no such run target');
      workspacePath = run.worktreePath;
    }
    const demoBaseHref = `/api/projects/${project.id}/demo/${targetId}/`;
    const result = await serveWorkspaceDemoAsset({
      workspacePath,
      demoBaseHref,
      subPath,
    });
    reply.code(result.status).header('content-type', result.contentType).send(result.body);
  };

  app.get<{ Params: { id: string; targetId: string } }>(
    '/api/projects/:id/demo/:targetId',
    async (request, reply) => {
      return handleDemoRequest(request.params.id, request.params.targetId, '', reply);
    },
  );

  app.get<{ Params: { id: string; targetId: string; '*': string } }>(
    '/api/projects/:id/demo/:targetId/*',
    async (request, reply) => {
      return handleDemoRequest(request.params.id, request.params.targetId, request.params['*'] ?? '', reply);
    },
  );

  app.get('/api/factory/settings', async (): Promise<FactorySettings> => getFactorySettings(db));

  app.patch('/api/factory/settings', async (request): Promise<FactorySettings> => {
    const patch = UpdateFactorySettingsBody.parse(request.body ?? {});
    return updateFactorySettings(db, patch);
  });

  app.post('/api/factory/provider-login', async (request, reply): Promise<ProviderLoginResponse> => {
    const body = ProviderLoginBody.parse(request.body ?? {});
    const provider = body.provider;
    const entry = PROVIDER_REGISTRY[provider];

    // Automatically enable this provider so it appears in routing selectors immediately
    const current = getFactorySettings(db);
    if (!current.enabledProviders.includes(provider)) {
      updateFactorySettings(db, {
        enabledProviders: [...current.enabledProviders, provider],
      });
    }

    const loginSpecs: Record<
      typeof provider,
      { cmd: string; instructions: string }
    > = {
      claude: {
        cmd: 'claude login',
        instructions:
          'Follow the Anthropic OAuth URL in the terminal to sign in with your Claude subscription.',
      },
      antigravity: {
        cmd: 'agy login',
        instructions:
          'Select "Login with Google" in the terminal and open the OAuth URL to sign in with your Google/Gemini account (no API key required).',
      },
      gemini: {
        cmd: 'gemini',
        instructions:
          'Select "Login with Google" in the terminal and open the OAuth URL to sign in with your Google/Gemini account (no API key required).',
      },
      codex: {
        cmd: 'codex login',
        instructions:
          'Follow the OpenAI OAuth URL in the terminal to sign in with your ChatGPT Plus/Pro/Team account.',
      },
      copilot: {
        cmd: 'copilot login',
        instructions:
          'Follow the GitHub device/OAuth prompt in the terminal to authenticate GitHub Copilot CLI.',
      },
      aider: {
        cmd: 'aider --version',
        instructions:
          'Aider uses your configured Anthropic, OpenAI, or Gemini credentials.',
      },
    };

    const spec = loginSpecs[provider];
    const shellScript = [
      `printf "\\033[1;36m=== ${entry.icon} ${entry.label} — Interactive Account Login ===\\033[0m\\n"`,
      `printf "${spec.instructions}\\n\\n"`,
      spec.cmd,
      `exec bash -i`,
    ].join('; ');

    const session = await ptyd.get().spawn({
      file: 'bash',
      args: ['-c', shellScript],
      cwd: config.workspacesDir,
      meta: {
        kind: 'shell',
        title: `🔑 Login · ${entry.shortLabel}`,
      },
    });

    reply.code(201);
    return {
      provider,
      terminal: {
        id: session.id,
        title: session.meta.title ?? `🔑 Login · ${entry.shortLabel}`,
        kind: 'shell',
        projectId: null,
        runId: null,
        status: session.status,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
      },
      command: spec.cmd,
      instructions: spec.instructions,
    };
  });

  app.get<{ Querystring: { refresh?: string } }>(
    '/api/factory/claude-usage',
    async (request): Promise<ClaudeUsageTelemetry> => {
      return getRunnerClaudeUsage({
        ptyd,
        socketDir: path.dirname(config.ptydSocket),
        forceRefresh: request.query.refresh === '1',
      });
    },
  );

  const resolveProjectTargetPath = (projectId: string, targetId = 'main'): { project: Project; workspacePath: string } => {
    const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    const project = toProject(row);
    if (!targetId || targetId === 'main') {
      return { project, workspacePath: project.path };
    }
    const run = runs.get(targetId);
    if (!run || run.projectId !== project.id) throw notFound('no such run target for this project');
    return { project, workspacePath: run.worktreePath };
  };

  app.get<{ Params: { id: string }; Querystring: { targetId?: string } }>(
    '/api/projects/:id/files',
    async (request): Promise<WorkspaceFileListResponse> => {
      const targetId = request.query.targetId ?? 'main';
      const { workspacePath } = resolveProjectTargetPath(request.params.id, targetId);
      const entries = await listWorkspaceFilesFlat(workspacePath);
      return {
        targetId,
        workspacePath,
        entries,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { targetId?: string; path?: string } }>(
    '/api/projects/:id/files/content',
    async (request): Promise<WorkspaceFileContentResponse> => {
      const targetId = request.query.targetId ?? 'main';
      const relPath = request.query.path;
      if (!relPath) throw badRequest('missing path query parameter');
      const { workspacePath } = resolveProjectTargetPath(request.params.id, targetId);
      try {
        return await readWorkspaceFileContent(workspacePath, targetId, relPath);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/projects/:id/files/content',
    async (request): Promise<WorkspaceFileContentResponse> => {
      const body = WriteWorkspaceFileBody.parse(request.body);
      const { workspacePath } = resolveProjectTargetPath(request.params.id, body.targetId);
      try {
        return await writeWorkspaceFileContent(workspacePath, body.targetId, body.path, body.content);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/projects/:id/files',
    async (request) => {
      const body = DeleteWorkspaceFileBody.parse(request.body);
      const { workspacePath } = resolveProjectTargetPath(request.params.id, body.targetId);
      try {
        await deleteWorkspaceFileEntry(workspacePath, body.path);
        return { ok: true };
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { targetId?: string; path?: string; inline?: string } }>(
    '/api/projects/:id/files/download',
    async (request, reply) => {
      const targetId = request.query.targetId ?? 'main';
      const relPath = request.query.path;
      if (!relPath) throw badRequest('missing path query parameter');
      const { workspacePath } = resolveProjectTargetPath(request.params.id, targetId);
      try {
        const raw = await readWorkspaceFileRaw(workspacePath, relPath);
        const safeName = raw.fileName.replace(/["\\\r\n]/g, '_');
        const disposition = request.query.inline === '1' ? 'inline' : 'attachment';
        return reply
          .header('content-type', raw.contentType)
          .header('content-length', String(raw.sizeBytes))
          .header('content-disposition', `${disposition}; filename="${safeName}"`)
          .send(raw.buffer);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/files/upload',
    async (request): Promise<UploadWorkspaceFilesResponse> => {
      const body = UploadWorkspaceFilesBody.parse(request.body);
      const { workspacePath } = resolveProjectTargetPath(request.params.id, body.targetId);
      try {
        return await uploadWorkspaceFiles(workspacePath, body.targetId, body.files);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/checkpoints',
    async (request): Promise<ProjectCheckpoint[]> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      return listProjectCheckpoints(row.path);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/rollback',
    async (request) => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = RollbackCheckpointBody.parse(request.body);
      try {
        return await rollbackProjectCheckpoint(row.path, body.sha);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/export.tar.gz',
    async (request, reply) => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const archive = await exportProjectTarGz(row.path);
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${row.slug}.tar.gz"`)
        .send(archive);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { targetId?: string } }>(
    '/api/projects/:id/browser-viewport',
    async (request): Promise<BrowserViewportSnapshot> => {
      const targetId = request.query.targetId ?? 'main';
      const { project } = resolveProjectTargetPath(request.params.id, targetId);
      const demoUrl = `http://localhost:${config.port}/api/projects/${project.id}/demo/${targetId}/`;
      const { actions: agentActions, agentActive } = runs.listBrowserAgentActions(project.id);
      const runnerSnap = await getRunnerBrowserState({
        ptyd,
        socketDir: path.dirname(config.ptydSocket),
        defaultUrl: demoUrl,
        agentActions,
        agentActive,
      });
      if (runnerSnap) return runnerSnap;
      const fallback = await captureBrowserViewportSnapshot({ targetUrl: demoUrl });
      return {
        ...fallback,
        agentActions,
        agentActive,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/browser-action',
    async (request): Promise<BrowserViewportSnapshot> => {
      const body = BrowserActionBody.parse(request.body);
      const targetId = body.targetId ?? 'main';
      const { project } = resolveProjectTargetPath(request.params.id, targetId);
      const demoUrl = `http://localhost:${config.port}/api/projects/${project.id}/demo/${targetId}/`;
      const { actions: agentActions, agentActive } = runs.listBrowserAgentActions(project.id);
      const runnerSnap = await performRunnerBrowserAction({
        ptyd,
        socketDir: path.dirname(config.ptydSocket),
        defaultUrl: demoUrl,
        actionBody: body,
        agentActions,
        agentActive,
      });
      if (runnerSnap) return runnerSnap;
      const fallback = await captureBrowserViewportSnapshot({
        targetUrl: body.url ?? demoUrl,
      });
      return {
        ...fallback,
        agentActions,
        agentActive,
      };
    },
  );

  // --- Interactive Roadmap, Milestones & AI Brainstorming Studio ---

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/roadmap',
    async (request): Promise<ProjectRoadmapState> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      return getProjectRoadmap(toProject(row), tickets);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/roadmap/milestones',
    async (request, reply): Promise<ProjectRoadmapState> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = CreateMilestoneBody.parse(request.body ?? {});
      const state = await addRoadmapMilestone(toProject(row), tickets, body);
      reply.code(201);
      return state;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/roadmap/items',
    async (request, reply): Promise<ProjectRoadmapState> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = CreateRoadmapItemBody.parse(request.body ?? {});
      try {
        const state = await addRoadmapItem(toProject(row), tickets, body);
        reply.code(201);
        return state;
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.patch<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/roadmap/items/:itemId',
    async (request): Promise<ProjectRoadmapState> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = UpdateRoadmapItemBody.parse(request.body ?? {});
      try {
        return await updateRoadmapItem(toProject(row), tickets, request.params.itemId, body);
      } catch (err) {
        throw notFound((err as Error).message);
      }
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/roadmap/items/:itemId',
    async (request): Promise<ProjectRoadmapState> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      return deleteRoadmapItem(toProject(row), tickets, request.params.itemId);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/roadmap/brainstorm',
    async (request): Promise<BrainstormResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = BrainstormRequestBody.parse(request.body ?? {});
      return runProjectBrainstorm(toProject(row), tickets, body);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/roadmap/dispatch',
    async (request): Promise<DispatchRoadmapItemsResponse> => {
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) throw notFound('no such project');
      const body = DispatchRoadmapItemsBody.parse(request.body ?? {});
      return dispatchRoadmapItems(toProject(row), tickets, body);
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/cleanup-worktrees', async (request) => {
    const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
    if (!row) throw notFound('no such project');
    return runs.garbageCollect({
      projectId: row.id,
      keepRecent: 0,
      includeFailed: true,
      pruneWorktrees: true,
    });
  });

  app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>(
    '/api/projects/:id',
    async (request) => {
      const projectId = request.params.id;
      const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!row) throw notFound('no such project');

      tickets.setAutoChain(projectId, false);
      for (const run of runs.list()) {
        if (run.projectId === projectId) {
          await runs.remove(run.id).catch(() => {});
        }
      }

      const worktreeSlugDir = path.join(config.workspacesDir, '.worktrees', row.slug);
      await rm(worktreeSlugDir, { recursive: true, force: true }).catch(() => {});

      const shouldDeleteFiles = request.query.deleteFiles !== '0';
      const resolvedWorkspace = path.resolve(row.path);
      const resolvedRoot = path.resolve(config.workspacesDir);
      if (
        shouldDeleteFiles &&
        resolvedWorkspace.startsWith(resolvedRoot + path.sep) &&
        resolvedWorkspace !== resolvedRoot
      ) {
        await rm(resolvedWorkspace, { recursive: true, force: true }).catch(() => {});
      }

      db.delete(projects).where(eq(projects.id, projectId)).run();

      const nextFirst = db.select().from(projects).orderBy(asc(projects.createdAt)).get();
      saveActiveProjectId(nextFirst?.id ?? null);

      return { ok: true, deletedProjectId: projectId, nextActiveProjectId: nextFirst?.id ?? null };
    },
  );
}

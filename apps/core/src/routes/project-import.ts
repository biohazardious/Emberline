/** Import routes: workspace folders, clone status, detection and adopt. */
import { createHash } from 'node:crypto';
import {
  type AdoptPreviewResponse,
  AdoptProjectBody,
  type AdoptProjectResponse,
  type ImportStatusResponse,
  type Project,
  type ProjectDetectResponse,
  type WorkspaceFoldersResponse,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { writeProjectSettings } from '../db/project-settings.js';
import { projects, projectWorktreeConfig } from '../db/schema.js';
import { notFound } from '../errors.js';
import { detectProject } from '../factory/detect.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { techStackFromChoices } from '../factory/project-plan.js';
import { assertNotCloning, executeAdopt, importStatus, listWorkspaceFolders, planAdopt } from '../factory/project-import.js';
import type { CoreDeps } from '../server.js';
import { toProject } from './projects.js';

export function registerProjectImportRoutes(app: FastifyInstance, { db, config, ptyd, tickets }: CoreDeps): void {
  const projectOr404 = (id: string) => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('no such project');
    return toProject(row);
  };

  app.get('/api/workspaces/folders', async (): Promise<WorkspaceFoldersResponse> => {
    const paths = db.select({ path: projects.path }).from(projects).all().map((r) => r.path);
    return { folders: await listWorkspaceFolders(config.workspacesDir, paths) };
  });

  /**
   * A clone checks out the remote's default branch, which may not be the one the person typed:
   * runs are merged into the checked-out branch, so the project records that one (as import_folder does).
   */
  const reconcileClonedBranch = async (project: Project): Promise<void> => {
    if (!project.repoUrl) return;
    const branch = await mainWorkspaceBranch(project.path);
    if (branch && branch !== project.defaultBranch) {
      db.update(projects).set({ defaultBranch: branch }).where(eq(projects.id, project.id)).run();
    }
  };

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/import-status',
    async (request): Promise<ImportStatusResponse> => {
      const project = projectOr404(request.params.id);
      const status = await importStatus(ptyd, project);
      if (status.status === 'ready') await reconcileClonedBranch(project);
      return status;
    },
  );

  /** Reads the repository only: no install, no script, no build. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/detect',
    async (request): Promise<ProjectDetectResponse> => {
      const project = projectOr404(request.params.id);
      await assertNotCloning(ptyd, project.id);
      return detectProject(config.workspacesDir, project);
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/adopt/preview', async (request): Promise<AdoptPreviewResponse> => {
    const project = projectOr404(request.params.id);
    await assertNotCloning(ptyd, project.id);
    const { files, commitMessage, worktreeConfig } = await planAdopt(config.workspacesDir, project, AdoptProjectBody.parse(request.body ?? {}));
    return { files, commitMessage, worktreeConfig };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/adopt', async (request): Promise<AdoptProjectResponse> => {
    const project = projectOr404(request.params.id);
    const body = AdoptProjectBody.parse(request.body ?? {});
    await assertNotCloning(ptyd, project.id);
    await reconcileClonedBranch(project);
    const result = await executeAdopt(config.workspacesDir, project, body);

    const approvedAt = new Date();
    let warning: string | undefined;
    try {
      db.transaction(() => {
        // Gates live in the DB, never in the repo (an agent could switch a gate off and merge that).
        writeProjectSettings(db, project.id, { gates: body.gates, choices: result.choices });
        db.update(projects)
          .set({
            appType: result.appType,
            techStack: techStackFromChoices(result.choices),
            ...(body.vision ? { description: body.vision } : {}),
          })
          .where(eq(projects.id, project.id))
          .run();
        if (result.approvedWorktreeYml !== null) {
          const approval = {
            content: result.approvedWorktreeYml,
            sha256: createHash('sha256').update(result.approvedWorktreeYml).digest('hex'),
            approvedAt,
            // Emberline's own file counts as approved; the repo's file was ticked by the person.
            approvedBy: result.worktreeConfig === 'generated' ? 'wizard' : 'import',
          };
          db.insert(projectWorktreeConfig)
            .values({ projectId: project.id, ...approval })
            .onConflictDoUpdate({ target: projectWorktreeConfig.projectId, set: approval })
            .run();
        }
      });
    } catch (err) {
      // The commit landed: report it instead of failing an adopt whose files are in the repository.
      request.log.error({ err, projectId: project.id }, 'adopt: storing choices, gates or the approved worktree.yml failed');
      warning =
        'The project files were committed, but the choices, gates and worktree approval could not be saved. Adopt again with nothing ticked, or set them in the project settings.';
    }

    let factoryTicketId: string | null = null;
    if (body.startFactory && !warning) {
      try {
        // Imports get no Bootstrap ticket: the repo already has its skeleton.
        factoryTicketId = tickets.createFactoryTicket(project.id, body.vision, { autoDispatch: true }).id;
        tickets.setAutoChain(project.id, true);
        void tickets.dispatchNextReadyTicket(project.id).catch((err: unknown) => {
          request.log.warn({ err, projectId: project.id }, 'adopt: starting the factory failed');
        });
      } catch (err) {
        request.log.error({ err, projectId: project.id }, 'adopt: creating the [Factory] ticket failed');
        warning = 'The project files were committed, but the [Factory] ticket could not be created. Start the factory from the project.';
      }
    }

    const row = db.select().from(projects).where(eq(projects.id, project.id)).get();
    return {
      project: row ? toProject(row) : project,
      files: result.files,
      commitMessage: result.commitMessage,
      worktreeConfig: result.worktreeConfig,
      commitSha: result.commitSha,
      factoryTicketId,
      ...(warning ? { warning } : {}),
    };
  });
}

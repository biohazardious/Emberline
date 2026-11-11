/** Import routes: workspace folders, clone status, detection and adopt. */
import { createHash } from 'node:crypto';
import {
  type AdoptPreviewResponse,
  AdoptProjectBody,
  type AdoptProjectResponse,
  type ImportStatusResponse,
  type Project,
  type ProjectDetectResponse,
  SshRemoteProblem,
  type WorkspaceFoldersResponse,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { markImportCloned, readImportClone, writeProjectSettings } from '../db/project-settings.js';
import { projects, projectWorktreeConfig } from '../db/schema.js';
import { notFound } from '../errors.js';
import { detectProject } from '../factory/detect.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { techStackFromChoices } from '../factory/project-plan.js';
import {
  assertNotCloning,
  executeAdopt,
  importStatus,
  listWorkspaceFolders,
  planAdopt,
} from '../factory/project-import.js';
import { redactCapabilityUrls } from '../git-gateway/gateway.js';
import { finishGatewayClone } from '../git-gateway/remote-git.js';
import { opsBridgeOf } from '../ptyd-bridge.js';
import { getPublicKey } from '../ssh-keys/store.js';
import type { CoreDeps } from '../server.js';
import { projectResponse, redactedProject, toProject } from './projects.js';

export function registerProjectImportRoutes(
  app: FastifyInstance,
  { db, config, ptyd, opsPtyd, tickets, runs }: CoreDeps,
): void {
  // The import clone runs in the ops container (the runner in the dev stack): its terminal is there.
  const clones = opsBridgeOf({ ptyd, opsPtyd });
  const projectOr404 = (id: string) => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('no such project');
    return toProject(row);
  };

  app.get('/api/workspaces/folders', async (): Promise<WorkspaceFoldersResponse> => {
    const paths = db
      .select({ path: projects.path })
      .from(projects)
      .all()
      .map((r) => r.path);
    return { folders: await listWorkspaceFolders(config.workspacesDir, paths) };
  });

  /**
   * Without a branch given, a clone checks out the remote's default branch, which may not be the
   * recorded `main`: runs are merged into the checked-out branch, so the project records that one
   * (as import_folder does).
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
      if (readImportClone(db, project.id)?.awaitingKey) {
        // Its own key is to be added on the forge first: no clone has run (Ruling 21).
        const key = getPublicKey(db, { projectId: project.id });
        return {
          status: 'awaiting_key',
          exitCode: null,
          terminalId: null,
          tail: '',
          sshKey: key ? { publicKey: key.publicKey, fingerprint: key.fingerprint } : null,
        };
      }
      const status = await importStatus(clones, project);
      if (status.status !== 'cloning') {
        // A clone through the gateway: release its capability and point origin at the real URL (once).
        const outcome = await finishGatewayClone(runs.gitGateway, project, status.status === 'ready');
        if (outcome && status.status === 'failed') {
          status.tail = `${status.tail}\n${outcome.message}`.trim();
          // The gateway's reason, not git's view of it (ssh's own output is only read for a direct clone).
          const code = SshRemoteProblem.safeParse(outcome.code);
          if (code.success) {
            status.reason = outcome.message;
            status.code = code.data;
            if (outcome.hostKey) status.hostKey = outcome.hostKey;
          }
        }
      }
      if (status.status === 'ready') {
        await reconcileClonedBranch(project);
        markImportCloned(db, project.id);
      }
      return { ...status, tail: redactCapabilityUrls(status.tail) };
    },
  );

  /** Reads the repository only: no install, no script, no build. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/detect',
    async (request): Promise<ProjectDetectResponse> => {
      const project = projectOr404(request.params.id);
      await assertNotCloning(clones, project.id);
      return detectProject(config.workspacesDir, project);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/adopt/preview',
    async (request): Promise<AdoptPreviewResponse> => {
      const project = projectOr404(request.params.id);
      await assertNotCloning(clones, project.id);
      const { files, commitMessage, worktreeConfig } = await planAdopt(
        config.workspacesDir,
        project,
        AdoptProjectBody.parse(request.body ?? {}),
      );
      return { files, commitMessage, worktreeConfig };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/adopt',
    async (request): Promise<AdoptProjectResponse> => {
      const project = projectOr404(request.params.id);
      const body = AdoptProjectBody.parse(request.body ?? {});
      await assertNotCloning(clones, project.id);
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
        request.log.error(
          { err, projectId: project.id },
          'adopt: storing choices, gates or the approved worktree.yml failed',
        );
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
          warning =
            'The project files were committed, but the [Factory] ticket could not be created. Start the factory from the project.';
        }
      }

      const row = db.select().from(projects).where(eq(projects.id, project.id)).get();
      return {
        project: row ? projectResponse(row) : redactedProject(project),
        files: result.files,
        commitMessage: result.commitMessage,
        worktreeConfig: result.worktreeConfig,
        commitSha: result.commitSha,
        factoryTicketId,
        ...(warning ? { warning } : {}),
      };
    },
  );
}

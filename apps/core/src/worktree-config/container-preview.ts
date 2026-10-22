/**
 * Project settings → Container preview: whether a project can switch its preview to a service of
 * HEAD's compose file (spec §2), and (Task 3) the worktree.yml it would save.
 */
import {
  type ContainerPreviewOptionsResponse,
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  type DockerEngineStatus,
  dockerEngineOffText,
  isComposeService,
  withHint,
} from '@emberline/protocol';
import type { Db } from '../db/index.js';
import type { ComposeConfigReader } from '../docker/compose-config.js';
import { findHeadComposeFile } from '../docker/compose-config.js';
import type { DockerEngine } from '../docker/engine.js';
import { approvedPreviewService } from './load.js';
import { worktreeConfigStatus } from './trust.js';

export interface ContainerPreviewDeps {
  db: Db;
  docker: DockerEngine;
  reader: ComposeConfigReader;
}

export const NO_COMPOSE_FILE_TEXT =
  "The main workspace's HEAD has no compose file (compose.yaml, compose.yml, docker-compose.yaml or docker-compose.yml).";
export const ALREADY_CONTAINER_PREVIEW_TEXT = 'The approved worktree.yml already previews a container.';
export const WORKTREE_YML_NOT_APPROVED_TEXT =
  'The worktree.yml on main is not the approved one. Review it under worktree.yml below first.';

/** Why the engine cannot run a container preview now, in the words the rest of Emberline uses. */
export function engineUnavailableText(engine: DockerEngineStatus): string {
  if (!engine.enabled) return dockerEngineOffText(engine);
  if (!engine.checked) return DOCKER_ENGINE_NOT_ANSWERED_TEXT;
  return withHint(
    `The Docker engine is not reachable${engine.error ? `: ${engine.error}` : ''}`,
    DOCKER_ENGINE_UNREACHABLE_HINT,
  );
}

/**
 * The box shows (`file` set) when the engine answers, HEAD has a compose file and the approved
 * worktree.yml has no compose preview; it can save (`available`) when HEAD's worktree.yml is the
 * approved one and compose read the file. The engine is checked first (no git, no compose call).
 */
export async function containerPreviewOptions(
  deps: ContainerPreviewDeps,
  project: { id: string; path: string },
): Promise<ContainerPreviewOptionsResponse> {
  const preview = approvedPreviewService(deps.db, project.id);
  const commandPreview = preview !== null && !isComposeService(preview);
  const hidden = (reason: string): ContainerPreviewOptionsResponse => ({
    available: false,
    reason,
    file: null,
    services: [],
    commandPreview,
  });
  await deps.docker.ready();
  const engine = deps.docker.status;
  if (!engine.available) return hidden(engineUnavailableText(engine));
  if (preview && isComposeService(preview)) return hidden(ALREADY_CONTAINER_PREVIEW_TEXT);
  const head = await findHeadComposeFile(project.path);
  if (head.kind === 'unknown') return hidden(`git could not read the main workspace's HEAD: ${head.error}`);
  if (head.kind === 'absent') return hidden(NO_COMPOSE_FILE_TEXT);
  const file = head.entry.file;
  const status = await worktreeConfigStatus(deps.db, project);
  if (status.headError) return hidden(`git could not read the main workspace's HEAD: ${status.headError}`);
  if (status.changed || status.unusable) {
    return { available: false, reason: WORKTREE_YML_NOT_APPROVED_TEXT, file, services: [], commandPreview };
  }
  const read = await deps.reader.read(project.id, project.path, head.entry);
  return read.ok
    ? { available: true, reason: null, file, services: read.services, commandPreview }
    : { available: false, reason: read.reason, file, services: [], commandPreview };
}

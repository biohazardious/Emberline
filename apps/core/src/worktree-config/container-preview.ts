/**
 * Project settings → Container preview: whether a project can switch its preview to a service of
 * HEAD's compose file (spec §2), the worktree.yml it would save, its diff, and the switch.
 */
import {
  CONTAINER_PREVIEW_CODES,
  type ContainerPreviewChoice,
  type ContainerPreviewDiffResponse,
  type ContainerPreviewOptionsResponse,
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  type DockerEngineStatus,
  dockerEngineOffText,
  isComposeService,
  MAX_WORKTREE_YML_BYTES,
  type UseContainerPreviewBody,
  WORKTREE_CONFIG_CODES,
  type WorktreeConfigStatusResponse,
  withHint,
} from '@emberline/protocol';
import { isMap, isScalar, isSeq, parseDocument, type YAMLSeq } from 'yaml';
import type { Db } from '../db/index.js';
import type { ComposeConfigReader } from '../docker/compose-config.js';
import { findHeadComposeFile } from '../docker/compose-config.js';
import type { DockerEngine } from '../docker/engine.js';
import { conflict, HttpError } from '../errors.js';
import { unifiedDiff } from './diff.js';
import { saveWorktreeConfig, worktreeYmlErrors } from './edit.js';
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
  return (await optionsWithStatus(deps, project)).options;
}

/** The options and the worktree.yml status they were decided from (null when they were decided before reading it). */
async function optionsWithStatus(
  deps: ContainerPreviewDeps,
  project: { id: string; path: string },
): Promise<{ options: ContainerPreviewOptionsResponse; status: WorktreeConfigStatusResponse | null }> {
  const preview = approvedPreviewService(deps.db, project.id);
  const commandPreview = preview !== null && !isComposeService(preview);
  const hidden = (reason: string): { options: ContainerPreviewOptionsResponse; status: null } => ({
    options: { available: false, reason, file: null, services: [], commandPreview },
    status: null,
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
    return {
      options: {
        available: false,
        reason: WORKTREE_YML_NOT_APPROVED_TEXT,
        file,
        services: [],
        commandPreview,
      },
      status,
    };
  }
  const read = await deps.reader.read(project.id, project.path, head.entry);
  const options: ContainerPreviewOptionsResponse = read.ok
    ? { available: true, reason: null, file, services: read.services, commandPreview }
    : { available: false, reason: read.reason, file, services: [], commandPreview };
  return { options, status };
}

export const CONTAINER_PREVIEW_CHANGED_TEXT =
  '.emberline/worktree.yml changed on main since the preview was shown. Reload to see the current version.';
const ENTRY = 'container';

/** `container`, else `container-2`, `container-3`, … (the first name not taken). */
export function containerEntryName(taken: ReadonlySet<string>): string {
  if (!taken.has(ENTRY)) return ENTRY;
  for (let n = 2; ; n++) if (!taken.has(`${ENTRY}-${n}`)) return `${ENTRY}-${n}`;
}

/**
 * The approved worktree.yml with the container preview: version 2, the old preview service kept with
 * `preview: false`, a new compose entry with `preview: true` appended. Comments, order and the other
 * scalars stay as they were. `approved` null or blank: a new file with only the entry.
 */
export function withContainerPreview(
  approved: string | null,
  ref: { file: string; service: string; port: number },
): string {
  const doc = parseDocument(approved?.trim() ? approved : 'version: 1\n');
  doc.set('version', 2);
  const old = doc.get('services', true);
  let services = old;
  if (!isSeq(services)) {
    services = doc.createNode([]);
    if (isScalar(old)) {
      (services as YAMLSeq).commentBefore = old.commentBefore;
      (services as YAMLSeq).comment = old.comment;
    }
    doc.set('services', services);
  }
  const seq = services as YAMLSeq;
  seq.flow = false;
  const taken = new Set<string>();
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = item.get('name');
    if (typeof name === 'string') taken.add(name);
    if (item.get('preview') === true) item.set('preview', false);
  }
  seq.add(
    doc.createNode({
      name: containerEntryName(taken),
      compose: { file: ref.file, service: ref.service, port: ref.port },
      preview: true,
    }),
  );
  // lineWidth 0: a long command is never folded onto a second line. A list item at column 0 can only
  // be a top-level key's unindented list (the root is a map): keep that style for every list.
  const out = doc.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    indentSeq: !/^-(?:[ \t]|$)/m.test(approved ?? ''),
  });
  // A CRLF file stays CRLF, so the diff shows only the real change.
  return approved?.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out;
}

/** The checks the diff and the save share; throws the 409/400 the person reads. */
async function plan(
  deps: ContainerPreviewDeps,
  project: { id: string; path: string },
  choice: ContainerPreviewChoice,
) {
  const { options, status } = await optionsWithStatus(deps, project);
  if (!options.available || !status) {
    throw conflict(
      options.reason ?? 'The container preview cannot be set up now.',
      CONTAINER_PREVIEW_CODES.unavailable,
    );
  }
  if (options.file !== choice.file) {
    throw conflict(
      `HEAD's compose file is now ${options.file}. Reload to see it.`,
      CONTAINER_PREVIEW_CODES.unavailable,
    );
  }
  if (!options.services.some((s) => s.name === choice.service)) {
    throw new HttpError(
      400,
      CONTAINER_PREVIEW_CODES.unknownService,
      `"${choice.service}" is not a service in ${choice.file}.`,
    );
  }
  const approved = status.approved?.content ?? null;
  const content = withContainerPreview(approved, choice);
  const errors = worktreeYmlErrors(content);
  if (new TextEncoder().encode(content).length > MAX_WORKTREE_YML_BYTES) {
    errors.push(`content is larger than ${MAX_WORKTREE_YML_BYTES / 1024} KB`);
  }
  if (errors.length > 0) {
    throw new HttpError(
      400,
      WORKTREE_CONFIG_CODES.invalid,
      'worktree.yml with the container preview would not be valid',
      { errors },
    );
  }
  // The options refused unless HEAD's worktree.yml is the approved one (or neither exists); this is the status they decided from.
  return { approved, content, baseSha256: status.head?.sha256 ?? null };
}

/** The worktree.yml the switch would save, its diff from the approved one and the base a save starts from. */
export async function containerPreviewDiff(
  deps: ContainerPreviewDeps,
  project: { id: string; path: string },
  choice: ContainerPreviewChoice,
): Promise<ContainerPreviewDiffResponse> {
  const { approved, content, baseSha256 } = await plan(deps, project, choice);
  return {
    content,
    diff: unifiedDiff(approved ?? '', content, { before: 'approved', after: 'with the container preview' }),
    baseSha256,
  };
}

/** Spec §2: validate → commit on main `chore: preview the <service> container from <file>` → approve (edit.ts, under the main-workspace lock). */
export async function applyContainerPreview(
  deps: ContainerPreviewDeps,
  project: { id: string; path: string },
  body: UseContainerPreviewBody,
): Promise<WorktreeConfigStatusResponse> {
  const { content, baseSha256 } = await plan(deps, project, body);
  if (baseSha256 !== body.baseSha256)
    throw conflict(CONTAINER_PREVIEW_CHANGED_TEXT, WORKTREE_CONFIG_CODES.changed);
  // The options refused unless HEAD's file is the approved one, so HEAD's sha256 is the approval's (or both null).
  return saveWorktreeConfig(
    deps.db,
    project,
    { content, baseSha256: body.baseSha256 },
    {
      message: `chore: preview the ${body.service} container from ${body.file}`,
      approvedSha256: body.baseSha256,
      changedText: CONTAINER_PREVIEW_CHANGED_TEXT,
    },
  );
}

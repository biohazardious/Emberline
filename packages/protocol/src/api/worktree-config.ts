/**
 * `.emberline/worktree.yml`: how each run worktree sets up, runs services and verifies itself.
 * Version 1 services are commands; version 2 adds services from the project's compose file (they
 * need the Docker engine). A v1 file stays valid unchanged.
 */
import { z } from 'zod';
import { ADOPT_FILE_PATHS, MAX_WORKTREE_YML_BYTES } from './projects.js';

export const WORKTREE_CONFIG_LIMITS = {
  maxEntries: 20,
  maxCommandChars: 2000,
} as const;

const Command = z.string().trim().min(1).max(WORKTREE_CONFIG_LIMITS.maxCommandChars);

/**
 * Shape check only: relative, no `..` segment, no NUL, no drive/UNC/home prefix. Symlink and
 * "resolves inside the workspace" checks need the filesystem and live in core.
 */
const CopyPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes('\0'), 'must not contain NUL')
  .refine((p) => !/^[/\\]/.test(p) && !/^[A-Za-z]:/.test(p) && !p.startsWith('~'), 'must be a relative path')
  .refine((p) => !p.split(/[/\\]/).includes('..'), 'must not contain ".."');

export const WorktreeCopyEntry = z.union([
  CopyPath.transform((path) => ({ path, mode: 'copy' as const })),
  z.object({ path: CopyPath, mode: z.enum(['copy', 'symlink']).default('copy') }).strict(),
]);
export type WorktreeCopyEntry = z.output<typeof WorktreeCopyEntry>;

/** A compose service name: letters, digits, ".", "-" and "_", at most 63, not starting with a sign. */
export const COMPOSE_SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/**
 * A version 2 service from the project's compose file: `file` (relative to the worktree, default
 * `compose.yaml`), the compose `service` and the container `port` its preview publishes.
 */
export const WorktreeComposeRef = z
  .object({
    file: CopyPath.refine((p) => !p.startsWith('-'), 'must not start with "-"').default('compose.yaml'),
    service: z
      .string()
      .regex(COMPOSE_SERVICE_NAME, 'a compose service name: letters, digits, ".", "-" and "_" (max 63)'),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export type WorktreeComposeRef = z.output<typeof WorktreeComposeRef>;

/** Exactly one of `command` (v1 and v2) and `compose` (v2 only, checked on the whole file). */
export const WorktreeService = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'letters, digits, "-" and "_" only (max 40)'),
    command: Command.optional(),
    compose: WorktreeComposeRef.optional(),
    preview: z.boolean().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.command === undefined) === (s.compose === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'needs exactly one of "command" and "compose"' });
    }
  });
export type WorktreeService = z.output<typeof WorktreeService>;
export type WorktreeComposeService = WorktreeService & { compose: WorktreeComposeRef };

export function isComposeService(service: WorktreeService): service is WorktreeComposeService {
  return service.compose !== undefined;
}

const List = <T extends z.ZodType>(item: T) => z.array(item).max(WORKTREE_CONFIG_LIMITS.maxEntries).default([]);

export const WorktreeChecks = z
  .object({ build: Command.optional(), lint: Command.optional(), test: Command.optional() })
  .strict();
export type WorktreeChecks = z.infer<typeof WorktreeChecks>;

export const WorktreeConfig = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    copy: List(WorktreeCopyEntry),
    setup: List(Command),
    teardown: List(Command),
    services: List(WorktreeService),
    checks: WorktreeChecks.default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.services.forEach((s, i) => {
      if (s.compose && cfg.version < 2) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'compose'], message: 'compose services need version: 2' });
      }
      if (seen.has(s.name)) ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: 'duplicate service name' });
      seen.add(s.name);
    });
    if (cfg.services.filter((s) => s.preview).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['services'], message: 'at most one service may set preview: true' });
    }
  });
export type WorktreeConfig = z.output<typeof WorktreeConfig>;

/** A worktree.yml version runs use: the content a person (or the wizard) approved. */
export const ApprovedWorktreeConfig = z.object({
  content: z.string(),
  sha256: z.string(),
  approvedAt: z.string(),
  /** `wizard` (Emberline's own file), `import` (ticked on the import summary) or `person` (approved later). */
  approvedBy: z.string(),
});
export type ApprovedWorktreeConfig = z.infer<typeof ApprovedWorktreeConfig>;

/** `GET /api/projects/:id/worktree-config`: the approved content next to what the main workspace's HEAD has. */
export const WorktreeConfigStatusResponse = z.object({
  approved: ApprovedWorktreeConfig.nullable(),
  /** HEAD's committed `.emberline/worktree.yml`; null when there is none or it cannot be read safely. */
  head: z.object({ content: z.string(), sha256: z.string() }).nullable(),
  /** git could not read HEAD (no repository or commit, a broken HEAD): `head` is unknown, not absent. */
  headError: z.string().nullable(),
  /** HEAD differs from the approved content: another file, or none (`removed`). The "changed — review" banner. */
  changed: z.boolean(),
  /** HEAD no longer has the file while an approval exists; approving `{ removal: true }` clears it. */
  removed: z.boolean(),
  /** Unified diff from the approved content to HEAD's, bounded; empty when unchanged. */
  diff: z.string(),
  /** Why HEAD's file cannot be approved (read or schema errors); empty when it can. */
  errors: z.array(z.string()),
  /**
   * HEAD has a file that cannot be used (a symbolic link, over the size cap, or invalid): `errors`
   * says why. With an approval this counts as `changed`; runs keep the approved content.
   */
  unusable: z.boolean(),
});
export type WorktreeConfigStatusResponse = z.infer<typeof WorktreeConfigStatusResponse>;

/**
 * `POST /api/projects/:id/worktree-config/approve`: the sha256 of the HEAD content the person
 * reviewed, or `{ removal: true }` to accept that HEAD removed the file (runs then get no lifecycle).
 */
export const ApproveWorktreeConfigBody = z.union([
  z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ removal: z.literal(true) }).strict(),
]);
export type ApproveWorktreeConfigBody = z.infer<typeof ApproveWorktreeConfigBody>;

/** The explorer's answer for `.emberline/worktree.yml`: it is edited in Project settings only. */
export const WORKTREE_YML_EDIT_IN_SETTINGS = 'Edit this file from Project settings so it is committed and approved.';

/** `rel` as a repository path: `/` separators, no empty, `.` or resolved `..` segments. */
function normalizedRepoPath(rel: string): string {
  const parts: string[] = [];
  for (const part of rel.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** `rel` names the project's worktree.yml (backslashes, a leading `/` or `./`, `//` and `.` segments normalized). */
export function isWorktreeYmlPath(rel: string): boolean {
  return normalizedRepoPath(rel) === ADOPT_FILE_PATHS.worktreeYml;
}

/** `rel` is `.emberline` itself (deleting it would delete worktree.yml). */
export function isEmberlineDirPath(rel: string): boolean {
  return normalizedRepoPath(rel) === ADOPT_FILE_PATHS.worktreeYml.slice(0, ADOPT_FILE_PATHS.worktreeYml.lastIndexOf('/'));
}

/** Error codes of the worktree.yml editor's save. */
export const WORKTREE_CONFIG_CODES = {
  invalid: 'worktree_config_invalid',
  changed: 'worktree_config_changed',
  dirty: 'worktree_config_dirty',
  detached: 'main_workspace_detached',
  editInSettings: 'worktree_config_edit_in_settings',
} as const;

const WorktreeYmlContent = z.string().refine((s) => new TextEncoder().encode(s).length <= MAX_WORKTREE_YML_BYTES, {
  message: `content is larger than ${MAX_WORKTREE_YML_BYTES / 1024} KB`,
});

/** `POST /api/projects/:id/worktree-config/validate`: the editor's content, checked without saving. */
export const ValidateWorktreeConfigBody = z.object({ content: WorktreeYmlContent }).strict();
export type ValidateWorktreeConfigBody = z.infer<typeof ValidateWorktreeConfigBody>;
/** The same errors the banner shows for HEAD's file; empty when the content is valid. */
export const ValidateWorktreeConfigResponse = z.object({ errors: z.array(z.string()) });
export type ValidateWorktreeConfigResponse = z.infer<typeof ValidateWorktreeConfigResponse>;

/**
 * `PUT /api/projects/:id/worktree-config`: commits `content` to the main workspace's branch and
 * approves it. `baseSha256` is HEAD's file sha256 when the editor opened (null when there was none).
 */
export const SaveWorktreeConfigBody = z
  .object({ content: WorktreeYmlContent, baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() })
  .strict();
export type SaveWorktreeConfigBody = z.infer<typeof SaveWorktreeConfigBody>;

/** The compose files the Container preview box looks for in HEAD, in this order (the first present wins). */
export const COMPOSE_FILE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;
export const ComposeFileName = z.enum(COMPOSE_FILE_NAMES);
export type ComposeFileName = z.infer<typeof ComposeFileName>;

/** A service of the compose file and its container ports (published targets, then `expose`), as `docker compose config` resolves them. */
export const ContainerPreviewService = z.object({ name: z.string(), ports: z.array(z.number().int()) });
export type ContainerPreviewService = z.infer<typeof ContainerPreviewService>;

/**
 * `GET /api/projects/:id/container-preview`. `file` is set exactly when Project settings shows the
 * Container preview box (engine available, HEAD has a compose file, the approved worktree.yml has no
 * compose preview); `available` says whether the box can save, `reason` why not. `commandPreview`:
 * the approved preview service is a command (the Preview & Build hint).
 */
export const ContainerPreviewOptionsResponse = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  file: ComposeFileName.nullable(),
  services: z.array(ContainerPreviewService),
  commandPreview: z.boolean(),
});
export type ContainerPreviewOptionsResponse = z.infer<typeof ContainerPreviewOptionsResponse>;

/** The person's pick: `POST …/container-preview/diff` takes it as is. */
export const ContainerPreviewChoice = z
  .object({
    file: ComposeFileName,
    service: z.string().regex(COMPOSE_SERVICE_NAME),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export type ContainerPreviewChoice = z.infer<typeof ContainerPreviewChoice>;

/** The new worktree.yml, its diff from the approved content, and the HEAD sha256 a save must start from. */
export const ContainerPreviewDiffResponse = z.object({
  content: z.string(),
  diff: z.string(),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type ContainerPreviewDiffResponse = z.infer<typeof ContainerPreviewDiffResponse>;

/** `POST /api/projects/:id/container-preview`: the pick and the `baseSha256` of the diff the person saw. */
export const UseContainerPreviewBody = z
  .object({
    file: ComposeFileName,
    service: z.string().regex(COMPOSE_SERVICE_NAME),
    port: z.number().int().min(1).max(65535),
    baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
export type UseContainerPreviewBody = z.infer<typeof UseContainerPreviewBody>;

export const CONTAINER_PREVIEW_CODES = {
  unavailable: 'container_preview_unavailable',
  unknownService: 'container_preview_unknown_service',
} as const;

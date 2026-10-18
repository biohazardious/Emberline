/** `.emberline/worktree.yml` schema v1: how each run worktree sets up, runs services and verifies itself. */
import { z } from 'zod';

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

export const WorktreeService = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'letters, digits, "-" and "_" only (max 40)'),
    command: Command,
    preview: z.boolean().optional(),
  })
  .strict();
export type WorktreeService = z.infer<typeof WorktreeService>;

const List = <T extends z.ZodType>(item: T) => z.array(item).max(WORKTREE_CONFIG_LIMITS.maxEntries).default([]);

export const WorktreeChecks = z
  .object({ build: Command.optional(), lint: Command.optional(), test: Command.optional() })
  .strict();
export type WorktreeChecks = z.infer<typeof WorktreeChecks>;

export const WorktreeConfig = z
  .object({
    version: z.literal(1),
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
  /** HEAD has a file whose content differs from the approved one (the "changed — review" banner). */
  changed: z.boolean(),
  /** Unified diff from the approved content to HEAD's, bounded; empty when unchanged. */
  diff: z.string(),
  /** Why HEAD's file cannot be approved (read or schema errors); empty when it can. */
  errors: z.array(z.string()),
});
export type WorktreeConfigStatusResponse = z.infer<typeof WorktreeConfigStatusResponse>;

/** `POST /api/projects/:id/worktree-config/approve`: the sha256 of the HEAD content the person reviewed. */
export const ApproveWorktreeConfigBody = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ApproveWorktreeConfigBody = z.infer<typeof ApproveWorktreeConfigBody>;

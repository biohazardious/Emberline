/** API contracts: projects & AI factory metadata. */
import { z } from 'zod';

/** Specialized AI Coding Factory agent personas. */
export const AgentPersona = z.enum([
  'product_owner',
  'architect',
  'ui_ux',
  'coder',
  'dba',
  'qa',
  'security',
]);
export type AgentPersona = z.infer<typeof AgentPersona>;

export const ProjectAppType = z.enum([
  'web_saas',
  'fullstack',
  'api_service',
  'ai_agents',
  'cli_tool',
  'mobile_desktop',
  'embedded_iot',
  'library',
  'game_interactive',
  'custom',
]);
export type ProjectAppType = z.infer<typeof ProjectAppType>;

export const ProjectTechStack = z.object({
  language: z.string().max(200).default(''),
  frontend: z.string().max(200).default(''),
  backend: z.string().max(200).default(''),
  database: z.string().max(200).default(''),
  styling: z.string().max(200).default(''),
  testing: z.string().max(200).default(''),
  versionPolicy: z.string().max(200).optional(),
});
export type ProjectTechStack = z.infer<typeof ProjectTechStack>;

/** https://, ssh:// or scp-style git@host:path. Never starts with "-" (no git option injection). */
const RepoUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/, 'must be an https://, ssh:// or git@ URL');

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  path: z.string(),
  appType: ProjectAppType,
  description: z.string(),
  techStack: ProjectTechStack.nullable(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(['manual', 'wizard']).default('manual'),
  repoUrl: RepoUrl.optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .max(200)
    .default('main'),
  appType: ProjectAppType.default('custom'),
  description: z.string().trim().max(4000).default(''),
  techStack: ProjectTechStack.optional(),
  architectureNotes: z.string().trim().max(20_000).optional(),
  referenceDocs: z.string().trim().max(40_000).optional(),
  initGit: z.boolean().optional(),
  seedStarterTickets: z.boolean().default(false),
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const CreateProjectResponse = z.object({
  project: Project,
  /** Terminal running `git clone`, when a repo URL was given. */
  terminalId: z.string().nullable(),
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

export const ProjectBlueprintResponse = z.object({
  projectId: z.string(),
  exists: z.boolean(),
  content: z.string(),
  path: z.string(),
});
export type ProjectBlueprintResponse = z.infer<typeof ProjectBlueprintResponse>;

export const UpdateProjectBlueprintBody = z.object({
  content: z.string().max(200_000),
});
export type UpdateProjectBlueprintBody = z.input<typeof UpdateProjectBlueprintBody>;

export const ActiveProjectPreference = z.object({
  activeProjectId: z.string().nullable(),
});
export type ActiveProjectPreference = z.infer<typeof ActiveProjectPreference>;

export const ProjectRecommendation = z.object({
  id: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  category: z.enum(['blueprint', 'backlog', 'execution', 'qa', 'review']),
  title: z.string(),
  description: z.string(),
  persona: AgentPersona,
  actionLabel: z.string(),
  actionType: z.enum(['open_blueprint', 'seed_tickets', 'start_run', 'open_board', 'open_review']),
  prompt: z.string().optional(),
  runId: z.string().optional(),
});
export type ProjectRecommendation = z.infer<typeof ProjectRecommendation>;

/** Claude Code `--permission-mode`. `bypassPermissions` is only sane inside the isolated runner. */
/**
 * `auto` and `bypassPermissions` run unattended (pre-approved tools, no prompts). `default` and
 * `acceptEdits` keep the CLI's approval prompts for commands; `plan` never edits.
 */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const TaskTemplate = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  persona: AgentPersona,
  permissionMode: PermissionMode,
  titlePlaceholder: z.string(),
  promptTemplate: z.string(),
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

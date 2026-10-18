/** API contracts: projects & AI factory metadata. */
import { z } from 'zod';
import { GitBranchName } from './common.js';
import { ProjectChoices } from '../presets/types.js';

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
  'static_site',
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

export const ProjectSource = z.enum(['new', 'import_url', 'import_folder']);
export type ProjectSource = z.infer<typeof ProjectSource>;

/** Per-project gate overrides. An absent key inherits the global factory setting. */
export const ProjectGateOverrides = z
  .object({
    selfHealingBuildGate: z.boolean().optional(),
    antiSlopGate: z.boolean().optional(),
    secretGuardGate: z.boolean().optional(),
    crossProviderCritic: z.boolean().optional(),
    autoSyncToMain: z.boolean().optional(),
    requireCompletionSignal: z.boolean().optional(),
  })
  .strict();
export type ProjectGateOverrides = z.infer<typeof ProjectGateOverrides>;

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(['manual', 'wizard']).default('manual'),
  repoUrl: RepoUrl.optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: GitBranchName.default('main'),
  appType: ProjectAppType.default('custom'),
  description: z.string().trim().max(4000).default(''),
  techStack: ProjectTechStack.optional(),
  architectureNotes: z.string().trim().max(20_000).optional(),
  referenceDocs: z.string().trim().max(40_000).optional(),
  initGit: z.boolean().optional(),
  seedStarterTickets: z.boolean().default(false),
  /** v2 wizard fields; all optional so old payloads parse unchanged. */
  source: ProjectSource.optional(),
  presetId: z.string().min(1).max(100).optional(),
  choices: ProjectChoices.optional(),
  gates: ProjectGateOverrides.optional(),
  startFactory: z.boolean().optional(),
  vision: z.string().trim().max(4000).optional(),
  /** `import_folder`: name of a direct child of the workspaces directory. */
  folder: z.string().trim().min(1).max(255).optional(),
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const CreateProjectResponse = z.object({
  project: Project,
  /** Terminal running `git clone`, when a repo URL was given. */
  terminalId: z.string().nullable(),
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

/** `POST /api/projects/preview` takes the creation body and writes nothing. */
export const ProjectPreviewBody = CreateProjectBody;
export type ProjectPreviewBody = CreateProjectBody;

export const ProjectPreviewResponse = z.object({
  projectMd: z.string(),
  claudeMd: z.string(),
  worktreeYml: z.string(),
  starterFiles: z.array(z.string()),
  tickets: z.array(
    z.object({
      title: z.string(),
      persona: AgentPersona,
      /** Titles of the tickets this one depends on. */
      dependsOn: z.array(z.string()),
    }),
  ),
  gates: ProjectGateOverrides,
});
export type ProjectPreviewResponse = z.infer<typeof ProjectPreviewResponse>;

export const ImportStatusResponse = z.object({
  status: z.enum(['cloning', 'ready', 'failed']),
  /** Clone process exit code once finished. */
  exitCode: z.number().int().nullable(),
  terminalId: z.string().nullable(),
  /** Tail of the clone terminal output. */
  tail: z.string(),
});
export type ImportStatusResponse = z.infer<typeof ImportStatusResponse>;

const DetectedService = z.object({ name: z.string(), command: z.string(), preview: z.boolean().optional() });

export const ProjectDetectResponse = z.object({
  detected: z.object({
    choices: ProjectChoices,
    commands: z.object({
      setup: z.array(z.string()),
      build: z.string().optional(),
      test: z.string().optional(),
      lint: z.string().optional(),
      services: z.array(DetectedService),
    }),
    files: z.object({
      projectMd: z.boolean(),
      claudeMd: z.boolean(),
      agentsMd: z.boolean(),
      worktreeYml: z.boolean(),
    }),
  }),
  suggestions: z.object({
    projectMd: z.string().optional(),
    claudeMd: z.string().optional(),
    worktreeYml: z.string().optional(),
  }),
});
export type ProjectDetectResponse = z.infer<typeof ProjectDetectResponse>;

export const AdoptWriteFile = z.enum(['projectMd', 'claudeMd', 'worktreeYml']);
export type AdoptWriteFile = z.infer<typeof AdoptWriteFile>;

export const AdoptProjectBody = z.object({
  choices: ProjectChoices.default({}),
  gates: ProjectGateOverrides.default({}),
  /** Missing files to write and commit; existing files are never overwritten. */
  write: z.array(AdoptWriteFile).max(3).default([]),
  startFactory: z.boolean().default(false),
  vision: z.string().trim().max(4000).default(''),
});
export type AdoptProjectBody = z.input<typeof AdoptProjectBody>;

export const WorkspaceFolder = z.object({ name: z.string(), path: z.string() });
export type WorkspaceFolder = z.infer<typeof WorkspaceFolder>;

export const WorkspaceFoldersResponse = z.object({ folders: z.array(WorkspaceFolder) });
export type WorkspaceFoldersResponse = z.infer<typeof WorkspaceFoldersResponse>;

export const UpdateProjectSettingsBody = z.object({ gates: ProjectGateOverrides });
export type UpdateProjectSettingsBody = z.input<typeof UpdateProjectSettingsBody>;

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

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

/** A direct child of the workspaces directory: one path segment, no separators, `..` or NUL. */
const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((f) => !/[/\\\0]/.test(f) && f !== '.' && f !== '..', 'must be a single folder name');

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

const CreateProjectFields = z.object({
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
  folder: FolderName.optional(),
});

export const CreateProjectBody = CreateProjectFields.refine(
  (b) => b.source !== 'import_folder' || b.folder !== undefined,
  { path: ['folder'], message: 'folder is required for import_folder' },
).refine((b) => b.source !== 'import_url' || b.repoUrl !== undefined, {
  path: ['repoUrl'],
  message: 'repoUrl is required for import_url',
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const CreateProjectResponse = z.object({
  project: Project,
  /** Terminal running `git clone`, when a repo URL was given. */
  terminalId: z.string().nullable(),
  /** The project exists but a later step failed (e.g. its tickets); shown to the person. */
  warning: z.string().optional(),
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
      /** Stable id within the preview ('bootstrap', 'deploy', 'factory'); `dependsOn` refers to it. */
      key: z.string(),
      title: z.string(),
      persona: AgentPersona,
      /** Keys of the tickets this one depends on. */
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

/** Largest `.emberline/worktree.yml` detection reads and an import may approve. */
export const MAX_WORKTREE_YML_BYTES = 64 * 1024;

/** A repo's own `.emberline/worktree.yml`: `content` is the blob committed in HEAD. */
export const ExistingWorktreeYml = z.object({
  /** HEAD's blob; null when it is not committed or cannot be used (link, not a file, too large). */
  content: z.string().nullable(),
  /** sha256 of `content`; adopt's `worktreeYmlSha256` must match it to approve the file. */
  sha256: z.string().nullable(),
  /** Read or schema errors; a file with errors can never be approved. */
  errors: z.array(z.string()),
  /** The file exists only in the working tree; only HEAD's committed version can be approved. */
  notCommitted: z.boolean(),
  /** The working tree's copy is not HEAD's (edited, deleted or unreadable); `content` is HEAD's. */
  workingTreeDiffers: z.boolean(),
});
export type ExistingWorktreeYml = z.infer<typeof ExistingWorktreeYml>;

export const ProjectDetectResponse = z.object({
  detected: z.object({
    /** Best-effort project type, used to scope the choices. */
    appType: ProjectAppType,
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
    /** Present when the repo has a `.emberline/worktree.yml`. */
    worktreeYml: ExistingWorktreeYml.nullable(),
  }),
  /** Generated content, only for files the repo does not have. */
  suggestions: z.object({
    projectMd: z.string().optional(),
    claudeMd: z.string().optional(),
    worktreeYml: z.string().optional(),
  }),
});
export type ProjectDetectResponse = z.infer<typeof ProjectDetectResponse>;

export const AdoptWriteFile = z.enum(['projectMd', 'claudeMd', 'worktreeYml']);
export type AdoptWriteFile = z.infer<typeof AdoptWriteFile>;

export const AdoptProjectBody = z
  .object({
    /** Detected (or corrected) project type; the project row keeps its type when absent. */
    appType: ProjectAppType.optional(),
    choices: ProjectChoices.default({}),
    gates: ProjectGateOverrides.default({}),
    /** Missing files to write and commit; existing files are never overwritten. */
    write: z.array(AdoptWriteFile).max(3).default([]),
    startFactory: z.boolean().default(false),
    vision: z.string().trim().max(4000).default(''),
    /** The person ticked the repo's own worktree.yml on the summary: store it as approved. */
    approveWorktreeYml: z.boolean().default(false),
    /** sha256 of the worktree.yml content the person reviewed (from detection). */
    worktreeYmlSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .refine((b) => !b.approveWorktreeYml || b.worktreeYmlSha256 !== undefined, {
    path: ['worktreeYmlSha256'],
    message: 'approving the repo\'s worktree.yml needs the sha256 of the reviewed content',
  })
  .refine((b) => !(b.approveWorktreeYml && b.write.includes('worktreeYml')), {
    path: ['approveWorktreeYml'],
    message: 'approve the repo\'s worktree.yml or write a new one, not both',
  })
  .refine((b) => !b.startFactory || b.vision.length > 0, {
    path: ['vision'],
    message: 'starting the factory needs a vision',
  });
export type AdoptProjectBody = z.input<typeof AdoptProjectBody>;

/** Path of each adopt file in the repository. */
export const ADOPT_FILE_PATHS = {
  projectMd: 'PROJECT.md',
  claudeMd: 'CLAUDE.md',
  worktreeYml: '.emberline/worktree.yml',
} as const satisfies Record<AdoptWriteFile, string>;

export const ADOPT_COMMIT_MESSAGE = 'chore: add Emberline project files';

/** `POST /api/projects/:id/adopt/preview`: what adopt would write and commit. No side effects. */
export const AdoptPreviewResponse = z.object({
  /** Repository path -> content, for the ticked missing files. */
  files: z.record(z.string(), z.string()),
  /** Null when nothing is written. */
  commitMessage: z.string().nullable(),
  /** Which worktree.yml runs will use after adopt: Emberline's, the repo's (ticked) or none. */
  worktreeConfig: z.enum(['generated', 'existing']).nullable(),
});
export type AdoptPreviewResponse = z.infer<typeof AdoptPreviewResponse>;

export const AdoptProjectResponse = AdoptPreviewResponse.extend({
  project: Project,
  /** The commit on the checked-out branch, when files were written. Never pushed. */
  commitSha: z.string().nullable(),
  /** The `[Factory]` ticket, when `startFactory` was set. */
  factoryTicketId: z.string().nullable(),
  /** The files were committed but a later step failed (e.g. the ticket); shown to the person. */
  warning: z.string().optional(),
});
export type AdoptProjectResponse = z.infer<typeof AdoptProjectResponse>;

export const WorkspaceFolder = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepo: z.boolean(),
  hasRemote: z.boolean(),
});
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

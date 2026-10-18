/** Shared shapes for the project preset registry (data only, no React). */
import { z } from 'zod';

export const STACK_DIMENSION_IDS = [
  'frontend',
  'backend',
  'database',
  'auth',
  'deploy',
  'language',
  'styling',
  'testing',
] as const;
export const StackDimensionId = z.enum(STACK_DIMENSION_IDS);
export type StackDimensionId = z.infer<typeof StackDimensionId>;

/**
 * One dimension's value: an option id, `none` (layer absent), `agent` (agent decides and records
 * it in PROJECT.md) or free text.
 */
export const StackChoice = z.union([
  z.string().min(1).max(100),
  z.object({ other: z.string().trim().min(1).max(200) }).strict(),
]);
export type StackChoice = z.infer<typeof StackChoice>;

export const ProjectChoices = z.partialRecord(StackDimensionId, StackChoice);
export type ProjectChoices = z.infer<typeof ProjectChoices>;

/** Commands an option contributes to `.emberline/worktree.yml`. */
export interface WorktreeHints {
  setup?: string;
  build?: string;
  test?: string;
  lint?: string;
  /** Long-running dev/preview command; `$PORT` is assigned by Emberline. */
  service?: string;
}

/** Same ids as `ProjectAppType` (kept as a plain string union to avoid a cycle with api/projects). */
export type ProjectTypeId =
  | 'web_saas'
  | 'fullstack'
  | 'api_service'
  | 'ai_agents'
  | 'cli_tool'
  | 'mobile_desktop'
  | 'embedded_iot'
  | 'library'
  | 'game_interactive'
  | 'static_site'
  | 'custom';

export interface ProjectTypeDef {
  id: ProjectTypeId;
  label: string;
  description: string;
  /** lucide icon name. */
  icon: string;
  /** Default architecture notes written into PROJECT.md. */
  archNotes: string;
}

export interface StackOption {
  id: string;
  label: string;
  /** Project types this option applies to. */
  types: readonly ProjectTypeId[];
  worktree?: WorktreeHints;
}

export interface StackDimensionDef {
  id: StackDimensionId;
  label: string;
  /** Shown under "Advanced" in the wizard. */
  advanced: boolean;
  options: readonly StackOption[];
}

export type StarterId = 'static-plain';

export interface PresetDef {
  id: string;
  type: ProjectTypeId;
  label: string;
  description: string;
  /** dimension -> option id | 'none' | 'agent'. */
  choices: Partial<Record<StackDimensionId, string>>;
  /** Built-in file template written at creation, or null (the Bootstrap ticket builds the skeleton). */
  starter: StarterId | null;
  /** Fragments joined into the Bootstrap ticket body. */
  bootstrap: readonly string[];
}

export interface VersionPolicy {
  id: string;
  label: string;
  hint: string;
}

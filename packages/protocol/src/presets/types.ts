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
  z
    .object({
      other: z
        .string()
        .trim()
        .min(1)
        .max(200)
        // eslint-disable-next-line no-control-regex
        .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must be a single line without control characters'),
    })
    .strict(),
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
  /** One short sentence (at most 140 characters): when to pick it, and its main catch if any. */
  bestFor: string;
  /** Project types this option applies to. */
  types: readonly ProjectTypeId[];
  worktree?: WorktreeHints;
}

export interface StackDimensionDef {
  id: StackDimensionId;
  label: string;
  /** Shown under "Advanced" in the wizard. */
  advanced: boolean;
  /** One line: what this choice changes downstream. */
  affects: string;
  options: readonly StackOption[];
}

export type StarterId = 'static-plain';

export interface PresetDef {
  id: string;
  type: ProjectTypeId;
  label: string;
  description: string;
  /** One sentence starting "Best for", at most 140 characters. */
  bestFor: string;
  /** One sentence: the cost, or what you give up, at most 140 characters. */
  tradeoff: string;
  /** dimension -> option id | 'none' | 'agent'. */
  choices: Partial<Record<StackDimensionId, string>>;
  /** Built-in file template written at creation, or null (the Bootstrap ticket builds the skeleton). */
  starter: StarterId | null;
  /**
   * Preset-specific steps for the Bootstrap ticket. The generic steps follow them there, chosen from
   * the final choices (open or decided), so they are not part of the preset.
   */
  bootstrap: readonly string[];
  /**
   * Container port of the compose service `web` that the wizard's compose preview publishes (deploy
   * target Docker Compose with the Docker engine on). Default 8080.
   */
  composePort?: number;
}

export interface VersionPolicy {
  id: string;
  label: string;
  hint: string;
}

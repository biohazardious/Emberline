/**
 * The wizard's creation plan: everything `POST /api/projects` (v2, new project) writes and creates,
 * computed without side effects. The preview endpoint returns it; creation executes it, so the
 * summary and the disk cannot drift apart.
 */
import {
  type CreateProjectBody,
  type DockerEngineStatus,
  dockerEngineOffText,
  findOption,
  getPreset,
  type PresetDef,
  type ProjectAppType,
  type ProjectChoices,
  type ProjectGateOverrides,
  type ProjectMaterialInfo,
  type ProjectTechStack,
  type ReferenceUrl,
  STACK_DIMENSION_IDS,
  type StackChoice,
  type StackDimensionId,
  VISION_MIN_LENGTH,
  visionRequired,
} from '@emberline/protocol';
import { badRequest } from '../errors.js';
import {
  materialsMarkdown,
  materialsTicketText,
  normalizeMaterialInfos,
  type PlannedMaterial,
  planMaterials,
} from './materials.js';
import {
  bootstrapTicket,
  bootstrapWritesWorktree,
  deployTicket,
  describeChoice,
  generateClaudeInstructions,
  generateProjectBlueprint,
  generateWorktreeYml,
  previewsComposeService,
  type WizardTicketSpec,
} from './blueprint.js';
import { factoryTicketTitle } from './orchestration.js';
import { STARTERS } from './starters.js';

export type ProjectCreateInput = ReturnType<typeof CreateProjectBody.parse>;
/**
 * The plan's input: the create body with each file's name, type and decoded size (the preview sends
 * exactly that). A parsed create body (files still carrying `dataBase64`, no size) is accepted too,
 * so callers and tests that pass `CreateProjectBody.parse(...)` straight in keep compiling; the plan
 * only ever reads the sizes of entries that have one.
 */
export type ProjectPlanInput = Omit<ProjectCreateInput, 'materials'> & {
  materials?: readonly (ProjectMaterialInfo | NonNullable<ProjectCreateInput['materials']>[number])[];
};

export interface PlannedTicket {
  key: 'bootstrap' | 'deploy' | 'factory';
  title: string;
  persona: WizardTicketSpec['persona'];
  dependsOn: string[];
}

export interface ProjectPlan {
  appType: ProjectAppType;
  preset: PresetDef | undefined;
  choices: ProjectChoices;
  techStack: ProjectTechStack;
  vision: string;
  gates: ProjectGateOverrides;
  startFactory: boolean;
  /** Bootstrap writes the worktree commands itself (see {@link bootstrapWritesWorktree}). */
  bootstrapWritesWorktree: boolean;
  projectMd: string;
  claudeMd: string;
  worktreeYml: string;
  /** Notes for the summary (what the generated files leave out and why). */
  notes: string[];
  /** Starter file path -> content. */
  starter: Record<string, string>;
  /** Bootstrap and Deploy; the `[Factory]` ticket is built by the ticket service from `vision`. */
  tickets: WizardTicketSpec[];
  /** Reference files in docs/reference/, in the body's order. */
  materials: PlannedMaterial[];
  referenceUrls: ReferenceUrl[];
  /** Bootstrap section body and [Factory] attachment context. */
  materialsText: string;
}

/** True when the body asks for the preset-driven creation flow. */
export function isWizardCreate(body: ProjectCreateInput): boolean {
  return body.source === 'new' || (body.mode === 'wizard' && body.presetId !== undefined);
}

/** `none` and `agent` are always valid; an option id must exist in the dimension and fit the type. */
export function validateChoices(choices: ProjectChoices, appType: ProjectAppType): void {
  for (const [dimension, choice] of Object.entries(choices) as [StackDimensionId, StackChoice][]) {
    if (typeof choice !== 'string' || choice === 'none' || choice === 'agent') continue;
    const option = findOption(dimension, choice);
    if (!option) throw badRequest(`choices.${dimension}: "${choice}" is not a ${dimension} option`);
    if (!option.types.includes(appType)) {
      throw badRequest(`choices.${dimension}: "${choice}" does not apply to ${appType} projects`);
    }
  }
}

/** Legacy `techStack` text derived from the choices, so the project row and old views keep working. */
export function techStackFromChoices(choices: ProjectChoices, versionPolicy?: string): ProjectTechStack {
  const text = (id: StackDimensionId): string => {
    const choice = choices[id];
    if (choice === undefined || choice === 'none') return '';
    return describeChoice(id, choice);
  };
  return {
    language: text('language'),
    frontend: text('frontend'),
    backend: text('backend'),
    database: text('database'),
    styling: text('styling'),
    testing: text('testing'),
    ...(versionPolicy ? { versionPolicy } : {}),
  };
}

/** The summary's note when a Docker Compose project gets a command preview because the engine is on but does not answer. */
export const ENABLE_DOCKER_NOTE =
  'The deploy target is Docker Compose: previewing the container needs the Docker engine, which is on by default (EMBERLINE_DOCKER_ENGINE=0 turns it off). Until it answers, the preview runs the dev command.';

/** The summary's note for a Docker Compose project without a container preview; an engine that is not on says why. */
export function dockerComposeNote(engine: DockerEngineStatus | undefined): string {
  if (engine?.enabled) return ENABLE_DOCKER_NOTE;
  return `The deploy target is Docker Compose: previewing the container needs the Docker engine, so the preview runs the dev command. ${dockerEngineOffText(engine)}`;
}

/**
 * `dockerEngine`: the Docker engine answers right now. A Docker Compose deploy target then previews
 * its container (worktree.yml v2); otherwise the summary says how to get that, by `engine`'s state.
 */
export function planNewProject(
  input: ProjectPlanInput,
  { dockerEngine = false, engine }: { dockerEngine?: boolean; engine?: DockerEngineStatus } = {},
): ProjectPlan {
  // Everything below sees the files as name, type and decoded size, whichever shape came in.
  const body = { ...input, materials: normalizeMaterialInfos(input.materials) };
  const preset = body.presetId === undefined ? undefined : getPreset(body.presetId);
  if (body.presetId !== undefined && !preset) throw badRequest(`unknown preset "${body.presetId}"`);
  if (preset && body.appType !== 'custom' && body.appType !== preset.type) {
    throw badRequest(`preset "${preset.id}" is a ${preset.type} preset, not ${body.appType}`);
  }
  const appType: ProjectAppType = preset && body.appType === 'custom' ? preset.type : body.appType;
  const userChoices = body.choices ?? {};
  validateChoices(userChoices, appType);

  const choices: ProjectChoices = {};
  for (const id of STACK_DIMENSION_IDS) {
    const value = userChoices[id] ?? preset?.choices[id];
    if (value !== undefined) choices[id] = value;
  }

  const vision = (body.vision ?? body.description).trim();
  if (visionRequired(preset?.id, choices) && vision.length < VISION_MIN_LENGTH) {
    throw badRequest(
      `vision: describe the project in at least ${VISION_MIN_LENGTH} characters; the agent picks the open stack choices from it`,
    );
  }
  const versionPolicy = body.techStack?.versionPolicy;
  const starter = preset?.starter ? STARTERS[preset.starter]({ name: body.name, description: vision }) : {};
  const reserved = ['PROJECT.md', 'CLAUDE.md', '.emberline/worktree.yml', ...Object.keys(starter)];
  const materials = planMaterials(body.materials, reserved);
  const referenceUrls = body.referenceUrls ?? [];
  const materialsText = materialsTicketText(materials, referenceUrls);
  const projectMd = generateProjectBlueprint({
    name: body.name,
    appType,
    description: vision,
    choices,
    versionPolicy,
    architectureNotes: body.architectureNotes,
    referenceDocs: body.referenceDocs,
    referenceMaterial: materialsMarkdown(materials, referenceUrls),
  });
  const composePreview = previewsComposeService(choices, preset, { dockerEngine });
  const startFactory = body.startFactory ?? true;
  const ctx = {
    name: body.name,
    appType,
    choices,
    preset,
    vision,
    composePreview,
    factoryPlans: startFactory && vision.length > 0,
    materialsText,
    referenceFiles: materials.length > 0,
  };
  const tickets = [bootstrapTicket(ctx), deployTicket(ctx)].filter((x): x is WizardTicketSpec => x !== null);

  return {
    appType,
    preset,
    choices,
    techStack: techStackFromChoices(choices, versionPolicy),
    vision,
    gates: body.gates ?? {},
    startFactory,
    bootstrapWritesWorktree: bootstrapWritesWorktree(choices, preset),
    projectMd,
    claudeMd: generateClaudeInstructions(body.name),
    worktreeYml: generateWorktreeYml(choices, preset, { dockerEngine }),
    notes: !composePreview && choices.deploy === 'docker-compose' ? [dockerComposeNote(engine)] : [],
    starter,
    tickets,
    materials,
    referenceUrls,
    materialsText,
  };
}

/** The ticket list the summary shows; the `[Factory]` ticket exists only when the factory starts and there is a vision. */
export function plannedTickets(plan: ProjectPlan): PlannedTicket[] {
  const list: PlannedTicket[] = plan.tickets.map(({ key, title, persona, dependsOn }) => ({
    key,
    title,
    persona,
    dependsOn,
  }));
  if (plan.startFactory && plan.vision) {
    list.push({
      key: 'factory',
      title: factoryTicketTitle(plan.vision),
      persona: 'product_owner',
      dependsOn: ['bootstrap'],
    });
  }
  return list;
}

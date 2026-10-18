/**
 * The wizard's creation plan: everything `POST /api/projects` (v2, new project) writes and creates,
 * computed without side effects. The preview endpoint returns it; creation executes it, so the
 * summary and the disk cannot drift apart.
 */
import {
  type CreateProjectBody,
  findOption,
  getPreset,
  type PresetDef,
  type ProjectAppType,
  type ProjectChoices,
  type ProjectGateOverrides,
  type ProjectTechStack,
  STACK_DIMENSION_IDS,
  type StackChoice,
  type StackDimensionId,
} from '@emberline/protocol';
import { badRequest } from '../errors.js';
import {
  bootstrapTicket,
  deployTicket,
  describeChoice,
  generateClaudeInstructions,
  generateProjectBlueprint,
  generateWorktreeYml,
  type WizardTicketSpec,
} from './blueprint.js';
import { factoryTicketTitle } from './orchestration.js';
import { STARTERS } from './starters.js';

export type ProjectCreateInput = ReturnType<typeof CreateProjectBody.parse>;

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
  projectMd: string;
  claudeMd: string;
  worktreeYml: string;
  /** Starter file path -> content. */
  starter: Record<string, string>;
  /** Bootstrap and Deploy; the `[Factory]` ticket is built by the ticket service from `vision`. */
  tickets: WizardTicketSpec[];
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

export function planNewProject(body: ProjectCreateInput): ProjectPlan {
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
  const versionPolicy = body.techStack?.versionPolicy;
  const projectMd = generateProjectBlueprint({
    name: body.name,
    appType,
    description: vision,
    choices,
    versionPolicy,
    architectureNotes: body.architectureNotes,
    referenceDocs: body.referenceDocs,
  });
  const starter = preset?.starter ? STARTERS[preset.starter]({ name: body.name, description: vision }) : {};
  const ctx = { name: body.name, appType, choices, preset };
  const tickets = [bootstrapTicket(ctx), deployTicket(ctx)].filter((x): x is WizardTicketSpec => x !== null);

  return {
    appType,
    preset,
    choices,
    techStack: techStackFromChoices(choices, versionPolicy),
    vision,
    gates: body.gates ?? {},
    startFactory: body.startFactory ?? true,
    projectMd,
    claudeMd: generateClaudeInstructions(body.name),
    worktreeYml: generateWorktreeYml(choices, preset),
    starter,
    tickets,
  };
}

/** The ticket list the summary shows; the `[Factory]` ticket exists only when the factory starts and there is a vision. */
export function plannedTickets(plan: ProjectPlan): PlannedTicket[] {
  const list: PlannedTicket[] = plan.tickets.map(({ key, title, persona, dependsOn }) => ({ key, title, persona, dependsOn }));
  if (plan.startFactory && plan.vision) {
    list.push({ key: 'factory', title: factoryTicketTitle(plan.vision), persona: 'product_owner', dependsOn: ['bootstrap'] });
  }
  return list;
}

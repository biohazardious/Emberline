/** Pure state, validation and request bodies of the project wizard (no React). */
import {
  type AdoptProjectBody,
  type AdoptWriteFile,
  type CreateProjectBody,
  CreateProjectBody as CreateProjectBodySchema,
  findOption,
  getDimension,
  getPreset,
  getProjectType,
  GitBranchName,
  type PresetDef,
  type ProjectChoices,
  type ProjectDetectResponse,
  type ProjectGateKey,
  ProjectGateOverrides,
  type ProjectTypeId,
  presetsForType,
  PROJECT_CONFLICT,
  STACK_DIMENSION_IDS,
  StackChoice,
  type StackDimensionId,
  VERSION_POLICIES,
  type WorkspaceFolder,
} from '@emberline/protocol';
import type { GateChoice } from '../../projectSettings';

export type WizardSource = 'preset' | 'blank' | 'import_url' | 'import_folder';
export type StepId = 'start' | 'type' | 'repo' | 'import' | 'stack' | 'factory' | 'summary';

/** Files adopt can add, in the order it writes them. */
export const ADOPT_FILES: readonly AdoptWriteFile[] = ['projectMd', 'claudeMd', 'worktreeYml'];

export interface WizardState {
  step: StepId;
  /** Index (in `stepsFor(source)`) of the furthest step reached; the rail goes forward up to it. */
  furthest: number;
  source: WizardSource | null;
  name: string;
  /** Server message for the name (e.g. a 409 duplicate); cleared when the name changes. */
  nameError: string | null;
  appType: ProjectTypeId | null;
  presetId: string | null;
  vision: string;
  referenceDocs: string;
  choices: ProjectChoices;
  /** Dimensions the person changed; type and preset changes keep them. */
  dirty: StackDimensionId[];
  defaultBranch: string;
  versionPolicy: string;
  gates: ProjectGateOverrides;
  startFactory: boolean;
  repoUrl: string;
  folder: string;
  /** The project an import registered (clone or folder); the steps before it are locked. */
  importProjectId: string | null;
  detect: ProjectDetectResponse | null;
  write: AdoptWriteFile[];
  approveWorktreeYml: boolean;
}

type TextField = 'name' | 'vision' | 'referenceDocs' | 'defaultBranch' | 'versionPolicy' | 'repoUrl' | 'folder';

export type WizardAction =
  | { type: 'source'; source: WizardSource }
  | { type: 'field'; field: TextField; value: string }
  | { type: 'field'; field: 'startFactory'; value: boolean }
  | { type: 'appType'; appType: ProjectTypeId }
  | { type: 'preset'; presetId: string }
  | { type: 'choice'; dimension: StackDimensionId; value: StackChoice }
  | { type: 'gate'; key: ProjectGateKey; choice: GateChoice }
  | { type: 'go'; step: StepId }
  | { type: 'nameError'; message: string | null }
  | { type: 'importCreated'; projectId: string }
  | { type: 'importCancelled' }
  | { type: 'detected'; detect: ProjectDetectResponse }
  | { type: 'write'; file: AdoptWriteFile; on: boolean }
  | { type: 'approveWorktreeYml'; on: boolean }
  | { type: 'restore'; draft: WizardDraft }
  | { type: 'reset' };

export function initialWizardState(): WizardState {
  return {
    step: 'start',
    furthest: 0,
    source: null,
    name: '',
    nameError: null,
    appType: null,
    presetId: null,
    vision: '',
    referenceDocs: '',
    choices: {},
    dirty: [],
    defaultBranch: 'main',
    versionPolicy: VERSION_POLICIES[0]!.id,
    gates: {},
    startFactory: true,
    repoUrl: '',
    folder: '',
    importProjectId: null,
    detect: null,
    write: [],
    approveWorktreeYml: false,
  };
}

export const isImport = (source: WizardSource | null): source is 'import_url' | 'import_folder' =>
  source === 'import_url' || source === 'import_folder';

export function stepsFor(source: WizardSource | null): StepId[] {
  return isImport(source)
    ? ['start', 'repo', 'import', 'stack', 'factory', 'summary']
    : ['start', 'type', 'stack', 'factory', 'summary'];
}

export function stepLabel(step: StepId, source: WizardSource | null): string {
  switch (step) {
    case 'start':
      return 'Start';
    case 'type':
      return 'Type and preset';
    case 'repo':
      return source === 'import_folder' ? 'Folder' : 'Repository';
    case 'import':
      return source === 'import_folder' ? 'Inspect' : 'Clone';
    case 'stack':
      return 'Stack';
    case 'factory':
      return 'Factory';
    case 'summary':
      return 'Summary';
  }
}

// --- validation -------------------------------------------------------------

/** Why a project name is not accepted, or null. Mirrors the API (1-80 chars, a letter or digit for the slug). */
export function nameProblem(name: string): string | null {
  const v = name.trim();
  if (!v) return 'Enter a project name.';
  if (v.length > 80) return 'Use at most 80 characters for the name.';
  if (!/[\p{L}\p{N}]/u.test(v)) return 'The name needs at least one letter or digit.';
  return null;
}

export function urlProblem(url: string): string | null {
  if (!url.trim()) return 'Enter the repository URL.';
  const ok = CreateProjectBodySchema.safeParse({ name: 'x', source: 'import_url', repoUrl: url }).success;
  return ok ? null : 'Use an https://, ssh:// or git@ repository URL.';
}

export function branchProblem(branch: string): string | null {
  return GitBranchName.safeParse(branch).success ? null : 'Enter a valid branch name (letters, digits, ".", "_", "/", "-").';
}

/** An Other choice must be one line of 1-200 characters; option ids, none and agent always pass. */
export function choiceProblem(choice: StackChoice | undefined): string | null {
  if (choice === undefined || typeof choice === 'string') return null;
  return StackChoice.safeParse({ other: choice.other }).success ? null : 'Describe it in one line (1-200 characters).';
}

/** The first thing keeping `step` from being valid, or null when it is. */
export function stepProblem(s: WizardState, step: StepId): string | null {
  switch (step) {
    case 'start':
      return s.source ? null : 'Choose how to start.';
    case 'type': {
      const n = nameProblem(s.name);
      if (n) return n;
      if (!s.appType) return 'Choose a project type.';
      const preset = s.presetId ? getPreset(s.presetId) : undefined;
      if (!preset || preset.type !== s.appType) return 'Choose a preset for this type.';
      return null;
    }
    case 'repo':
      // In the order the step shows its fields.
      if (s.source === 'import_folder') return s.folder ? nameProblem(s.name) : 'Pick a folder.';
      return urlProblem(s.repoUrl) ?? nameProblem(s.name) ?? branchProblem(s.defaultBranch);
    case 'import':
      return s.detect ? null : 'Wait for the repository to be inspected.';
    case 'stack': {
      for (const id of STACK_DIMENSION_IDS) {
        const p = choiceProblem(s.choices[id]);
        if (p) return `${getDimension(id)?.label ?? id}: ${p}`;
      }
      if (!isImport(s.source)) return branchProblem(s.defaultBranch);
      return null;
    }
    case 'factory':
      return isImport(s.source) && s.startFactory && !s.vision.trim()
        ? 'Describe the vision to start the factory, or choose "Create only".'
        : null;
    case 'summary':
      return null;
  }
}

export const isStepValid = (s: WizardState, step: StepId) => stepProblem(s, step) === null;

/** Import steps that no longer apply once the project exists (or detection ran). */
export function isStepLocked(s: WizardState, step: StepId): boolean {
  if (!isImport(s.source) || s.importProjectId === null) return false;
  if (step === 'start' || step === 'repo') return true;
  return step === 'import' && s.detect !== null;
}

/** The rail: back freely, forward only up to the furthest step reached while every step before it is valid. */
export function canVisit(s: WizardState, step: StepId): boolean {
  const steps = stepsFor(s.source);
  const target = steps.indexOf(step);
  if (target < 0 || isStepLocked(s, step)) return false;
  if (target <= steps.indexOf(s.step)) return true;
  if (target > s.furthest) return false;
  return steps.slice(0, target).every((x) => isStepLocked(s, x) || isStepValid(s, x));
}

export function previousStep(s: WizardState): StepId | null {
  const steps = stepsFor(s.source);
  for (let i = steps.indexOf(s.step) - 1; i >= 0; i--) {
    if (!isStepLocked(s, steps[i]!)) return steps[i]!;
  }
  return null;
}

export function nextStep(s: WizardState): StepId | null {
  const steps = stepsFor(s.source);
  return steps[steps.indexOf(s.step) + 1] ?? null;
}

// --- choices ----------------------------------------------------------------

/** A dimension's value is usable for a type: none/agent/Other always, an option id only where it applies. */
function fitsType(dimension: StackDimensionId, choice: StackChoice, type: ProjectTypeId): boolean {
  if (typeof choice !== 'string' || choice === 'none' || choice === 'agent') return true;
  return findOption(dimension, choice)?.types.includes(type) ?? false;
}

/** Every dimension of a preset; one it leaves open is "let the agent decide", so all choices are explicit. */
export function presetChoices(preset: PresetDef): ProjectChoices {
  const out: ProjectChoices = {};
  for (const id of STACK_DIMENSION_IDS) out[id] = preset.choices[id] ?? 'agent';
  return out;
}

/**
 * New defaults (a type or preset change) over the current choices: dimensions the person changed
 * stay while they fit the type; the rest take the defaults.
 */
export function mergeDefaults(
  current: ProjectChoices,
  dirty: readonly StackDimensionId[],
  defaults: ProjectChoices,
  type: ProjectTypeId,
): { choices: ProjectChoices; dirty: StackDimensionId[] } {
  const choices: ProjectChoices = {};
  const keep: StackDimensionId[] = [];
  for (const id of STACK_DIMENSION_IDS) {
    const mine = current[id];
    if (dirty.includes(id) && mine !== undefined && fitsType(id, mine, type)) {
      choices[id] = mine;
      keep.push(id);
    } else if (defaults[id] !== undefined) {
      choices[id] = defaults[id];
    }
  }
  return { choices, dirty: keep };
}

/** Detection's choices for its type: unknown or foreign option ids and gaps become "agent". */
function detectedChoices(detect: ProjectDetectResponse, type: ProjectTypeId): ProjectChoices {
  const out: ProjectChoices = {};
  for (const id of STACK_DIMENSION_IDS) {
    const v = detect.detected.choices[id];
    out[id] = v !== undefined && fitsType(id, v, type) ? v : 'agent';
  }
  return out;
}

/** Files adopt may write: missing in the repository and with a suggestion. */
export function writableFiles(detect: ProjectDetectResponse | null): AdoptWriteFile[] {
  if (!detect) return [];
  return ADOPT_FILES.filter((f) => !detect.detected.files[f] && detect.suggestions[f] !== undefined);
}

/** The repository's own worktree.yml can be approved: committed in HEAD, readable and schema-valid. */
export function canApproveRepoWorktreeYml(detect: ProjectDetectResponse | null): boolean {
  const own = detect?.detected.worktreeYml;
  return Boolean(own && own.content !== null && own.sha256 && own.errors.length === 0 && !own.notCommitted);
}

/** The label of a choice for the summary. */
export function choiceLabel(dimension: StackDimensionId, choice: StackChoice | undefined): string {
  if (choice === undefined) return 'Not set';
  if (typeof choice !== 'string') return `Other: ${choice.other.trim()}`;
  if (choice === 'none') return 'None';
  if (choice === 'agent') return 'Let the agent decide';
  return findOption(dimension, choice)?.label ?? choice;
}

// --- names ------------------------------------------------------------------

/** "https://host/acme/shop.git" -> "shop"; also scp-style git@host:acme/shop. */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/**
 * A URL without credentials: userinfo goes from https URLs, an ssh URL keeps only its user name.
 * scp-style `git@host:path` has no secret and stays as it is.
 */
export function stripUrlCredentials(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i.exec(url);
  if (!m) return url;
  const [whole, scheme, userinfo] = m as unknown as [string, string, string];
  const rest = url.slice(whole.length);
  if (/^ssh:/i.test(scheme)) return `${scheme}${userinfo.split(':')[0]}@${rest}`;
  return `${scheme}${rest}`;
}

/** "Use a folder" is offered only when at least one folder can be imported (a git repository). */
export const hasImportableFolders = (folders: readonly WorkspaceFolder[]) => folders.some((f) => f.isGitRepo);

/** A 409 that belongs on the name field: the name's slug is taken or its directory already exists. */
export function isNameConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, code } = err as { status?: unknown; code?: unknown };
  return status === 409 && (code === PROJECT_CONFLICT.nameTaken || code === PROJECT_CONFLICT.directoryExists);
}

/** The name follows the URL or folder until the person types their own. */
function followName(name: string, before: string, after: string): string {
  return name.trim() === '' || name === before ? after : name;
}

// --- reducer ----------------------------------------------------------------

function withPreset(s: WizardState, appType: ProjectTypeId, presetId: string | null): WizardState {
  const preset = presetId ? getPreset(presetId) : undefined;
  const merged = preset
    ? mergeDefaults(s.choices, s.dirty, presetChoices(preset), appType)
    : mergeDefaults(s.choices, s.dirty, {}, appType);
  return { ...s, appType, presetId: preset ? preset.id : null, ...merged };
}

function goTo(s: WizardState, step: StepId): WizardState {
  const steps = stepsFor(s.source);
  const target = steps.indexOf(step);
  const isNext = target === steps.indexOf(s.step) + 1 && isStepValid(s, s.step) && !isStepLocked(s, step);
  if (!canVisit(s, step) && !isNext) return s;
  return { ...s, step, furthest: Math.max(s.furthest, target) };
}

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case 'source': {
      if (s.importProjectId !== null || s.source === a.source) return s;
      const next: WizardState = { ...s, source: a.source, furthest: 0, startFactory: !isImport(a.source) };
      if (a.source === 'blank') return withPreset(next, 'custom', 'custom-blank');
      if (a.source === 'preset' && s.presetId === 'custom-blank') return { ...next, appType: null, presetId: null };
      return next;
    }
    case 'field': {
      if (a.field === 'startFactory') return { ...s, startFactory: a.value };
      if (a.field === 'name') return { ...s, name: a.value, nameError: null };
      if (a.field === 'repoUrl') {
        const name = followName(s.name, repoNameFromUrl(s.repoUrl), repoNameFromUrl(a.value));
        return { ...s, repoUrl: a.value, name, nameError: name === s.name ? s.nameError : null };
      }
      if (a.field === 'folder') {
        const name = followName(s.name, s.folder, a.value);
        return { ...s, folder: a.value, name, nameError: name === s.name ? s.nameError : null };
      }
      return { ...s, [a.field]: a.value };
    }
    case 'appType': {
      if (s.appType === a.appType) return s;
      const current = s.presetId ? getPreset(s.presetId) : undefined;
      const presetId = isImport(s.source)
        ? null
        : current?.type === a.appType
          ? current.id
          : (presetsForType(a.appType)[0]?.id ?? null);
      if (isImport(s.source) && s.detect) {
        return { ...s, appType: a.appType, ...mergeDefaults(s.choices, s.dirty, detectedChoices(s.detect, a.appType), a.appType) };
      }
      return withPreset(s, a.appType, presetId);
    }
    case 'preset': {
      const preset = getPreset(a.presetId);
      if (!preset || preset.id === s.presetId) return s;
      return withPreset(s, preset.type, preset.id);
    }
    case 'choice':
      return {
        ...s,
        choices: { ...s.choices, [a.dimension]: a.value },
        dirty: s.dirty.includes(a.dimension) ? s.dirty : [...s.dirty, a.dimension],
      };
    case 'gate': {
      const gates = { ...s.gates };
      if (a.choice === 'inherit') delete gates[a.key];
      else gates[a.key] = a.choice === 'on';
      return { ...s, gates };
    }
    case 'go':
      return goTo(s, a.step);
    case 'nameError':
      return { ...s, nameError: a.message };
    case 'importCreated': {
      if (!isImport(s.source)) return s;
      const steps = stepsFor(s.source);
      return { ...s, importProjectId: a.projectId, detect: null, step: 'import', furthest: steps.indexOf('import') };
    }
    case 'importCancelled': {
      if (!isImport(s.source)) return s;
      return { ...s, importProjectId: null, detect: null, write: [], approveWorktreeYml: false, step: 'repo', furthest: 1 };
    }
    case 'detected': {
      if (!isImport(s.source)) return s;
      const appType = a.detect.detected.appType;
      const steps = stepsFor(s.source);
      return {
        ...s,
        detect: a.detect,
        appType,
        presetId: null,
        choices: detectedChoices(a.detect, appType),
        dirty: [],
        write: writableFiles(a.detect),
        approveWorktreeYml: false,
        step: 'stack',
        furthest: Math.max(s.furthest, steps.indexOf('stack')),
      };
    }
    case 'write': {
      if (a.on && !writableFiles(s.detect).includes(a.file)) return s;
      const write = ADOPT_FILES.filter((f) => (f === a.file ? a.on : s.write.includes(f)));
      return { ...s, write };
    }
    case 'approveWorktreeYml':
      if (a.on && !canApproveRepoWorktreeYml(s.detect)) return s;
      return { ...s, approveWorktreeYml: a.on };
    case 'restore':
      return restoreDraft(a.draft);
    case 'reset':
      return initialWizardState();
  }
}

// --- request bodies ---------------------------------------------------------

/** Choices as the API takes them: Other text trimmed. */
function cleanChoices(choices: ProjectChoices): ProjectChoices {
  const out: ProjectChoices = {};
  for (const id of STACK_DIMENSION_IDS) {
    const v = choices[id];
    if (v !== undefined) out[id] = typeof v === 'string' ? v : { other: v.other.trim() };
  }
  return out;
}

/** `POST /api/projects` (and its preview) for the current source. */
export function buildCreateBody(s: WizardState): CreateProjectBody {
  const name = s.name.trim();
  if (s.source === 'import_url') {
    return { name, source: 'import_url', repoUrl: s.repoUrl.trim(), defaultBranch: s.defaultBranch.trim() };
  }
  if (s.source === 'import_folder') return { name, source: 'import_folder', folder: s.folder };
  const referenceDocs = s.referenceDocs.trim();
  return {
    name,
    source: 'new',
    mode: 'wizard',
    appType: s.appType ?? 'custom',
    ...(s.presetId ? { presetId: s.presetId } : {}),
    choices: cleanChoices(s.choices),
    gates: { ...s.gates },
    startFactory: s.startFactory,
    vision: s.vision.trim(),
    defaultBranch: s.defaultBranch.trim() || 'main',
    techStack: { versionPolicy: s.versionPolicy },
    ...(referenceDocs ? { referenceDocs } : {}),
  };
}

/** `POST /api/projects/:id/adopt` (and its preview). */
export function buildAdoptBody(s: WizardState): AdoptProjectBody {
  const approve = s.approveWorktreeYml && canApproveRepoWorktreeYml(s.detect);
  const writable = writableFiles(s.detect);
  const sha = s.detect?.detected.worktreeYml?.sha256;
  return {
    ...(s.appType ? { appType: s.appType } : {}),
    choices: cleanChoices(s.choices),
    gates: { ...s.gates },
    write: s.write.filter((f) => writable.includes(f) && !(approve && f === 'worktreeYml')),
    startFactory: s.startFactory,
    vision: s.vision.trim(),
    approveWorktreeYml: approve,
    ...(approve && sha ? { worktreeYmlSha256: sha } : {}),
  };
}

// --- drafts -----------------------------------------------------------------

export const DRAFT_KEY = 'emberline.wizard.draft';

/** What sessionStorage keeps: the person's choices only, never server state. */
export interface WizardDraft {
  v: 1;
  step: StepId;
  source: WizardSource | null;
  name: string;
  appType: ProjectTypeId | null;
  presetId: string | null;
  vision: string;
  referenceDocs: string;
  choices: ProjectChoices;
  dirty: StackDimensionId[];
  defaultBranch: string;
  versionPolicy: string;
  gates: ProjectGateOverrides;
  startFactory: boolean;
  repoUrl: string;
  folder: string;
}

/** Anything the person entered; an import that registered its project counts too. */
export const isDirty = (s: WizardState) => s.source !== null || s.importProjectId !== null;

/** The draft to keep, or null (nothing entered, or an import whose project already exists). */
export function draftOf(s: WizardState): WizardDraft | null {
  if (!isDirty(s) || s.importProjectId !== null) return null;
  return {
    v: 1,
    step: s.step,
    source: s.source,
    name: s.name,
    appType: s.appType,
    presetId: s.presetId,
    vision: s.vision,
    referenceDocs: s.referenceDocs,
    choices: s.choices,
    dirty: s.dirty,
    defaultBranch: s.defaultBranch,
    versionPolicy: s.versionPolicy,
    gates: s.gates,
    startFactory: s.startFactory,
    // sessionStorage is readable by any script on the origin: never keep a token from the URL.
    repoUrl: stripUrlCredentials(s.repoUrl),
    folder: s.folder,
  };
}

const SOURCES: readonly WizardSource[] = ['preset', 'blank', 'import_url', 'import_folder'];
const STEPS: readonly StepId[] = ['start', 'type', 'repo', 'import', 'stack', 'factory', 'summary'];
const STRING_FIELDS = ['name', 'vision', 'referenceDocs', 'defaultBranch', 'versionPolicy', 'repoUrl', 'folder'] as const;

/**
 * A stored draft, or null when it is missing or corrupt (not JSON, another version, a field of the
 * wrong JSON type). Unknown values inside a well-formed draft are dropped, not trusted.
 */
export function parseDraft(raw: string | null): WizardDraft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1) return null;
  const base = draftOf({ ...initialWizardState(), source: 'preset' })!;
  for (const f of STRING_FIELDS) {
    if (d[f] !== undefined && typeof d[f] !== 'string') return null;
  }
  if (d.startFactory !== undefined && typeof d.startFactory !== 'boolean') return null;

  const appType = typeof d.appType === 'string' && getProjectType(d.appType) ? (d.appType as ProjectTypeId) : null;
  const preset = typeof d.presetId === 'string' ? getPreset(d.presetId) : undefined;
  const choices: ProjectChoices = {};
  const rawChoices = d.choices && typeof d.choices === 'object' ? (d.choices as Record<string, unknown>) : {};
  for (const id of STACK_DIMENSION_IDS) {
    const parsed = StackChoice.safeParse(rawChoices[id]);
    if (parsed.success && (appType === null || fitsType(id, parsed.data, appType))) choices[id] = parsed.data;
  }
  const gates = ProjectGateOverrides.safeParse(d.gates);
  const str = (f: (typeof STRING_FIELDS)[number]) => (typeof d[f] === 'string' ? (d[f] as string) : base[f]);
  return {
    v: 1,
    step: STEPS.includes(d.step as StepId) ? (d.step as StepId) : 'start',
    source: SOURCES.includes(d.source as WizardSource) ? (d.source as WizardSource) : null,
    name: str('name').slice(0, 200),
    appType,
    presetId: preset && preset.type === appType ? preset.id : null,
    vision: str('vision'),
    referenceDocs: str('referenceDocs'),
    choices,
    dirty: Array.isArray(d.dirty)
      ? STACK_DIMENSION_IDS.filter((id) => (d.dirty as unknown[]).includes(id) && choices[id] !== undefined)
      : [],
    defaultBranch: str('defaultBranch'),
    versionPolicy: VERSION_POLICIES.some((p) => p.id === d.versionPolicy) ? (d.versionPolicy as string) : base.versionPolicy,
    gates: gates.success ? gates.data : {},
    startFactory: typeof d.startFactory === 'boolean' ? d.startFactory : !isImport(d.source as WizardSource),
    repoUrl: stripUrlCredentials(str('repoUrl')),
    folder: str('folder'),
  };
}

/** The state of a draft, on the furthest of its steps the rail can reach (never past an import's creation). */
function restoreDraft(d: WizardDraft): WizardState {
  const { v: _version, ...fields } = d;
  const s: WizardState = { ...initialWizardState(), ...fields, nameError: null, furthest: 0, step: 'start' };
  const steps = stepsFor(s.source);
  const wanted = Math.max(0, steps.indexOf(d.step));
  let at = 0;
  for (let i = 1; i <= wanted; i++) {
    const step = steps[i]!;
    // Import steps from `import` on need the server; the draft stops at the repository step.
    if (step === 'import' || !isStepValid(s, steps[i - 1]!)) break;
    at = i;
  }
  return { ...s, step: steps[at]!, furthest: at };
}

/** One gate row in the Factory step: the choice and the three options, Inherit naming the global value. */
export function gateOptions(
  global: Partial<Record<ProjectGateKey, boolean>> | undefined,
  key: ProjectGateKey,
): { value: GateChoice; label: string }[] {
  const g = global?.[key];
  return [
    { value: 'inherit', label: g === undefined ? 'Inherit (global)' : `Inherit (${g ? 'On' : 'Off'})` },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
}


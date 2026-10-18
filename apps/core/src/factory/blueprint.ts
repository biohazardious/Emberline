/** Project blueprint (PROJECT.md / CLAUDE.md), git init, starter tickets and task templates. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findOption,
  getDimension,
  getProjectType,
  type PresetDef,
  type Project,
  type ProjectAppType,
  type ProjectBlueprintResponse,
  type ProjectChoices,
  PROJECT_TYPES,
  type ProjectTechStack,
  type StackChoice,
  type StackDimensionId,
  type TaskTemplate,
  type Ticket,
  type WorktreeHints,
} from '@emberline/protocol';
import { execGitFile } from '../git-exec.js';
import type { TicketService } from '../tickets/service.js';

/** Labels come from the protocol registry, the only source for project type names. */
export const APP_TYPE_LABELS = Object.fromEntries(PROJECT_TYPES.map((t) => [t.id, t.label])) as Record<
  ProjectAppType,
  string
>;

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'po-prd-breakdown',
    label: 'PRD & Epic Breakdown',
    category: 'Product & Planning',
    persona: 'product_owner',
    permissionMode: 'auto',
    titlePlaceholder: 'Refine PROJECT.md & define acceptance criteria for next milestone',
    promptTemplate: `Review PROJECT.md and the current codebase structure.
1. Identify any missing user flows, edge cases, or underspecified requirements.
2. Update PROJECT.md with clear, testable acceptance criteria and milestone checklists.
3. Summarize the recommended implementation order.`,
  },
  {
    id: 'arch-system-design',
    label: 'Architecture & Module Design',
    category: 'Architecture',
    persona: 'architect',
    permissionMode: 'auto',
    titlePlaceholder: 'Design module boundaries & core interfaces',
    promptTemplate: `Read PROJECT.md and inspect the repository layout.
1. Design or refine the core domain types, API contracts, and module boundaries.
2. Scaffold or update the foundational interfaces and directory structure.
3. Document key architectural invariants in PROJECT.md.`,
  },
  {
    id: 'coder-feature',
    label: 'End-to-End Feature Implementation',
    category: 'Engineering',
    persona: 'coder',
    permissionMode: 'auto',
    titlePlaceholder: 'Implement [feature name] with tests',
    promptTemplate: `Implement the following feature end-to-end according to PROJECT.md conventions:
- Feature goal: [describe goal]
- Key requirements:
  1. Implement backend/domain logic and validation
  2. Wire up UI / API integration
  3. Add unit or integration tests and verify the build passes`,
  },
  {
    id: 'coder-bugfix',
    label: 'Root-Cause Bug Investigation & Fix',
    category: 'Engineering',
    persona: 'coder',
    permissionMode: 'auto',
    titlePlaceholder: 'Fix [symptom / bug description]',
    promptTemplate: `Investigate and fix the following bug:
- Observed behavior: [describe issue]
- Expected behavior: [describe expected]
1. Locate the root cause in the codebase.
2. Write a reproduction test first if possible.
3. Apply a clean, minimal fix and verify all existing tests pass.`,
  },
  {
    id: 'ui-ux-polish',
    label: 'UI/UX Polish & Responsive Pass',
    category: 'Design & Frontend',
    persona: 'ui_ux',
    permissionMode: 'auto',
    titlePlaceholder: 'Polish UI layout, empty states & interactions',
    promptTemplate: `Perform a UI/UX polish pass on the application interface:
1. Improve visual hierarchy, spacing, typography, and empty/loading/error states.
2. Ensure keyboard accessibility, focus states, and responsive behavior.
3. Keep styling consistent with the existing design tokens in the project.`,
  },
  {
    id: 'dba-schema-migration',
    label: 'Database Schema & Migration',
    category: 'Data Layer',
    persona: 'dba',
    permissionMode: 'auto',
    titlePlaceholder: 'Design schema & migration for [entity/domain]',
    promptTemplate: `Design and implement the database schema and data access layer changes:
1. Define normalized tables/models, foreign keys, and indexes.
2. Generate or write a safe, reversible migration.
3. Add repository/query helpers and tests verifying data integrity.`,
  },
  {
    id: 'qa-test-suite',
    label: 'QA Verification & Regression Suite',
    category: 'Quality Assurance',
    persona: 'qa',
    permissionMode: 'auto',
    titlePlaceholder: 'Expand test coverage & verify critical flows',
    promptTemplate: `Act as QA Engineer and audit the project's test coverage and reliability:
1. Run the existing test suite and build checks.
2. Identify untested critical paths and edge cases from PROJECT.md.
3. Write high-value unit/integration tests and fix any discovered regressions.`,
  },
  {
    id: 'sec-audit-hardening',
    label: 'Security Audit & Hardening',
    category: 'Security',
    persona: 'security',
    permissionMode: 'auto',
    titlePlaceholder: 'Audit auth, input validation & secret handling',
    promptTemplate: `Perform an application security review of the codebase:
1. Inspect authentication, authorization, input validation (Zod/schemas), and secret handling.
2. Check for injection risks, path traversal, or unsafe defaults.
3. Remediate high/medium findings or document them clearly with tests.`,
  },
];

export interface BlueprintGeneratorInput {
  name: string;
  appType: ProjectAppType;
  description: string;
  techStack?: ProjectTechStack | null;
  architectureNotes?: string;
  referenceDocs?: string;
  /** Wizard v2: every stack dimension as chosen (option id, `none`, `agent` or free text). */
  choices?: ProjectChoices;
  versionPolicy?: string;
  /** An existing repository: no Bootstrap ticket decides the open items, the agents record them. */
  imported?: boolean;
}

/** Order of the stack lines in PROJECT.md and of the hints in worktree.yml. */
const STACK_ORDER: readonly StackDimensionId[] = [
  'language',
  'frontend',
  'backend',
  'database',
  'styling',
  'testing',
  'auth',
  'deploy',
];

const LAYER_NOUN: Partial<Record<StackDimensionId, string>> = {
  frontend: 'frontend',
  backend: 'backend',
  database: 'database',
  auth: 'authentication',
  deploy: 'deploy target',
};

/** Human text for one choice. `none`/`agent` are special; an unknown option id is shown as is. */
export function describeChoice(dimension: StackDimensionId, choice: StackChoice | undefined, imported = false): string {
  if (choice === undefined) return 'Not specified.';
  if (typeof choice !== 'string') return `${choice.other} (custom)`;
  if (choice === 'none') return `None. This project has no ${LAYER_NOUN[dimension] ?? dimension} layer.`;
  if (choice === 'agent') {
    return imported
      ? 'Decided by the agent. Not detected in the repository; record what the code uses here.'
      : 'Decided by the agent. The Bootstrap ticket picks it and records it here.';
  }
  return findOption(dimension, choice)?.label ?? choice;
}

function stackSectionFromChoices(choices: ProjectChoices, versionPolicy?: string, imported = false): string {
  const lines: string[] = [];
  if (versionPolicy) lines.push(`- **Release & Version Policy:** ${versionPolicy}`);
  const agentDecided: string[] = [];
  for (const id of STACK_ORDER) {
    const label = getDimension(id)?.label ?? id;
    lines.push(`- **${label}:** ${describeChoice(id, choices[id], imported)}`);
    if (choices[id] === 'agent') agentDecided.push(label);
  }
  if (agentDecided.length > 0) {
    lines.push(
      '',
      '### Decided by the agent',
      '',
      ...agentDecided.map((l) => `- ${l}: pick it, then replace the line above with the decision and the reason.`),
    );
  }
  return lines.join('\n');
}

export function generateProjectBlueprint(input: BlueprintGeneratorInput): string {
  const appLabel = APP_TYPE_LABELS[input.appType] ?? APP_TYPE_LABELS.custom;
  const stack = input.techStack;
  const stackLines: string[] = [];
  if (stack?.versionPolicy) stackLines.push(`- **Release & Version Policy:** ${stack.versionPolicy}`);
  if (stack?.language) stackLines.push(`- **Primary Language & Runtime:** ${stack.language}`);
  if (stack?.frontend) stackLines.push(`- **Frontend / Surface Layer:** ${stack.frontend}`);
  if (stack?.backend) stackLines.push(`- **Backend / Core Runtime:** ${stack.backend}`);
  if (stack?.database) stackLines.push(`- **Database & Persistence:** ${stack.database}`);
  if (stack?.styling) stackLines.push(`- **UI / Styling / Output:** ${stack.styling}`);
  if (stack?.testing) stackLines.push(`- **Testing & Verification:** ${stack.testing}`);

  const stackSection = input.choices
    ? stackSectionFromChoices(input.choices, input.versionPolicy ?? stack?.versionPolicy, input.imported)
    : stackLines.length > 0
      ? stackLines.join('\n')
      : '- *Tech stack not yet locked — System Architect agent should document selected stack here.*';

  const descriptionSection =
    input.description.trim() ||
    `${input.name} is a ${appLabel.toLowerCase()} managed by the Emberline AI Coding Factory.`;

  const archSection =
    input.architectureNotes?.trim() ||
    (input.choices ? getProjectType(input.appType)?.archNotes : undefined) ||
    `- Keep module boundaries explicit and cohesive.
- Validate all external inputs at the boundary.
- Maintain automated tests alongside every feature change.`;

  const refSection =
    input.referenceDocs?.trim() ||
    `- No external reference documents attached yet. Add API specs, links, or domain rules here.`;

  return `# ${input.name} — Project Blueprint (\`PROJECT.md\`)

> **Application Type:** ${appLabel}
> **Managed By:** Emberline AI Coding Factory

---

## 1. Product Vision & Overview

${descriptionSection}

---

## 2. Technology Stack

${stackSection}

---

## 3. Architecture & Engineering Standards

${archSection}

---

## 4. Reference Specifications & Domain Context

${refSection}

---

## 5. AI Coding Factory Personas & Responsibilities

- **Product Owner (\`product_owner\`):** Maintains this \`PROJECT.md\`, refines user stories, and defines clear acceptance criteria.
- **System Architect (\`architect\`):** Owns directory structure, module interfaces, API contracts, and architectural coherence.
- **UI/UX Engineer (\`ui_ux\`):** Owns design tokens, component ergonomics, accessibility, and responsive behavior.
- **Software Engineer (\`coder\`):** Implements features and bug fixes cleanly with accompanying tests.
- **Database Architect (\`dba\`):** Owns schema design, migrations, indexes, and query performance.
- **QA & Test Engineer (\`qa\`):** Owns unit, integration, and E2E test suites and regression verification.
- **Security Engineer (\`security\`):** Audits authentication, input validation, permissions, and dependency safety.

---

## 6. Milestones & Delivery Checklist

- [ ] **M1 — Foundation & Architecture:** Core repository skeleton, build pipeline, and domain contracts.
- [ ] **M2 — Core Domain & Data Layer:** Primary models, persistence, and core service logic.
- [ ] **M3 — User Interface / API Surface:** Primary user workflows, endpoints, and interactive views.
- [ ] **M4 — QA, Security & Polish:** End-to-end test suite, security hardening, and UX polish.
`;
}

export function generateClaudeInstructions(name: string): string {
  return `# ${name} — Agent Instructions (\`CLAUDE.md\`)

1. **Always read \`PROJECT.md\` first** before planning or making changes. It is the living source of truth for product vision, tech stack, architectural layers, and milestones.
2. **Respect your assigned Persona role** (Product Owner, Architect, UI/UX, Coder, DBA, QA, or Security) and adapt to the project's actual architecture (Full-Stack Web/Portal, Backend API, Multi-Agent Platform, Desktop/Mobile App, System/CLI Automation, or Embedded/IoT Firmware).
3. **Self-Task Delegation (\`.emberline/new-tickets.json\`):**
   - When acting as \`product_owner\` or \`architect\` (or whenever a request spans multiple architectural layers such as \`coder\` for backend/core/service/firmware logic, \`dba\` for database schemas & migrations, \`ui_ux\` for frontend views/desktop GUI/CLI UX, and \`qa\` for automated test & build verification), create delegated tickets by writing \`.emberline/new-tickets.json\`:
   \`\`\`json
   {
     "autoDispatch": true,
     "tickets": [
       {
         "ref": "backend",
         "title": "Core / Backend: ...",
         "persona": "coder",
         "priority": 2,
         "body": "Detailed specification, target files, and acceptance criteria..."
       },
       {
         "ref": "surface",
         "title": "UI/UX or Surface: ...",
         "persona": "ui_ux",
         "priority": 2,
         "dependsOn": ["backend"],
         "body": "Detailed interface, view, or CLI/GUI ergonomics specification..."
       },
       {
         "ref": "qa",
         "title": "QA & Build Verification: ...",
         "persona": "qa",
         "priority": 2,
         "dependsOn": ["backend", "surface"],
         "body": "Write/run automated tests and verify the project's build/compile pipeline passes cleanly."
       }
     ]
   }
   \`\`\`
   - Emberline Core automatically reads \`.emberline/new-tickets.json\` when your turn finishes, creates the tickets on the Kanban Board, syncs your work to \`main\`, and starts each ticket as soon as every ticket listed in its \`dependsOn\` (by \`ref\`, or an existing ticket key) is merged into \`main\`; tickets without dependencies start right away, up to the project's parallel limit. Give tickets of one batch the same \`priority\` and order them with \`dependsOn\` (priority does not follow the persona). Order the work: producers (assets, schemas, contracts, migrations) before consumers, builds and QA after what they package or verify.
4. **Verify your work:** Run the project's appropriate build, compiler, linter, and test suite (e.g., \`pnpm/npm run build\`, \`pytest\`, \`go test ./...\`, \`cargo check\`, \`pio run\`, \`make\`, or \`bash -n\`) before concluding your turn.
5. **Keep \`PROJECT.md\` up to date** whenever architectural boundaries, commands, or milestones evolve.
`;
}

function hintsOf(choices: ProjectChoices): { dimension: StackDimensionId; hints: WorktreeHints }[] {
  const out: { dimension: StackDimensionId; hints: WorktreeHints }[] = [];
  for (const dimension of STACK_ORDER) {
    const choice = choices[dimension];
    const hints = typeof choice === 'string' ? findOption(dimension, choice)?.worktree : undefined;
    if (hints) out.push({ dimension, hints });
  }
  return out;
}

/**
 * A setup command runs only when its manifest exists: it exits 0 on a fresh skeleton (before
 * Bootstrap) and fails loudly once the manifest is there.
 */
const SETUP_MANIFESTS: readonly [RegExp, string][] = [
  [/^(pnpm|npm|yarn|bun) install\b/, 'package.json'],
  [/^pip install -r requirements\.txt\b/, 'requirements.txt'],
  [/^go mod download\b/, 'go.mod'],
  [/^flutter pub get\b/, 'pubspec.yaml'],
  [/^mix deps\.get\b/, 'mix.exs'],
];

function guardSetup(command: string): string {
  if (/^dotnet restore\b/.test(command)) return `[ -z "$(ls ./*.sln ./*.csproj 2>/dev/null)" ] || ${command}`;
  const manifest = SETUP_MANIFESTS.find(([re]) => re.test(command))?.[1];
  return manifest ? `[ ! -f ${manifest} ] || ${command}` : command;
}

/**
 * `.emberline/worktree.yml` (schema v1) from the commands the chosen options contribute. The
 * preset's choices are the base; `choices` overrides them per dimension. Scalars are JSON strings,
 * which are valid YAML, so no command needs escaping.
 */
export function generateWorktreeYml(choices: ProjectChoices, preset: PresetDef | undefined): string {
  const merged: ProjectChoices = { ...(preset?.choices ?? {}), ...choices };
  const hinted = hintsOf(merged);
  const unique = (list: (string | undefined)[]): string[] => [...new Set(list.filter((c): c is string => Boolean(c)))];
  const from = (dims: readonly StackDimensionId[], key: keyof WorktreeHints): string[] =>
    unique(hinted.filter((h) => dims.includes(h.dimension)).map((h) => h.hints[key]));
  const FRAMEWORK: readonly StackDimensionId[] = ['frontend', 'backend', 'database', 'styling', 'auth', 'deploy'];
  /**
   * Per key, the first tier that supplies a command wins: `testing` (test only), then the framework
   * options, then the language as a fallback. Tiers are never joined, so a language build is not
   * chained onto a framework build.
   */
  const joined = (key: 'build' | 'lint' | 'test'): string[] => {
    const tiers: (readonly StackDimensionId[])[] = key === 'test' ? [['testing'], FRAMEWORK, ['language']] : [FRAMEWORK, ['language']];
    for (const tier of tiers) {
      const found = from(tier, key);
      if (found.length > 0) return found;
    }
    return [];
  };
  const service = hinted.find((h) => h.dimension === 'frontend' && h.hints.service)
    ? { name: 'web', command: hinted.find((h) => h.dimension === 'frontend')?.hints.service }
    : hinted.find((h) => h.dimension === 'backend' && h.hints.service)
      ? { name: 'api', command: hinted.find((h) => h.dimension === 'backend')?.hints.service }
      : undefined;
  return renderWorktreeYml(
    {
      setup: unique(from(STACK_ORDER, 'setup').map(guardSetup)),
      services: service?.command ? [{ name: service.name, command: service.command, preview: true }] : [],
      checks: Object.fromEntries((['build', 'lint', 'test'] as const).map((k) => [k, joined(k).join(' && ')])),
    },
    '# Generated by the Emberline project wizard. Runs read the approved copy of this file.',
  );
}

export interface WorktreeYmlParts {
  setup: readonly string[];
  services: readonly { name: string; command: string; preview?: boolean }[];
  checks: Partial<Record<'build' | 'lint' | 'test', string>>;
}

/**
 * Writes a schema v1 file. Scalars are JSON strings, which are valid YAML, so no command needs
 * escaping; empty sections and checks are left out.
 */
export function renderWorktreeYml(parts: WorktreeYmlParts, header: string): string {
  const q = JSON.stringify;
  const out = [header, 'version: 1'];
  if (parts.setup.length > 0) out.push('setup:', ...parts.setup.map((c) => `  - ${q(c)}`));
  if (parts.services.length > 0) {
    out.push('services:');
    for (const s of parts.services) {
      out.push(`  - name: ${s.name}`, `    command: ${q(s.command)}`, ...(s.preview ? ['    preview: true'] : []));
    }
  }
  const checks = (['build', 'lint', 'test'] as const).flatMap((k) => (parts.checks[k] ? [[k, parts.checks[k]] as const] : []));
  if (checks.length > 0) out.push('checks:', ...checks.map(([k, v]) => `  ${k}: ${q(v)}`));
  return out.join('\n') + '\n';
}

export interface WizardTicketContext {
  name: string;
  appType: ProjectAppType;
  choices: ProjectChoices;
  preset?: PresetDef;
}

export interface WizardTicketSpec {
  /** Stable id within the plan; `dependsOn` refers to it. */
  key: 'bootstrap' | 'deploy';
  title: string;
  body: string;
  persona: Ticket['persona'];
  priority: number;
  dependsOn: string[];
}

const BOOTSTRAP_FALLBACK = [
  'Set up the project skeleton for the stack chosen in PROJECT.md.',
  'The build gate runs the approved `checks` in `.emberline/worktree.yml`: make the project satisfy them (add the build, lint and test scripts) instead of editing them; an edited worktree.yml only applies after a person approves it in the project banner. Make `setup` and the preview service real as well.',
  'Keep PROJECT.md accurate as you decide things; items marked "decided by agent" must be filled in.',
];

export function bootstrapTicket(ctx: WizardTicketContext): WizardTicketSpec {
  const stack = STACK_ORDER.map((id) => `- ${getDimension(id)?.label ?? id}: ${describeChoice(id, ctx.choices[id])}`);
  const steps = ctx.preset?.bootstrap.length ? ctx.preset.bootstrap : BOOTSTRAP_FALLBACK;
  return {
    key: 'bootstrap',
    title: 'Bootstrap: project skeleton and worktree commands',
    persona: 'architect',
    priority: 3,
    dependsOn: [],
    body: `## Objective

Set up the skeleton of **${ctx.name}** (${APP_TYPE_LABELS[ctx.appType]}${ctx.preset ? `, preset "${ctx.preset.label}"` : ''}) so every later ticket starts from a project that builds, tests and runs.

## Chosen stack

${stack.join('\n')}

## What to do

${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}

## Acceptance Criteria

- The skeleton exists for the chosen stack and is committed.
- The build gate runs the approved \`checks\` (build, lint, test) from \`.emberline/worktree.yml\`. Make the project satisfy them: add the matching build, lint and test scripts or targets rather than editing the checks. An edited \`worktree.yml\` only applies after a person approves it in the project banner.
- The \`setup\` commands and the preview \`services\` entry run for real and pass.
- \`PROJECT.md\` lists the final stack, including everything marked "decided by the agent".
`,
  };
}

export function deployTicket(ctx: WizardTicketContext): WizardTicketSpec | null {
  const choice = ctx.choices.deploy;
  if (choice === undefined || choice === 'none') return null;
  const target = describeChoice('deploy', choice).replace(/\.$/, '');
  return {
    key: 'deploy',
    title: `Deploy: prepare ${typeof choice === 'string' && choice !== 'agent' ? target : 'the deploy target'}`,
    persona: 'architect',
    priority: 1,
    dependsOn: ['bootstrap'],
    body: `## Objective

Prepare **${ctx.name}** for deployment to: ${choice === 'agent' ? 'a target you choose (record the decision in `PROJECT.md`)' : target}.

## What to do

1. Add the configuration the target needs (build or start commands, container or platform files, environment variable names with placeholder values).
2. Write a short deployment guide in the repository (for example \`docs/deploy.md\`): prerequisites, one command per step, and how to roll back.
3. Update the deploy section of \`PROJECT.md\`.

## Rules

- Emberline does not run the deploy; prepare it so a person can.
- Put no credentials, tokens or private keys in the repository. Document the environment variables and where to set them instead.
`,
  };
}

/**
 * Initializes a local git repository in `projectPath` and commits any generated blueprint files
 * so `git worktree` isolation works immediately on brand-new wizard/manual projects.
 */
export async function initLocalGitRepository(projectPath: string, defaultBranch = 'main'): Promise<void> {
  if (existsSync(path.join(projectPath, '.git'))) return;
  try {
    await execGitFile(['init', '-b', defaultBranch], { cwd: projectPath });
    await execGitFile(['add', '-A'], { cwd: projectPath });
    await execGitFile(
      [
        '-c',
        'user.name=Emberline Factory',
        '-c',
        'user.email=factory@emberline.local',
        'commit',
        '--allow-empty',
        '-m',
        'chore: initialize project blueprint',
      ],
      { cwd: projectPath },
    );
  } catch {
    // Non-fatal if git is unavailable in a minimal test environment
  }
}

export async function readProjectBlueprint(project: Project): Promise<ProjectBlueprintResponse> {
  const blueprintPath = path.join(project.path, 'PROJECT.md');
  if (!existsSync(blueprintPath)) {
    return {
      projectId: project.id,
      exists: false,
      content: '',
      path: blueprintPath,
    };
  }
  const content = await readFile(blueprintPath, 'utf8');
  return {
    projectId: project.id,
    exists: true,
    content,
    path: blueprintPath,
  };
}

export async function writeProjectBlueprint(project: Project, content: string): Promise<ProjectBlueprintResponse> {
  const blueprintPath = path.join(project.path, 'PROJECT.md');
  await writeFile(blueprintPath, content, 'utf8');
  const claudePath = path.join(project.path, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    await writeFile(claudePath, generateClaudeInstructions(project.name), 'utf8');
  }
  return {
    projectId: project.id,
    exists: true,
    content,
    path: blueprintPath,
  };
}

export function seedStarterTickets(project: Project, ticketService: TicketService): Ticket[] {
  const existing = ticketService.list(project.id);
  if (existing.length > 0) return existing;

  const stackHint = project.techStack
    ? [
        project.techStack.language,
        project.techStack.frontend,
        project.techStack.backend,
        project.techStack.database,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'the configured stack in PROJECT.md';

  const starterSpecs: Array<{
    title: string;
    body: string;
    persona: Ticket['persona'];
    priority: number;
  }> = [
    {
      title: 'Refine PROJECT.md user stories & acceptance criteria',
      persona: 'product_owner',
      priority: 1,
      body: `Read \`PROJECT.md\` for **${project.name}** and expand Section 1 and Section 6 into concrete user stories, edge cases, and testable acceptance criteria for Milestone 1.`,
    },
    {
      title: 'Scaffold project architecture, build tooling & core contracts',
      persona: 'architect',
      priority: 1,
      body: `Initialize the project skeleton for **${project.name}** using **${stackHint}** according to \`PROJECT.md\`. Set up package configuration, directory layout, core domain types, and verify the build/check pipeline runs cleanly.`,
    },
    {
      title: 'Implement core domain workflow & primary user interface',
      persona: 'coder',
      priority: 2,
      body: `Implement the primary functional workflow described in \`PROJECT.md\` for **${project.name}**, wiring data models, service logic, and the user-facing interface or API endpoints.`,
    },
    {
      title: 'Create automated QA test suite & verify acceptance criteria',
      persona: 'qa',
      priority: 2,
      body: `Add automated unit and integration tests covering the core workflows in \`PROJECT.md\`. Ensure all checks pass and document how to run the test suite.`,
    },
  ];

  return starterSpecs.map((spec, idx) =>
    ticketService.create(project.id, {
      title: spec.title,
      body: spec.body,
      status: idx < 2 ? 'ready' : 'backlog',
      priority: spec.priority,
      persona: spec.persona,
    }),
  );
}

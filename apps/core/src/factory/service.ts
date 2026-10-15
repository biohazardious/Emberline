import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentCreateTicketsPayload,
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  type AgentTicketDraft,
  type BrowserViewportSnapshot,
  type BuildDemoResponse,
  coerceModelForProvider,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactoryAttachmentInput,
  FactorySettings,
  type McpServerEntry,
  type Project,
  type ProjectAppType,
  type ProjectBlueprintResponse,
  type ProjectCheckpoint,
  type ProjectRecommendation,
  type ProjectStatusSummary,
  type ProjectTechStack,
  type Run,
  selectProviderModelByRank,
  type SkillPluginEntry,
  type SyncWorktreeResponse,
  type TaskTemplate,
  type Ticket,
  UpdateFactorySettingsBody,
  type UploadWorkspaceFileItem,
  type UploadWorkspaceFilesResponse,
  type WorkspaceDemoTarget,
  type WorkspaceFileContentResponse,
  type WorkspaceFileEntry,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import type { TicketService } from '../tickets/service.js';
import { getLastKnownClaudeUtilizationPercent } from './browser-daemon.js';

export * from './slop-guard.js';

const execFileAsync = promisify(execFile);

export const APP_TYPE_LABELS: Record<ProjectAppType, string> = {
  web_saas: 'Web SaaS / Enterprise Portal',
  fullstack: 'Full-Stack Multi-Layer Platform',
  api_service: 'Backend API / Microservice',
  ai_agents: 'Multi-Agent AI / Orchestration Platform',
  cli_tool: 'CLI Tool / System & Infra Automation',
  mobile_desktop: 'Desktop / Mobile Application',
  embedded_iot: 'Embedded / IoT / Hardware Firmware',
  library: 'SDK / Package Library',
  game_interactive: 'Interactive Canvas / Game App',
  custom: 'Custom Multi-Layer Project',
};

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'po-prd-breakdown',
    label: 'PRD & Epic Breakdown',
    category: 'Product & Planning',
    persona: 'product_owner',
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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
    permissionMode: 'acceptEdits',
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

  const stackSection =
    stackLines.length > 0
      ? stackLines.join('\n')
      : '- *Tech stack not yet locked — System Architect agent should document selected stack here.*';

  const descriptionSection =
    input.description.trim() ||
    `${input.name} is a ${appLabel.toLowerCase()} managed by the Emberline AI Coding Factory.`;

  const archSection =
    input.architectureNotes?.trim() ||
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
         "title": "Core / Backend: ...",
         "persona": "coder",
         "priority": 3,
         "body": "Detailed specification, target files, and acceptance criteria..."
       },
       {
         "title": "UI/UX or Surface: ...",
         "persona": "ui_ux",
         "priority": 2,
         "body": "Detailed interface, view, or CLI/GUI ergonomics specification..."
       },
       {
         "title": "QA & Build Verification: ...",
         "persona": "qa",
         "priority": 1,
         "body": "Write/run automated tests and verify the project's build/compile pipeline passes cleanly."
       }
     ]
   }
   \`\`\`
   - Emberline Core automatically reads \`.emberline/new-tickets.json\` when your turn finishes, creates the tickets on the Kanban Board, syncs your work to \`main\`, and dispatches each specialist persona sequentially!
4. **Verify your work:** Run the project's appropriate build, compiler, linter, and test suite (e.g., \`pnpm/npm run build\`, \`pytest\`, \`go test ./...\`, \`cargo check\`, \`pio run\`, \`make\`, or \`bash -n\`) before concluding your turn.
5. **Keep \`PROJECT.md\` up to date** whenever architectural boundaries, commands, or milestones evolve.
`;
}

/**
 * Initializes a local git repository in `projectPath` and commits any generated blueprint files
 * so `git worktree` isolation works immediately on brand-new wizard/manual projects.
 */
export async function initLocalGitRepository(projectPath: string, defaultBranch = 'main'): Promise<void> {
  if (existsSync(path.join(projectPath, '.git'))) return;
  try {
    await execFileAsync('git', ['init', '-b', defaultBranch], { cwd: projectPath });
    await execFileAsync('git', ['add', '-A'], { cwd: projectPath });
    await execFileAsync(
      'git',
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

export function computeProjectRecommendations(
  project: Project,
  blueprint: ProjectBlueprintResponse,
  projectTickets: Ticket[],
  projectRuns: Run[],
): ProjectRecommendation[] {
  const recommendations: ProjectRecommendation[] = [];

  // 1. Missing or minimal PROJECT.md blueprint
  if (!blueprint.exists || blueprint.content.trim().length < 80) {
    recommendations.push({
      id: 'create-blueprint',
      priority: 'high',
      category: 'blueprint',
      title: 'Generate or complete PROJECT.md Blueprint',
      description:
        'Agents perform significantly better when PROJECT.md defines the vision, tech stack, and architectural boundaries.',
      persona: 'product_owner',
      actionLabel: 'Open Blueprint Editor',
      actionType: 'open_blueprint',
    });
  }

  // 2. Completed runs waiting in Review
  const reviewTickets = projectTickets.filter((t) => t.status === 'review');
  const finishedRuns = projectRuns.filter((r) => r.state === 'done');
  if (reviewTickets.length > 0) {
    const latestReviewRun = finishedRuns.find((r) => reviewTickets.some((t) => t.id === r.ticketId)) ?? finishedRuns[0];
    recommendations.push({
      id: 'review-pending-work',
      priority: 'high',
      category: 'review',
      title: `${reviewTickets.length} ticket${reviewTickets.length > 1 ? 's' : ''} ready for Code Review`,
      description: 'Inspect the git diff, run a live preview server, or open a Pull Request before moving to Done.',
      persona: 'architect',
      actionLabel: latestReviewRun ? 'Inspect Diff & Review' : 'Open Board',
      actionType: latestReviewRun ? 'open_review' : 'open_board',
      runId: latestReviewRun?.id,
    });
  }

  // 3. Empty board — offer 1-click starter ticket seeding
  if (projectTickets.length === 0) {
    recommendations.push({
      id: 'seed-starter-backlog',
      priority: 'high',
      category: 'backlog',
      title: 'Seed AI Factory Starter Backlog (PO → Architect → Coder → QA)',
      description:
        'Populate the Kanban board with 4 structured starter tickets tailored to your project blueprint and tech stack.',
      persona: 'product_owner',
      actionLabel: 'Seed 4 Starter Tickets',
      actionType: 'seed_tickets',
    });
  }

  // 4. Ready/Backlog tickets ready to be dispatched when no agent is actively running
  const queuedTickets = projectTickets.filter((t) => t.status === 'ready' || t.status === 'backlog');
  const activeRuns = projectRuns.filter(
    (r) => r.state === 'working' || r.state === 'starting' || r.state === 'queued' || r.state === 'waiting_input',
  );
  const nextTicket = queuedTickets.find((t) => t.status === 'ready') ?? queuedTickets[0];
  if (nextTicket && activeRuns.length === 0) {
    recommendations.push({
      id: 'dispatch-next-ticket',
      priority: 'medium',
      category: 'execution',
      title: `Start next backlog ticket: ${nextTicket.key} (${nextTicket.title.slice(0, 48)})`,
      description: `${queuedTickets.length} ticket${queuedTickets.length > 1 ? 's are' : ' is'} waiting on the board and no agent is currently running on this project.`,
      persona: nextTicket.persona,
      actionLabel: 'Open Project Board',
      actionType: 'open_board',
    });
  }

  // 5. Recommend QA verification if coder runs completed without a QA run
  const hasCoderDone = projectRuns.some((r) => r.state === 'done' && r.persona === 'coder');
  const hasQaRun = projectRuns.some((r) => r.persona === 'qa');
  if (hasCoderDone && !hasQaRun) {
    recommendations.push({
      id: 'run-qa-verification',
      priority: 'medium',
      category: 'qa',
      title: 'Run QA & Regression Verification Pass',
      description:
        'Feature runs have completed without a dedicated QA Engineer pass. Dispatch a QA agent to verify test coverage and edge cases.',
      persona: 'qa',
      actionLabel: 'Launch QA Agent',
      actionType: 'start_run',
      prompt:
        'Read PROJECT.md, run the full test and build suite, identify any untested edge cases from recent changes, and add regression tests.',
    });
  }

  // 6. Recommend Architecture / PO refinement if blueprint exists and board is quiet
  if (recommendations.length < 3 && blueprint.exists) {
    recommendations.push({
      id: 'po-next-milestone',
      priority: 'low',
      category: 'blueprint',
      title: 'Ask Product Owner Agent to plan the next milestone',
      description:
        'Have the Product Owner agent inspect the current repository state against PROJECT.md and propose the next set of deliverables.',
      persona: 'product_owner',
      actionLabel: 'Run PO Planning Pass',
      actionType: 'start_run',
      prompt:
        'Inspect PROJECT.md and the current codebase progress. Update the Milestone checklist in PROJECT.md and outline the next 3 concrete engineering tasks.',
    });
  }

  return recommendations;
}

const IGNORED_WALK_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'test-results',
  '.emberline',
  '.turbo',
]);

async function collectWorkspaceFiles(
  workspacePath: string,
  maxDepth = 3,
): Promise<{ fileCount: number; topFiles: string[] }> {
  if (!existsSync(workspacePath)) {
    return { fileCount: 0, topFiles: [] };
  }
  const files: string[] = [];
  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= 250) return;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_WALK_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(workspacePath, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        files.push(relPath);
        if (files.length >= 250) return;
      }
    }
  }
  await walk(workspacePath, 0);
  files.sort((a, b) => a.localeCompare(b));
  return {
    fileCount: files.length,
    topFiles: files.slice(0, 18),
  };
}

interface WorkspaceInspection {
  hasPackageJson: boolean;
  hasBuildScript: boolean;
  detectedStack: string;
  buildCommand: string | null;
  detectedLayers: string[];
}

async function inspectWorkspaceProject(
  workspacePath: string,
  topFiles: readonly string[] = [],
): Promise<WorkspaceInspection> {
  if (!existsSync(workspacePath)) {
    return {
      hasPackageJson: false,
      hasBuildScript: false,
      detectedStack: 'Empty Workspace',
      buildCommand: null,
      detectedLayers: [],
    };
  }

  const pkgPath = path.join(workspacePath, 'package.json');
  const hasPackageJson = existsSync(pkgPath);
  const hasPnpmWorkspace =
    existsSync(path.join(workspacePath, 'pnpm-workspace.yaml')) ||
    existsSync(path.join(workspacePath, 'turbo.json'));
  const hasPnpmLock = existsSync(path.join(workspacePath, 'pnpm-lock.yaml'));
  const hasYarnLock = existsSync(path.join(workspacePath, 'yarn.lock'));
  const pkgManager = hasPnpmLock || hasPnpmWorkspace ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';

  const hasPyproject =
    existsSync(path.join(workspacePath, 'pyproject.toml')) ||
    existsSync(path.join(workspacePath, 'requirements.txt')) ||
    existsSync(path.join(workspacePath, 'setup.py'));
  const hasGoMod = existsSync(path.join(workspacePath, 'go.mod'));
  const hasCargo =
    existsSync(path.join(workspacePath, 'Cargo.toml')) ||
    existsSync(path.join(workspacePath, 'src-tauri', 'Cargo.toml'));
  const hasPlatformIo = existsSync(path.join(workspacePath, 'platformio.ini'));
  const hasCMake = existsSync(path.join(workspacePath, 'CMakeLists.txt'));
  const hasMakefile = existsSync(path.join(workspacePath, 'Makefile'));
  const hasIno = topFiles.some((f) => f.endsWith('.ino') || f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.h'));
  const hasPyFiles = topFiles.some((f) => f.endsWith('.py'));
  const hasShFiles = topFiles.some((f) => f.endsWith('.sh'));

  const layers = new Set<string>();
  if (
    hasPnpmWorkspace ||
    existsSync(path.join(workspacePath, 'apps')) ||
    existsSync(path.join(workspacePath, 'packages')) ||
    existsSync(path.join(workspacePath, 'services'))
  ) {
    layers.add('Multi-Layer / Monorepo');
  }
  if (
    existsSync(path.join(workspacePath, 'index.html')) ||
    existsSync(path.join(workspacePath, 'public')) ||
    existsSync(path.join(workspacePath, 'apps', 'web')) ||
    existsSync(path.join(workspacePath, 'apps', 'client')) ||
    existsSync(path.join(workspacePath, 'frontend')) ||
    topFiles.some((f) => f.endsWith('.tsx') || f.endsWith('.vue') || f.endsWith('.svelte'))
  ) {
    layers.add('Frontend / Web UI');
  }
  if (
    existsSync(path.join(workspacePath, 'apps', 'core')) ||
    existsSync(path.join(workspacePath, 'apps', 'api')) ||
    existsSync(path.join(workspacePath, 'apps', 'server')) ||
    existsSync(path.join(workspacePath, 'backend')) ||
    existsSync(path.join(workspacePath, 'server')) ||
    existsSync(path.join(workspacePath, 'api')) ||
    hasGoMod ||
    hasPyproject
  ) {
    layers.add('Backend / Service');
  }
  if (
    existsSync(path.join(workspacePath, 'prisma')) ||
    existsSync(path.join(workspacePath, 'drizzle')) ||
    existsSync(path.join(workspacePath, 'migrations')) ||
    topFiles.some((f) => f.includes('schema') || f.endsWith('.sql'))
  ) {
    layers.add('Database / Schema');
  }
  if (
    existsSync(path.join(workspacePath, 'src-tauri')) ||
    existsSync(path.join(workspacePath, 'electron')) ||
    existsSync(path.join(workspacePath, 'android')) ||
    existsSync(path.join(workspacePath, 'ios'))
  ) {
    layers.add('Desktop / Mobile Native');
  }
  if (hasPlatformIo || hasIno || existsSync(path.join(workspacePath, 'firmware'))) {
    layers.add('Embedded / Hardware Firmware');
  }
  if (hasShFiles || existsSync(path.join(workspacePath, 'scripts')) || existsSync(path.join(workspacePath, 'bin'))) {
    layers.add('CLI / System Automation');
  }
  if (
    existsSync(path.join(workspacePath, 'Dockerfile')) ||
    existsSync(path.join(workspacePath, 'docker-compose.yml')) ||
    existsSync(path.join(workspacePath, 'compose.yaml'))
  ) {
    layers.add('Docker / Containers');
  }

  let hasBuildScript = false;
  let buildCommand: string | null = null;
  let detectedStack = 'Polyglot / Custom';

  if (hasPackageJson) {
    detectedStack = hasPnpmWorkspace ? `TypeScript / JS Monorepo (${pkgManager})` : `Node.js / TypeScript (${pkgManager})`;
    try {
      const raw = await readFile(pkgPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = parsed.scripts ?? {};
      const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
      if (deps.electron || deps['@tauri-apps/api']) layers.add('Desktop / Mobile Native');
      if (deps.fastify || deps.express || deps['@nestjs/core'] || deps.hono) layers.add('Backend / Service');
      if (deps['drizzle-orm'] || deps.prisma || deps['@prisma/client'] || deps.pg || deps['better-sqlite3']) {
        layers.add('Database / Schema');
      }
      if (typeof scripts.build === 'string') {
        hasBuildScript = true;
        buildCommand = `${pkgManager} run build`;
      } else if (typeof scripts.typecheck === 'string') {
        hasBuildScript = true;
        buildCommand = `${pkgManager} run typecheck`;
      } else if (typeof scripts.check === 'string') {
        hasBuildScript = true;
        buildCommand = `${pkgManager} run check`;
      } else if (typeof scripts.test === 'string') {
        hasBuildScript = true;
        buildCommand = `${pkgManager} test`;
      }
    } catch {
      // ignore invalid package.json
    }
  }

  if (hasPlatformIo) {
    detectedStack = 'PlatformIO / Embedded Firmware (ESP32/MCU)';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'pio run';
  } else if (hasCargo) {
    detectedStack = existsSync(path.join(workspacePath, 'src-tauri')) ? 'Rust + Tauri Desktop' : 'Rust / Cargo';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'cargo check';
  } else if (hasGoMod) {
    detectedStack = 'Go Module';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'go build ./...';
  } else if (hasPyproject || hasPyFiles) {
    detectedStack = hasShFiles ? 'Python + Shell Automation' : 'Python';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'python3 -m compileall -q .';
  } else if (hasCMake || hasIno) {
    detectedStack = hasIno ? 'Embedded C/C++ / Arduino Firmware' : 'C/C++ (CMake)';
    hasBuildScript = Boolean(hasMakefile || hasCMake);
    buildCommand = buildCommand ?? (hasMakefile ? 'make' : 'cmake --build build');
  } else if (hasShFiles) {
    detectedStack = 'Shell / Linux System Automation';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'bash -n *.sh';
  } else if (hasMakefile && !buildCommand) {
    detectedStack = 'Makefile Project';
    hasBuildScript = true;
    buildCommand = 'make';
  }

  return {
    hasPackageJson,
    hasBuildScript,
    detectedStack,
    buildCommand,
    detectedLayers: Array.from(layers),
  };
}

export async function detectDemoEntryRelPath(workspacePath: string): Promise<string | null> {
  if (!existsSync(workspacePath)) return null;

  // 1. Direct compiled bundles in root
  const directCandidates = [
    'dist/index.html',
    'dist/client/index.html',
    'dist/public/index.html',
    'dist/web/index.html',
    'build/index.html',
    'out/index.html',
    'apps/client/dist/index.html',
    'apps/web/dist/index.html',
    'apps/frontend/dist/index.html',
    'apps/game/dist/index.html',
  ];
  for (const rel of directCandidates) {
    if (existsSync(path.join(workspacePath, rel))) {
      return rel;
    }
  }

  // 2. Any apps/*/dist/index.html or packages/*/dist/index.html
  for (const parentDir of ['apps', 'packages']) {
    const parentAbs = path.join(workspacePath, parentDir);
    if (!existsSync(parentAbs)) continue;
    try {
      const subDirs = await readdir(parentAbs, { withFileTypes: true });
      for (const d of subDirs) {
        if (!d.isDirectory()) continue;
        for (const buildSub of ['dist/index.html', 'build/index.html']) {
          const candidateRel = path.posix.join(parentDir, d.name, buildSub);
          if (existsSync(path.join(workspacePath, candidateRel))) {
            return candidateRel;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Static public/index.html or root index.html (only if it does NOT point to raw .ts/.tsx/.jsx)
  for (const staticRel of ['public/index.html', 'index.html']) {
    const abs = path.join(workspacePath, staticRel);
    if (!existsSync(abs)) continue;
    try {
      const html = await readFile(abs, 'utf-8');
      const referencesUnbuiltTs = /\bsrc\s*=\s*["'][^"']*\.(tsx|ts|jsx)\b/i.test(html);
      if (!referencesUnbuiltTs) {
        return staticRel;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function computeProjectStatusSummary(params: {
  project: Project;
  tickets: readonly Ticket[];
  runs: readonly Run[];
  autoChainActive?: boolean;
}): Promise<ProjectStatusSummary> {
  const { project, tickets, runs, autoChainActive = false } = params;
  const projectTickets = tickets.filter((t) => t.projectId === project.id);
  const projectRuns = runs
    .filter((r) => r.projectId === project.id)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const counts = {
    total: projectTickets.length,
    backlog: 0,
    ready: 0,
    in_progress: 0,
    review: 0,
    done: 0,
  };
  for (const t of projectTickets) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }

  const completionPercent =
    counts.total > 0 ? Math.round(((counts.done + counts.review * 0.75) / counts.total) * 100) : 0;

  const activeRunCount = projectRuns.filter(
    (r) => r.state === 'working' || r.state === 'starting' || r.state === 'queued' || r.state === 'waiting_input',
  ).length;

  const ticketMap = new Map(projectTickets.map((t) => [t.id, t]));
  const targets: WorkspaceDemoTarget[] = [];

  // 1. Main workspace target
  const mainFiles = await collectWorkspaceFiles(project.path);
  const mainPkg = await inspectWorkspaceProject(project.path, mainFiles.topFiles);
  const mainDemoEntry = await detectDemoEntryRelPath(project.path);
  targets.push({
    id: 'main',
    kind: 'main',
    label: `Main Workspace (${project.slug})`,
    ticketKey: null,
    ticketTitle: null,
    persona: null,
    runStatus: null,
    branch: project.defaultBranch,
    workspacePath: project.path,
    exists: existsSync(project.path),
    fileCount: mainFiles.fileCount,
    topFiles: mainFiles.topFiles,
    hasPackageJson: mainPkg.hasPackageJson,
    hasBuildScript: mainPkg.hasBuildScript,
    detectedStack: mainPkg.detectedStack,
    buildCommand: mainPkg.buildCommand,
    detectedLayers: mainPkg.detectedLayers,
    demoEntryRelPath: mainDemoEntry,
    demoUrl: mainDemoEntry ? `/api/projects/${project.id}/demo/main/` : null,
    updatedAt: project.createdAt,
  });

  // 2. Run worktree targets
  const seenPaths = new Set<string>([project.path]);
  for (const run of projectRuns) {
    if (!run.worktreePath || seenPaths.has(run.worktreePath)) continue;
    seenPaths.add(run.worktreePath);
    if (!existsSync(run.worktreePath)) continue;

    const ticket = run.ticketId ? ticketMap.get(run.ticketId) : undefined;
    const wtFiles = await collectWorkspaceFiles(run.worktreePath);
    const wtPkg = await inspectWorkspaceProject(run.worktreePath, wtFiles.topFiles);
    const wtDemoEntry = await detectDemoEntryRelPath(run.worktreePath);
    const shortId = run.id.slice(0, 8);
    const fallbackTitle = run.prompt.split('\n')[0]?.slice(0, 48) || `Run ${shortId}`;
    const label = ticket ? `${ticket.key}: ${ticket.title}` : `${fallbackTitle} (${shortId})`;

    targets.push({
      id: run.id,
      kind: 'worktree',
      label,
      ticketKey: ticket?.key ?? null,
      ticketTitle: ticket?.title ?? fallbackTitle,
      persona: run.persona,
      runStatus: run.state,
      branch: run.branch,
      workspacePath: run.worktreePath,
      exists: true,
      fileCount: wtFiles.fileCount,
      topFiles: wtFiles.topFiles,
      hasPackageJson: wtPkg.hasPackageJson,
      hasBuildScript: wtPkg.hasBuildScript,
      detectedStack: wtPkg.detectedStack,
      buildCommand: wtPkg.buildCommand,
      detectedLayers: wtPkg.detectedLayers,
      demoEntryRelPath: wtDemoEntry,
      demoUrl: wtDemoEntry ? `/api/projects/${project.id}/demo/${run.id}/` : null,
      updatedAt: run.endedAt ?? run.stateChangedAt ?? run.createdAt,
    });
  }

  const slugName = path.basename(project.path);
  return {
    projectId: project.id,
    workspaceRoot: project.path,
    hostBindHint: `./workspaces/${slugName}`,
    ticketCounts: counts,
    completionPercent: Math.min(100, Math.max(0, completionPercent)),
    activeRunCount,
    autoChainActive,
    targets,
  };
}

export async function persistFactoryAttachments(
  workspacePath: string,
  attachments: readonly FactoryAttachmentInput[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return '';
  const attachDir = path.join(workspacePath, '.emberline', 'attachments');
  await mkdir(attachDir, { recursive: true });

  const ts = Date.now();
  const sections: string[] = [];

  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i]!;
    const safeName = att.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `file-${i + 1}`;
    const storedName = `${ts}-${i + 1}-${safeName}`;
    const absPath = path.join(attachDir, storedName);

    const rawBase64 = att.dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(rawBase64, 'base64');
    await writeFile(absPath, buf);

    const sizeKb = Math.max(1, Math.round(buf.length / 1024));
    const ext = path.extname(safeName).toLowerCase();
    const isImage =
      att.mimeType.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'].includes(ext);
    const isTextLike =
      att.mimeType.startsWith('text/') ||
      att.mimeType === 'application/json' ||
      ['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.yaml', '.yml', '.xml', '.svg', '.py', '.sh', '.go', '.rs', '.c', '.cpp', '.h', '.ino', '.ini'].includes(
        ext,
      );

    if (isImage) {
      sections.push(
        `- 🖼️ **Image / Visual Asset:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Action:** Use your \`Read\` tool on \`${absPath}\` to visually inspect this image/screenshot/diagram/mockup, and copy it into the project assets directory if the user wants it embedded. **Include this exact path \`${absPath}\` in delegated \`ui_ux\` / \`coder\` ticket bodies!**`,
      );
    } else if (isTextLike && buf.length <= 16_384 && !buf.subarray(0, 1024).includes(0)) {
      const preview = buf.toString('utf8').trim();
      sections.push(
        `- 📄 **Attached File:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Content Preview:**\n\`\`\`\n${preview.slice(0, 6000)}\n\`\`\``,
      );
    } else {
      sections.push(
        `- 📎 **Attached File:** \`${att.name}\` (${att.mimeType}, ${sizeKb} KB)\n  - **Absolute Path:** \`${absPath}\`\n  - **Action:** Read or inspect \`${absPath}\` and include this path in delegated specialist ticket bodies.`,
      );
    }
  }

  return sections.join('\n\n');
}

export function buildFactoryOrchestratorPrompt(
  userRequest: string,
  autoDispatch = true,
  attachmentContext = '',
): string {
  const attachmentSection = attachmentContext.trim()
    ? `\n### Attached Reference Files & Visual Assets (Uploaded by User):\n${attachmentContext.trim()}\n`
    : '';

  return `## AI Coding Factory — Feature Request & Multi-Layer Specialist Delegation

User Request:
"""
${userRequest.trim()}
"""
${attachmentSection}
### Your Mission (as Lead Product Owner & Factory Orchestrator):
1. **Inspect Architecture & Attached Files:** Read \`PROJECT.md\`, inspect any **Attached Reference Files / Images** listed above using your \`Read\` tool, and inspect the repository structure so you understand the project's exact stack and layers (e.g., Full-Stack Web/Portal, Multi-Package Monorepo, Backend API/Microservice, Multi-Agent Platform, Desktop/Mobile App, CLI/System Automation, or Embedded/IoT Firmware).
2. **Refine Specification:** Translate the user's request (and any attached specs/diagrams/screenshots) into a clear engineering specification and update \`PROJECT.md\` if needed.
3. **Delegate to Specialist Personas (DO NOT implement the entire feature yourself):**
   Break the work down into concrete, non-overlapping sub-tasks for the relevant specialist personas based on the project's architecture:
   - \`architect\` (Priority 3 - High, when cross-layer contracts, monorepo packages, or system protocols change): Module boundaries, shared schemas/types, or hardware/IPC contracts.
   - \`dba\` (Priority 3 - High, when persistence/database schemas change): Database tables, migrations, indexes, or storage models.
   - \`coder\` (Priority 3 - High): Core business logic, backend services/APIs, CLI/system automation scripts, desktop/native state, or embedded firmware implementation.
   - \`ui_ux\` (Priority 2 - Normal, when user-facing surfaces exist): Web/Portal pages, forms, dashboards, desktop/mobile GUI views, or interactive CLI/TUI output ergonomics.
   - \`qa\` (Priority 1 - Low): Unit/integration/E2E tests, safety/regression checks, and running the project's build/compile verification pipeline.
   *(If the user attached images, screenshots, schemas, logs, or reference files above, ALWAYS copy their exact Absolute Paths into the \`body\` of the relevant delegated tickets so those specialists can inspect or use them!)*
4. **Write Delegated Tickets to \`.emberline/new-tickets.json\`:**
   Create the directory \`.emberline\` if needed and write \`.emberline/new-tickets.json\` with the exact JSON structure below (include only the personas relevant to this request):
   \`\`\`json
   {
     "autoDispatch": ${autoDispatch ? 'true' : 'false'},
     "tickets": [
       {
         "title": "Core / Backend: <concise title>",
         "persona": "coder",
         "priority": 3,
         "body": "## Objective\\n...\\n\\n## Target Files\\n...\\n\\n## Acceptance Criteria\\n- ..."
       },
       {
         "title": "UI/UX or Surface: <concise title>",
         "persona": "ui_ux",
         "priority": 2,
         "body": "## Objective\\n...\\n\\n## Target Files\\n...\\n\\n## Acceptance Criteria\\n- ..."
       },
       {
         "title": "QA & Build Verification: <concise title>",
         "persona": "qa",
         "priority": 1,
         "body": "## Objective\\nAdd tests for the new changes and verify the project's build/test pipeline succeeds cleanly."
       }
     ]
   }
   \`\`\`
   *(Keep \`.emberline/new-tickets.json\` on disk when you finish; Emberline Core will automatically ingest it, create the tickets on the Kanban Board, sync your \`PROJECT.md\` update to \`main\`, and dispatch each specialist persona in priority order!)*
5. **Autonomous Execution Rule (CRITICAL):** Do NOT ask the user clarifying questions and do NOT wait for confirmation. Always select the cleanest architecture-appropriate design that fits \`PROJECT.md\` and write \`.emberline/new-tickets.json\` in this turn.`;
}

export async function ingestAgentTicketsFile(
  workspacePath: string,
): Promise<{ autoDispatch: boolean; tickets: AgentTicketDraft[] } | null> {
  const candidates = [
    path.join(workspacePath, '.emberline', 'new-tickets.json'),
    path.join(workspacePath, '.emberline', 'tickets.json'),
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = await readFile(filePath, 'utf-8');
      await rm(filePath, { force: true });
      const json = JSON.parse(raw) as unknown;
      const parsed = AgentCreateTicketsPayload.parse(
        Array.isArray(json) ? { autoDispatch: true, tickets: json } : json,
      );
      return parsed;
    } catch {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

const SYNC_PRESERVED_NAMES = new Set(['.git', 'node_modules', '.emberline', 'dist', 'build', '.next']);

async function pruneDeletedFromMain(worktreeDir: string, mainDir: string, depth = 0): Promise<void> {
  if (depth > 6 || !existsSync(mainDir)) return;
  let mainEntries;
  try {
    mainEntries = await readdir(mainDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of mainEntries) {
    if (SYNC_PRESERVED_NAMES.has(entry.name)) continue;
    const wtTarget = path.join(worktreeDir, entry.name);
    const mainTarget = path.join(mainDir, entry.name);
    if (!existsSync(wtTarget)) {
      await rm(mainTarget, { recursive: true, force: true }).catch(() => undefined);
    } else if (entry.isDirectory()) {
      await pruneDeletedFromMain(wtTarget, mainTarget, depth + 1);
    }
  }
}

export async function syncWorktreeToMainWorkspace(params: {
  worktreePath: string;
  mainWorkspacePath: string;
  ticketKey: string | null;
  runId: string;
}): Promise<SyncWorktreeResponse> {
  const { worktreePath, mainWorkspacePath, ticketKey, runId } = params;
  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`);
  }
  await mkdir(mainWorkspacePath, { recursive: true });

  // Remove files/directories in mainWorkspacePath that were deleted or renamed in worktreePath
  await pruneDeletedFromMain(worktreePath, mainWorkspacePath);

  const entries = await readdir(worktreePath, { withFileTypes: true });
  let syncedTopEntries = 0;

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.emberline') {
      continue;
    }
    const srcPath = path.join(worktreePath, entry.name);
    const destPath = path.join(mainWorkspacePath, entry.name);
    await cp(srcPath, destPath, {
      recursive: true,
      force: true,
      filter: (source) => {
        const base = path.basename(source);
        return base !== '.git' && base !== 'node_modules' && base !== '.emberline';
      },
    });
    syncedTopEntries += 1;
  }

  const mainFiles = await collectWorkspaceFiles(mainWorkspacePath);
  let commitSha: string | null = null;
  const label = ticketKey ?? runId.slice(0, 8);

  if (existsSync(path.join(mainWorkspacePath, '.git'))) {
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: mainWorkspacePath });
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: mainWorkspacePath,
      });
      if (statusOut.trim().length > 0) {
        await execFileAsync(
          'git',
          [
            '-c',
            'user.name=Emberline AI Factory',
            '-c',
            'user.email=factory@emberline.local',
            'commit',
            '-m',
            `feat(${label}): sync worktree output into main workspace`,
          ],
          { cwd: mainWorkspacePath },
        );
      }
      const { stdout: revOut } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: mainWorkspacePath,
      });
      commitSha = revOut.trim() || null;
    } catch {
      // Non-fatal if git commit is a no-op
    }
  }

  return {
    ok: true,
    runId,
    filesSynced: mainFiles.fileCount || syncedTopEntries,
    commitSha,
    summary: `Synced ${mainFiles.fileCount} project files from ${label} into ${mainWorkspacePath}${commitSha ? ` (commit ${commitSha})` : ''}.`,
  };
}

export async function buildWorkspaceDemo(params: {
  projectId: string;
  targetId: string;
  workspacePath: string;
}): Promise<BuildDemoResponse> {
  const { projectId, targetId, workspacePath } = params;
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace path not found: ${workspacePath}`);
  }

  const logs: string[] = [];
  const filesInfo = await collectWorkspaceFiles(workspacePath);
  const inspection = await inspectWorkspaceProject(workspacePath, filesInfo.topFiles);
  let buildCommandSucceeded = false;

  try {
    if (inspection.hasPackageJson) {
      const hasNodeModules = existsSync(path.join(workspacePath, 'node_modules'));
      const hasPnpmLock =
        existsSync(path.join(workspacePath, 'pnpm-lock.yaml')) ||
        existsSync(path.join(workspacePath, 'pnpm-workspace.yaml'));
      const hasYarnLock = existsSync(path.join(workspacePath, 'yarn.lock'));
      const pkgManager = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';
      const installArgs =
        pkgManager === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'];

      if (!hasNodeModules) {
        const { stdout, stderr } = await execFileAsync(pkgManager, installArgs, {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      const rawPkg = await readFile(path.join(workspacePath, 'package.json'), 'utf-8');
      const parsedPkg = JSON.parse(rawPkg) as { scripts?: Record<string, string> };
      const scripts = parsedPkg.scripts ?? {};
      const ciEnv = { ...process.env, CI: 'true', FORCE_COLOR: '0' };

      const buildScriptName =
        typeof scripts.build === 'string'
          ? 'build'
          : typeof scripts.typecheck === 'string'
            ? 'typecheck'
            : typeof scripts.check === 'string'
              ? 'check'
              : null;

      if (buildScriptName) {
        logs.push(`$ ${pkgManager} run ${buildScriptName}`);
        const { stdout, stderr } = await execFileAsync(pkgManager, ['run', buildScriptName], {
          cwd: workspacePath,
          timeout: 120_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      if (
        typeof scripts.lint === 'string' &&
        buildScriptName !== 'check' &&
        !scripts.lint.includes('--watch')
      ) {
        logs.push(`$ ${pkgManager} run lint`);
        const { stdout, stderr } = await execFileAsync(pkgManager, ['run', 'lint'], {
          cwd: workspacePath,
          timeout: 90_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      if (
        typeof scripts.test === 'string' &&
        !scripts.test.includes('no test specified') &&
        !scripts.test.includes('--watch') &&
        buildScriptName !== 'check'
      ) {
        const testArgs =
          scripts.test.trim() === 'vitest'
            ? ['run', 'test', '--', '--run']
            : ['run', 'test'];
        logs.push(`$ ${pkgManager} ${testArgs.join(' ')}`);
        const { stdout, stderr } = await execFileAsync(pkgManager, testArgs, {
          cwd: workspacePath,
          timeout: 120_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'platformio.ini'))) {
      const hasPio = await execFileAsync('sh', ['-c', 'command -v pio || command -v platformio']).then(() => true, () => false);
      if (hasPio) {
        logs.push('$ pio run');
        const { stdout, stderr } = await execFileAsync('sh', ['-c', 'pio run || platformio run'], {
          cwd: workspacePath,
          timeout: 180_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified PlatformIO firmware structure (platformio.ini present).');
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'Cargo.toml'))) {
      const hasCargo = await execFileAsync('sh', ['-c', 'command -v cargo']).then(() => true, () => false);
      if (hasCargo) {
        logs.push('$ cargo check');
        const { stdout, stderr } = await execFileAsync('cargo', ['check'], {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified Rust Cargo workspace structure (Cargo.toml present).');
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'go.mod'))) {
      const hasGo = await execFileAsync('sh', ['-c', 'command -v go']).then(() => true, () => false);
      if (hasGo) {
        logs.push('$ go build ./... && go test ./...');
        const { stdout, stderr } = await execFileAsync('sh', ['-c', 'go build ./... && go test ./...'], {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified Go module structure (go.mod present).');
      }
      buildCommandSucceeded = true;
    } else if (filesInfo.topFiles.some((f) => f.endsWith('.py'))) {
      logs.push('$ python3 -m compileall -q .');
      const { stdout, stderr } = await execFileAsync('python3', ['-m', 'compileall', '-q', '.'], {
        cwd: workspacePath,
        timeout: 60_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else if (filesInfo.topFiles.some((f) => f.endsWith('.sh'))) {
      const shFiles = filesInfo.topFiles.filter((f) => f.endsWith('.sh'));
      logs.push(`$ bash -n ${shFiles.join(' ')}`);
      const { stdout, stderr } = await execFileAsync('bash', ['-n', ...shFiles], {
        cwd: workspacePath,
        timeout: 30_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'Makefile'))) {
      logs.push('$ make');
      const { stdout, stderr } = await execFileAsync('make', [], {
        cwd: workspacePath,
        timeout: 120_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else {
      logs.push(`Verified workspace structure (${filesInfo.fileCount} files, stack: ${inspection.detectedStack}).`);
      buildCommandSucceeded = true;
    }
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) logs.push(execErr.stdout);
    if (typeof execErr.stderr === 'string' && execErr.stderr.trim()) logs.push(execErr.stderr);
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(msg);
    const fallbackEntry = await detectDemoEntryRelPath(workspacePath);
    return {
      ok: false,
      targetId,
      demoEntryRelPath: fallbackEntry,
      demoUrl: fallbackEntry ? `/api/projects/${projectId}/demo/${targetId}/` : null,
      output: logs.join('\n').slice(-4000),
    };
  }

  const demoEntryRelPath = await detectDemoEntryRelPath(workspacePath);
  return {
    ok: buildCommandSucceeded || Boolean(demoEntryRelPath),
    targetId,
    demoEntryRelPath,
    demoUrl: demoEntryRelPath ? `/api/projects/${projectId}/demo/${targetId}/` : null,
    output:
      logs.join('\n').slice(-4000) ||
      `Build & verification succeeded (${inspection.detectedStack}).`,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export async function serveWorkspaceDemoAsset(params: {
  workspacePath: string;
  demoBaseHref: string;
  subPath: string;
}): Promise<{ status: number; contentType: string; body: Buffer | string }> {
  const { workspacePath, demoBaseHref, subPath } = params;
  const entryRel = await detectDemoEntryRelPath(workspacePath);
  if (!entryRel) {
    return {
      status: 404,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body style="background:#0d0f14;color:#e2e8f0;font-family:sans-serif;padding:2rem;"><h3>No playable demo bundle found in ${workspacePath}</h3><p>Click <b>Build Demo</b> in the Emberline Project Status panel to compile the project.</p></body></html>`,
    };
  }

  const entryAbs = path.join(workspacePath, entryRel);
  const demoRootDir = path.dirname(entryAbs);
  const cleanSub = subPath.replace(/^\/+/, '');
  const requestedRel = cleanSub.length === 0 ? path.basename(entryAbs) : cleanSub;
  const resolvedAbs = path.resolve(demoRootDir, requestedRel);

  // Prevent path traversal outside demoRootDir
  if (!resolvedAbs.startsWith(demoRootDir + path.sep) && resolvedAbs !== demoRootDir) {
    return {
      status: 403,
      contentType: 'text/plain; charset=utf-8',
      body: 'Forbidden path',
    };
  }

  let targetFile = resolvedAbs;
  if (!existsSync(targetFile)) {
    // SPA fallback to entry HTML when extensionless route is requested
    if (!path.extname(targetFile)) {
      targetFile = entryAbs;
    } else {
      return {
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Asset not found: ${requestedRel}`,
      };
    }
  } else {
    const fileStat = await stat(targetFile);
    if (fileStat.isDirectory()) {
      targetFile = path.join(targetFile, 'index.html');
      if (!existsSync(targetFile)) {
        targetFile = entryAbs;
      }
    }
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  if (ext === '.html' || ext === '.htm') {
    let html = await readFile(targetFile, 'utf-8');
    const errorBridgeScript = `<script>(function(){function send(msg,stack){try{window.parent.postMessage({type:'emberline:demo-error',message:String(msg||'Runtime error'),stack:String(stack||'')},'*');}catch(_){}}window.addEventListener('error',function(e){send(e.message,e.error&&e.error.stack||e.filename+':'+e.lineno);});window.addEventListener('unhandledrejection',function(e){var r=e.reason;send(r&&r.message||String(r),r&&r.stack||'');});var origErr=console.error;console.error=function(){origErr.apply(console,arguments);try{var msg=Array.prototype.slice.call(arguments).map(function(a){return a instanceof Error?a.message:typeof a==='string'?a:JSON.stringify(a);}).join(' ');send(msg,'');}catch(_){}};})();</script>`;
    // Rewrite root-relative Vite/static asset URLs so they resolve under demoBaseHref
    html = html
      .replace(/\b(src|href)=["']\/(?!\/)/g, '$1="./')
      .replace(/<head([^>]*)>/i, `<head$1><base href="${demoBaseHref}">${errorBridgeScript}`);
    return {
      status: 200,
      contentType,
      body: html,
    };
  }

  const buf = await readFile(targetFile);
  return {
    status: 200,
    contentType,
    body: buf,
  };
}

// --- F7 & F10: Unified Factory Settings & Multi-Provider Routing ------------

const FACTORY_SETTINGS_KEY = 'factory.settings';
const FACTORY_KEYS_KEY = 'factory.providerKeys';

interface StoredProviderKeys {
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  geminiApiKey?: string | null;
}

const DEFAULT_PERSONA_AGENTS: Record<AgentPersona, AgentId> = {
  product_owner: 'claude',
  architect: 'claude',
  ui_ux: 'claude',
  coder: 'claude',
  dba: 'claude',
  qa: 'claude',
  security: 'claude',
};

const DEFAULT_PERSONA_MODELS: Record<AgentPersona, AgentModelId> = {
  product_owner: 'fable',
  architect: 'fable',
  ui_ux: 'opus',
  coder: 'opus',
  dba: 'opus',
  qa: 'sonnet',
  security: 'opus',
};

const ALL_PERSONA_KEYS: readonly AgentPersona[] = [
  'product_owner',
  'architect',
  'ui_ux',
  'coder',
  'dba',
  'qa',
  'security',
];

function hasNonEmptyAntigravitySecrets(home: string): boolean {
  try {
    const oauthTokenPath = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    if (existsSync(oauthTokenPath)) {
      const tokenRaw = readFileSync(oauthTokenPath, 'utf8').trim();
      if (tokenRaw.length > 10) {
        return true;
      }
    }
    const secretsPath = path.join(home, '.config', 'antigravity', 'plugin-secrets.json');
    if (existsSync(secretsPath)) {
      const raw = readFileSync(secretsPath, 'utf8').trim();
      if (raw.length > 4) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return true;
        }
      }
    }
    const jetskiPath = path.join(home, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt');
    if (existsSync(jetskiPath)) {
      const pbtxt = readFileSync(jetskiPath, 'utf8');
      if (/oauth_token|refresh_token|access_token/i.test(pbtxt)) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

function hasValidGeminiOAuth(home: string): boolean {
  try {
    if (
      existsSync(path.join(home, '.gemini', 'oauth_creds.json')) ||
      existsSync(path.join(home, '.gemini', 'gemini-credentials.json')) ||
      existsSync(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'))
    ) {
      return true;
    }
    const accountsPath = path.join(home, '.gemini', 'google_accounts.json');
    if (existsSync(accountsPath)) {
      const parsed = JSON.parse(readFileSync(accountsPath, 'utf8')) as { active?: string | null };
      if (typeof parsed?.active === 'string' && parsed.active.trim().length > 0) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

function detectRunnerProviderAuth(params: {
  anthropicKeyConfigured: boolean;
  openaiKeyConfigured: boolean;
  geminiKeyConfigured: boolean;
}) {
  const home = '/home/node';
  const claudeOAuth =
    existsSync(path.join(home, '.claude', '.credentials.json')) ||
    existsSync(path.join(home, '.claude.json'));
  const geminiOAuth = hasValidGeminiOAuth(home);
  const antigravityOAuth = hasNonEmptyAntigravitySecrets(home) || geminiOAuth;
  const codexOAuth = existsSync(path.join(home, '.codex', 'auth.json'));
  const copilotOAuth =
    existsSync(path.join(home, '.copilot')) ||
    existsSync(path.join(home, '.config', 'github-copilot')) ||
    existsSync(path.join(home, '.config', 'gh', 'hosts.yml'));

  return {
    claude: claudeOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Claude OAuth Active',
          cliInstalled: true,
          loginCommandHint: 'claude login',
        }
      : params.anthropicKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Anthropic API Key',
            cliInstalled: true,
            loginCommandHint: 'claude login',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'OAuth Login or API Key',
            cliInstalled: true,
            loginCommandHint: 'claude login',
          },
    antigravity: antigravityOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Google Account OAuth',
          cliInstalled: true,
          loginCommandHint: 'agy',
        }
      : params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Gemini API Key',
            cliInstalled: true,
            loginCommandHint: 'agy',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'Google OAuth (No Key Needed)',
            cliInstalled: true,
            loginCommandHint: 'agy',
          },
    gemini: geminiOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Google Account OAuth',
          cliInstalled: true,
          loginCommandHint: 'gemini',
        }
      : params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Gemini API Key',
            cliInstalled: true,
            loginCommandHint: 'gemini',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'API Key Recommended (or use Antigravity)',
            cliInstalled: true,
            loginCommandHint: 'gemini',
          },
    codex: codexOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ ChatGPT / Codex OAuth',
          cliInstalled: true,
          loginCommandHint: 'codex login',
        }
      : params.openaiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ OpenAI API Key',
            cliInstalled: true,
            loginCommandHint: 'codex login',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'ChatGPT OAuth or API Key',
            cliInstalled: true,
            loginCommandHint: 'codex login',
          },
    copilot: copilotOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ GitHub OAuth Active',
          cliInstalled: true,
          loginCommandHint: 'copilot login',
        }
      : {
          authenticated: false,
          method: 'none' as const,
          label: 'GitHub OAuth Login',
          cliInstalled: true,
          loginCommandHint: 'copilot login',
        },
    aider:
      params.anthropicKeyConfigured || params.openaiKeyConfigured || params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Uses Provider API Keys',
            cliInstalled: true,
            loginCommandHint: 'aider',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'API Key Recommended',
            cliInstalled: true,
            loginCommandHint: 'aider',
          },
  };
}

export function getFactorySettings(db: Db): FactorySettings {
  const row = db.select().from(settings).where(eq(settings.key, FACTORY_SETTINGS_KEY)).get();
  const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
  const raw = (row?.value ?? {}) as Partial<FactorySettings>;
  const keys = (keysRow?.value ?? {}) as StoredProviderKeys;

  const anthropicKeyConfigured = Boolean(keys.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const openaiKeyConfigured = Boolean(keys.openaiApiKey || process.env.OPENAI_API_KEY);
  const geminiKeyConfigured = Boolean(
    keys.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );
  const providerAuth = detectRunnerProviderAuth({
    anthropicKeyConfigured,
    openaiKeyConfigured,
    geminiKeyConfigured,
  });

  // Derive active/enabled providers: Claude is always available by default via Host CLI Auth / API key.
  const enabledSet = new Set<AgentId>(
    Array.isArray(raw.enabledProviders) && raw.enabledProviders.length > 0
      ? raw.enabledProviders
      : ['claude'],
  );
  if (enabledSet.size === 0) enabledSet.add('claude');
  if (!Array.isArray(raw.enabledProviders)) {
    if (openaiKeyConfigured || providerAuth.codex.authenticated) enabledSet.add('codex');
    if (geminiKeyConfigured || providerAuth.gemini.authenticated) enabledSet.add('gemini');
  }
  const enabledProviders = Array.from(enabledSet);

  const defaultAgent: AgentId =
    raw.defaultAgent && enabledSet.has(raw.defaultAgent)
      ? raw.defaultAgent
      : (enabledProviders[0] ?? 'claude');

  const rawPersonaAgents = {
    ...DEFAULT_PERSONA_AGENTS,
    ...(raw.personaAgents ?? {}),
  };
  const rawPersonaModels = {
    ...DEFAULT_PERSONA_MODELS,
    ...(raw.personaModels ?? {}),
  };

  const normalizedAgents = { ...DEFAULT_PERSONA_AGENTS };
  const normalizedModels = { ...DEFAULT_PERSONA_MODELS };

  for (const p of ALL_PERSONA_KEYS) {
    const candidateAgent = rawPersonaAgents[p] ?? defaultAgent;
    const validAgent = enabledSet.has(candidateAgent) ? candidateAgent : defaultAgent;
    normalizedAgents[p] = validAgent;
    const candidateModel = rawPersonaModels[p] ?? DEFAULT_PERSONA_MODELS[p];
    normalizedModels[p] = coerceModelForProvider(validAgent, candidateModel, p);
  }

  const storedMcpList = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  const storedMcpMap = new Map(storedMcpList.map((m) => [m.id, m]));
  const mergedMcpServers: McpServerEntry[] = DEFAULT_MCP_SERVERS.map((def) => {
    const saved = storedMcpMap.get(def.id);
    if (!saved) return def;
    storedMcpMap.delete(def.id);
    return {
      ...def,
      ...saved,
      builtIn: true,
    };
  });
  for (const custom of storedMcpMap.values()) {
    mergedMcpServers.push(custom);
  }

  const storedSkillList = Array.isArray(raw.skillPlugins) ? raw.skillPlugins : [];
  const storedSkillMap = new Map(storedSkillList.map((s) => [s.id, s]));
  const mergedSkillPlugins: SkillPluginEntry[] = DEFAULT_SKILL_PLUGINS.map((def) => {
    const saved = storedSkillMap.get(def.id);
    if (!saved) return def;
    storedSkillMap.delete(def.id);
    return {
      ...def,
      ...saved,
      builtIn: true,
    };
  });
  for (const custom of storedSkillMap.values()) {
    mergedSkillPlugins.push(custom);
  }

  return FactorySettings.parse({
    theme: raw.theme ?? 'dark',
    defaultAgent,
    enabledProviders,
    personaAgents: normalizedAgents,
    personaModels: normalizedModels,
    quotaAutoDowngrade: raw.quotaAutoDowngrade ?? true,
    autoPickupReady: raw.autoPickupReady ?? true,
    autoPickupBacklog: raw.autoPickupBacklog ?? false,
    autoSyncToMain: raw.autoSyncToMain ?? true,
    selfHealingBuildGate: raw.selfHealingBuildGate ?? true,
    antiSlopGate: raw.antiSlopGate ?? true,
    secretGuardGate: raw.secretGuardGate ?? true,
    crossProviderCritic: raw.crossProviderCritic ?? false,
    autoMoveToDone: raw.autoMoveToDone ?? true,
    mcpServers: mergedMcpServers,
    skillPlugins: mergedSkillPlugins,
    anthropicKeyConfigured,
    openaiKeyConfigured,
    geminiKeyConfigured,
    providerAuth,
  });
}

export function updateFactorySettings(db: Db, input: UpdateFactorySettingsBody): FactorySettings {
  const body = UpdateFactorySettingsBody.parse(input);
  const current = getFactorySettings(db);

  const enabledSet = new Set<AgentId>(body.enabledProviders ?? current.enabledProviders ?? ['claude']);
  if (body.openaiApiKey && body.openaiApiKey.trim().length > 0) {
    enabledSet.add('codex');
  }
  if (body.geminiApiKey && body.geminiApiKey.trim().length > 0) {
    enabledSet.add('gemini');
  }
  if (body.anthropicApiKey && body.anthropicApiKey.trim().length > 0) {
    enabledSet.add('claude');
  }
  if (enabledSet.size === 0) {
    enabledSet.add('claude');
  }
  const enabledProviders = Array.from(enabledSet);

  const nextDefaultAgent: AgentId =
    body.defaultAgent && enabledSet.has(body.defaultAgent)
      ? body.defaultAgent
      : enabledSet.has(current.defaultAgent)
        ? current.defaultAgent
        : (enabledProviders[0] ?? 'claude');

  const mergedAgents = {
    ...current.personaAgents,
    ...(body.personaAgents ?? {}),
  };
  const mergedModels = {
    ...current.personaModels,
    ...(body.personaModels ?? {}),
  };

  const normalizedAgents = { ...mergedAgents };
  const normalizedModels = { ...mergedModels };
  for (const p of ALL_PERSONA_KEYS) {
    const requestedAgent = mergedAgents[p] ?? nextDefaultAgent;
    const validAgent = enabledSet.has(requestedAgent) ? requestedAgent : nextDefaultAgent;
    normalizedAgents[p] = validAgent;
    normalizedModels[p] = coerceModelForProvider(validAgent, mergedModels[p] ?? DEFAULT_PERSONA_MODELS[p], p);
  }

  const nextValue = {
    theme: body.theme ?? current.theme,
    defaultAgent: nextDefaultAgent,
    enabledProviders,
    personaAgents: normalizedAgents,
    personaModels: normalizedModels,
    quotaAutoDowngrade: body.quotaAutoDowngrade ?? current.quotaAutoDowngrade,
    autoPickupReady: body.autoPickupReady ?? current.autoPickupReady,
    autoPickupBacklog: body.autoPickupBacklog ?? current.autoPickupBacklog,
    autoSyncToMain: body.autoSyncToMain ?? current.autoSyncToMain,
    selfHealingBuildGate: body.selfHealingBuildGate ?? current.selfHealingBuildGate,
    antiSlopGate: body.antiSlopGate ?? current.antiSlopGate,
    secretGuardGate: body.secretGuardGate ?? current.secretGuardGate,
    crossProviderCritic: body.crossProviderCritic ?? current.crossProviderCritic,
    autoMoveToDone: body.autoMoveToDone ?? current.autoMoveToDone,
    mcpServers: body.mcpServers ?? current.mcpServers,
    skillPlugins: body.skillPlugins ?? current.skillPlugins,
  };

  db.insert(settings)
    .values({ key: FACTORY_SETTINGS_KEY, value: nextValue })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: nextValue },
    })
    .run();

  if (
    body.anthropicApiKey !== undefined ||
    body.openaiApiKey !== undefined ||
    body.geminiApiKey !== undefined
  ) {
    const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
    const prevKeys = (keysRow?.value ?? {}) as StoredProviderKeys;
    const nextKeys: StoredProviderKeys = {
      anthropicApiKey:
        body.anthropicApiKey === undefined ? prevKeys.anthropicApiKey : body.anthropicApiKey || null,
      openaiApiKey:
        body.openaiApiKey === undefined ? prevKeys.openaiApiKey : body.openaiApiKey || null,
      geminiApiKey:
        body.geminiApiKey === undefined ? prevKeys.geminiApiKey : body.geminiApiKey || null,
    };
    db.insert(settings)
      .values({ key: FACTORY_KEYS_KEY, value: nextKeys })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: nextKeys },
      })
      .run();
  }

  return getFactorySettings(db);
}

export function getProviderEnvFromSettings(db: Db): Record<string, string> {
  const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
  const keys = (keysRow?.value ?? {}) as StoredProviderKeys;
  const env: Record<string, string> = {};
  if (keys.anthropicApiKey) env.ANTHROPIC_API_KEY = keys.anthropicApiKey;
  if (keys.openaiApiKey) env.OPENAI_API_KEY = keys.openaiApiKey;
  if (keys.geminiApiKey) {
    env.GEMINI_API_KEY = keys.geminiApiKey;
    env.GOOGLE_API_KEY = keys.geminiApiKey;
  }
  return env;
}

export function resolveAgentForPersona(
  db: Db,
  persona: AgentPersona,
  explicitAgent?: AgentId,
): AgentId {
  const cfg = getFactorySettings(db);
  if (explicitAgent && cfg.enabledProviders.includes(explicitAgent)) return explicitAgent;
  const personaAgent = cfg.personaAgents[persona];
  if (personaAgent && cfg.enabledProviders.includes(personaAgent)) return personaAgent;
  return cfg.defaultAgent ?? 'claude';
}

export function resolveModelForPersona(
  db: Db,
  persona: AgentPersona,
  explicitModel?: AgentModelId,
  explicitAgent?: AgentId,
): AgentModelId {
  const cfg = getFactorySettings(db);
  const agent = resolveAgentForPersona(db, persona, explicitAgent);
  const rawCandidate =
    explicitModel && explicitModel !== 'auto'
      ? explicitModel
      : (cfg.personaModels?.[persona] ?? DEFAULT_PERSONA_MODELS[persona] ?? 'opus');
  const candidate = coerceModelForProvider(agent, rawCandidate, persona);
  if (
    cfg.quotaAutoDowngrade &&
    agent === 'claude' &&
    getLastKnownClaudeUtilizationPercent() >= 80 &&
    (candidate === 'fable' || candidate === 'opus')
  ) {
    return selectProviderModelByRank(agent, 3);
  }
  return candidate;
}

export function resolveMcpServersForPersona(
  db: Db,
  persona: AgentPersona,
): {
  playwrightEnabled: boolean;
  customMcpServers: Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: 'stdio' | 'sse' | 'http' }
  >;
} {
  const cfg = getFactorySettings(db);
  let playwrightEnabled = true;
  const customMcpServers: Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: 'stdio' | 'sse' | 'http' }
  > = {};

  for (const srv of cfg.mcpServers ?? []) {
    const matchesPersona = srv.personas.length === 0 || srv.personas.includes(persona);
    if (srv.id === 'playwright') {
      playwrightEnabled = Boolean(srv.enabled && matchesPersona);
      continue;
    }
    if (!srv.enabled || !matchesPersona) continue;
    if (srv.transport === 'stdio' && srv.command.trim()) {
      customMcpServers[srv.id] = {
        command: srv.command.trim(),
        args: srv.args,
        ...(Object.keys(srv.env).length > 0 ? { env: srv.env } : {}),
      };
    } else if ((srv.transport === 'sse' || srv.transport === 'http') && srv.url?.trim()) {
      customMcpServers[srv.id] = {
        type: srv.transport,
        url: srv.url.trim(),
      };
    }
  }

  return { playwrightEnabled, customMcpServers };
}

export function resolveSkillPluginPromptForPersona(db: Db, persona: AgentPersona): string {
  const cfg = getFactorySettings(db);
  const activeSkills = (cfg.skillPlugins ?? []).filter(
    (s) => s.enabled && (s.personas.length === 0 || s.personas.includes(persona)),
  );
  if (activeSkills.length === 0) return '';
  return [
    '[ACTIVE FACTORY SKILL & RULE PLUGINS]:',
    ...activeSkills.map((s) => `- [${s.name}]: ${s.instructions.trim()}`),
  ].join('\n');
}

// --- F8: VS Code-like Code Explorer & File Editor ---------------------------

const EXPLORER_IGNORED = new Set([
  '.git',
  'node_modules',
  '.emberline',
  '.turbo',
  '.next',
  'coverage',
  '.gradle',
  'intermediates',
  '__pycache__',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.apk',
  '.aab',
  '.ipa',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.elf',
  '.uf2',
  '.hex',
  '.img',
  '.iso',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.class',
  '.dex',
  '.wasm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.avif',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.keystore',
  '.jks',
  '.p12',
  '.pfx',
  '.pyc',
  '.pyo',
  '.o',
  '.a',
  '.lib',
]);

const DOWNLOAD_MIME_BY_EXT: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveSafeWorkspaceFile(workspacePath: string, relPath: string): string {
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanRel) throw new Error('File path cannot be empty');
  const absRoot = path.resolve(workspacePath);
  const resolved = path.resolve(absRoot, cleanRel);
  if (!resolved.startsWith(absRoot + path.sep)) {
    throw new Error('Path traversal outside workspace is forbidden');
  }
  return resolved;
}

export async function listWorkspaceFilesFlat(workspacePath: string): Promise<WorkspaceFileEntry[]> {
  if (!existsSync(workspacePath)) return [];
  const entries: WorkspaceFileEntry[] = [];
  const absRoot = path.resolve(workspacePath);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 10 || entries.length >= 2500) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (EXPLORER_IGNORED.has(item.name)) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(absRoot, fullPath);
      try {
        const st = await stat(fullPath);
        if (item.isDirectory()) {
          entries.push({
            path: relPath,
            name: item.name,
            kind: 'directory',
            sizeBytes: 0,
            mtime: st.mtime.toISOString(),
          });
          await walk(fullPath, depth + 1);
        } else if (item.isFile()) {
          entries.push({
            path: relPath,
            name: item.name,
            kind: 'file',
            sizeBytes: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
      } catch {
        // ignore broken symlink
      }
      if (entries.length >= 2500) return;
    }
  }

  await walk(absRoot, 0);
  return entries;
}

export async function readWorkspaceFileContent(
  workspacePath: string,
  targetId: string,
  relPath: string,
): Promise<WorkspaceFileContentResponse> {
  const absFile = resolveSafeWorkspaceFile(workspacePath, relPath);
  if (!existsSync(absFile)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const st = await stat(absFile);
  if (st.isDirectory()) {
    throw new Error(`Cannot read directory as file: ${relPath}`);
  }
  const ext = path.extname(absFile).toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(ext) || st.size > 2 * 1024 * 1024) {
    return {
      targetId,
      path: relPath,
      content: '',
      binary: true,
      sizeBytes: st.size,
    };
  }
  const buf = await readFile(absFile);
  const sample = buf.subarray(0, 8192);
  const binary = sample.includes(0);
  return {
    targetId,
    path: relPath,
    content: binary ? '' : buf.toString('utf-8'),
    binary,
    sizeBytes: st.size,
  };
}

export async function readWorkspaceFileRaw(
  workspacePath: string,
  relPath: string,
): Promise<{
  absFile: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  buffer: Buffer;
}> {
  const absFile = resolveSafeWorkspaceFile(workspacePath, relPath);
  if (!existsSync(absFile)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const st = await stat(absFile);
  if (st.isDirectory()) {
    throw new Error(`Cannot download a directory directly: ${relPath}`);
  }
  const ext = path.extname(absFile).toLowerCase();
  const contentType = DOWNLOAD_MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buffer = await readFile(absFile);
  return {
    absFile,
    fileName: path.basename(absFile),
    contentType,
    sizeBytes: st.size,
    buffer,
  };
}

export async function uploadWorkspaceFiles(
  workspacePath: string,
  targetId: string,
  files: UploadWorkspaceFileItem[],
): Promise<UploadWorkspaceFilesResponse> {
  const uploadedPaths: string[] = [];
  for (const item of files) {
    const cleanRel = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const absFile = resolveSafeWorkspaceFile(workspacePath, cleanRel);
    await mkdir(path.dirname(absFile), { recursive: true });
    const rawBase64 = item.dataBase64.includes(',')
      ? (item.dataBase64.split(',')[1] ?? '')
      : item.dataBase64;
    const buf = Buffer.from(rawBase64, 'base64');
    await writeFile(absFile, buf);
    uploadedPaths.push(cleanRel);
  }
  return {
    targetId,
    uploadedPaths,
  };
}

export async function writeWorkspaceFileContent(
  workspacePath: string,
  targetId: string,
  relPath: string,
  content: string,
): Promise<WorkspaceFileContentResponse> {
  const absFile = resolveSafeWorkspaceFile(workspacePath, relPath);
  await mkdir(path.dirname(absFile), { recursive: true });
  await writeFile(absFile, content, 'utf-8');
  const st = await stat(absFile);
  return {
    targetId,
    path: relPath,
    content,
    binary: false,
    sizeBytes: st.size,
  };
}

export async function deleteWorkspaceFileEntry(workspacePath: string, relPath: string): Promise<void> {
  const absFile = resolveSafeWorkspaceFile(workspacePath, relPath);
  await rm(absFile, { recursive: true, force: true });
}

// --- F9: Checkpoints, Rollback & Project Archive Export ---------------------

export async function listProjectCheckpoints(workspacePath: string): Promise<ProjectCheckpoint[]> {
  if (!existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-n', '25', '--pretty=format:%H%x09%h%x09%s%x09%an%x09%cI'],
      { cwd: workspacePath },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = '', shortSha = '', subject = '', author = '', createdAt = ''] = line.split('\t');
        return { sha, shortSha, subject, author, createdAt };
      })
      .filter((c) => Boolean(c.sha));
  } catch {
    return [];
  }
}

export async function rollbackProjectCheckpoint(
  workspacePath: string,
  sha: string,
): Promise<{ ok: boolean; sha: string; summary: string }> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha.trim())) {
    throw new Error('Invalid commit SHA');
  }
  await execFileAsync('git', ['reset', '--hard', sha.trim()], { cwd: workspacePath });
  return {
    ok: true,
    sha: sha.trim(),
    summary: `Main workspace rolled back to checkpoint ${sha.trim().slice(0, 8)}.`,
  };
}

export async function exportProjectTarGz(workspacePath: string): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `emberline-export-${Date.now()}.tar.gz`);
  try {
    await execFileAsync(
      'tar',
      [
        '-czf',
        tmpFile,
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=.emberline',
        '.',
      ],
      { cwd: workspacePath, timeout: 60_000 },
    );
    return await readFile(tmpFile);
  } finally {
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

// --- F11: Live Browser / X11 & Headless Chromium Viewport Stream ------------

export async function captureBrowserViewportSnapshot(params: {
  targetUrl: string | null;
}): Promise<BrowserViewportSnapshot> {
  const nowIso = new Date().toISOString();
  const tmpPng = path.join(os.tmpdir(), `emberline-viewport-${Date.now()}.png`);

  try {
    // 1. If a demo or preview URL is available, capture live Chromium screenshot
    if (params.targetUrl) {
      const bins = ['chromium', 'chromium-browser', 'google-chrome'];
      for (const bin of bins) {
        try {
          await execFileAsync(
            bin,
            [
              '--headless',
              '--no-sandbox',
              '--disable-gpu',
              '--hide-scrollbars',
              '--window-size=1280,720',
              `--screenshot=${tmpPng}`,
              params.targetUrl,
            ],
            { timeout: 15_000 },
          );
          if (existsSync(tmpPng)) {
            const buf = await readFile(tmpPng);
            return {
              available: true,
              source: 'headless_browser',
              targetUrl: params.targetUrl,
              imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
              capturedAt: nowIso,
              message: `Captured live Chromium frame from ${params.targetUrl}`,
            };
          }
        } catch {
          // try next binary
        }
      }
    }

    return {
      available: false,
      source: 'none',
      targetUrl: params.targetUrl,
      imageDataUrl: null,
      capturedAt: nowIso,
      message: 'Use the embedded Live Demo Player above or start a Playwright/Preview session.',
    };
  } finally {
    await rm(tmpPng, { force: true }).catch(() => undefined);
  }
}



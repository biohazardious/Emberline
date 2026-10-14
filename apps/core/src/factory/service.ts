import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Project,
  ProjectAppType,
  ProjectBlueprintResponse,
  ProjectRecommendation,
  ProjectTechStack,
  Run,
  TaskTemplate,
  Ticket,
} from '@emberline/protocol';
import type { TicketService } from '../tickets/service.js';

const execFileAsync = promisify(execFile);

export const APP_TYPE_LABELS: Record<ProjectAppType, string> = {
  web_saas: 'Web SaaS Application',
  fullstack: 'Full-Stack Web Platform',
  api_service: 'Backend API / Microservice',
  cli_tool: 'CLI Tool / Developer Utility',
  mobile_desktop: 'Mobile / Desktop App',
  library: 'SDK / Package Library',
  custom: 'Custom Software Project',
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
  if (stack?.language) stackLines.push(`- **Primary Language:** ${stack.language}`);
  if (stack?.frontend) stackLines.push(`- **Frontend Framework:** ${stack.frontend}`);
  if (stack?.backend) stackLines.push(`- **Backend / Runtime:** ${stack.backend}`);
  if (stack?.database) stackLines.push(`- **Database & ORM:** ${stack.database}`);
  if (stack?.styling) stackLines.push(`- **UI & Styling:** ${stack.styling}`);
  if (stack?.testing) stackLines.push(`- **Testing & QA:** ${stack.testing}`);

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

1. **Always read \`PROJECT.md\` first** before planning or making changes. It is the living source of truth for product vision, tech stack, architecture rules, and milestones.
2. **Respect your assigned Persona role** (Product Owner, Architect, UI/UX, Coder, DBA, QA, or Security) when executing a task.
3. **Verify your work:** Run relevant typechecks, linters, and tests before concluding your turn.
4. **Keep \`PROJECT.md\` up to date** whenever architectural boundaries, commands, or milestones evolve.
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

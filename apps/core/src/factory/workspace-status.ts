/** Workspace inspection: stack detection, demo entry discovery, status summary and recommendations. */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Project,
  type ProjectBlueprintResponse,
  type ProjectRecommendation,
  type ProjectStatusSummary,
  type Run,
  type Ticket,
  type WorkspaceDemoTarget,
} from '@emberline/protocol';

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

export async function collectWorkspaceFiles(
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

export async function inspectWorkspaceProject(
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
  const hasFlutter = existsSync(path.join(workspacePath, 'pubspec.yaml'));
  const hasGradle =
    existsSync(path.join(workspacePath, 'gradlew')) || existsSync(path.join(workspacePath, 'android', 'gradlew'));
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
    existsSync(path.join(workspacePath, 'ios')) ||
    hasFlutter ||
    hasGradle
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
      if (deps.electron || deps['@tauri-apps/api'] || deps['@capacitor/core'] || deps.expo || deps['react-native']) {
        layers.add('Desktop / Mobile Native');
      }
      if (deps.electron) detectedStack = `Electron Desktop (${pkgManager})`;
      else if (deps['@capacitor/core']) detectedStack = `Capacitor Mobile (${pkgManager})`;
      else if (deps.expo || deps['react-native']) detectedStack = `React Native / Expo (${pkgManager})`;
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
  } else if (hasFlutter) {
    detectedStack = 'Flutter (Dart)';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'flutter analyze && flutter test';
  } else if (hasCargo) {
    detectedStack = existsSync(path.join(workspacePath, 'src-tauri')) ? 'Rust + Tauri Desktop' : 'Rust / Cargo';
    hasBuildScript = true;
    buildCommand = buildCommand ?? 'cargo check';
  } else if (hasGradle && !hasPackageJson) {
    detectedStack = 'Android (Gradle)';
    hasBuildScript = true;
    buildCommand = './gradlew assembleDebug';
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

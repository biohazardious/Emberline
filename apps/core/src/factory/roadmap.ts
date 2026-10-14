import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentId,
  AgentModelId,
  AgentPersona,
  BrainstormRequestBody,
  BrainstormResponse,
  BrainstormSuggestion,
  CreateMilestoneBody,
  CreateRoadmapItemBody,
  DispatchRoadmapItemsBody,
  DispatchRoadmapItemsResponse,
  FactorySettings,
  Project,
  ProjectRoadmapState,
  RoadmapCategory,
  RoadmapItem,
  RoadmapMilestone,
  Ticket,
  UpdateRoadmapItemBody,
} from '@emberline/protocol';
import type { TicketService } from '../tickets/service.js';
import { listWorkspaceFilesFlat, readProjectBlueprint } from './service.js';

interface StoredRoadmapFile {
  visionSummary?: string;
  milestones: RoadmapMilestone[];
  suggestions: BrainstormSuggestion[];
  updatedAt: string;
}

const ROADMAP_REL_PATH = '.emberline/roadmap.json';
const BRAINSTORM_OUT_REL_PATH = '.emberline/brainstorm-suggestions.json';

function defaultRoutingForPersona(
  persona: AgentPersona,
  fSettings?: FactorySettings,
): {
  preferredAgent: AgentId;
  preferredModel: AgentModelId;
} {
  if (fSettings) {
    const preferredAgent = fSettings.personaAgents[persona] ?? fSettings.defaultAgent ?? 'claude';
    const preferredModel =
      fSettings.personaModels?.[persona] ??
      (persona === 'product_owner' || persona === 'architect'
        ? 'fable'
        : persona === 'qa'
          ? 'sonnet'
          : 'opus');
    return { preferredAgent, preferredModel };
  }
  switch (persona) {
    case 'product_owner':
    case 'architect':
      return { preferredAgent: 'claude', preferredModel: 'fable' };
    case 'ui_ux':
    case 'coder':
    case 'dba':
    case 'security':
      return { preferredAgent: 'claude', preferredModel: 'opus' };
    case 'qa':
      return { preferredAgent: 'claude', preferredModel: 'sonnet' };
    default:
      return { preferredAgent: 'claude', preferredModel: 'opus' };
  }
}

function categoryForPersona(persona: AgentPersona): RoadmapCategory {
  if (persona === 'ui_ux') return 'ui_ux';
  if (persona === 'architect' || persona === 'product_owner' || persona === 'dba') return 'architecture';
  if (persona === 'qa' || persona === 'security') return 'qa_security';
  return 'feature';
}

function milestoneIndexForPersona(persona: AgentPersona): number {
  if (persona === 'product_owner' || persona === 'architect') return 0; // M1
  if (persona === 'coder' || persona === 'dba') return 1; // M2
  if (persona === 'ui_ux') return 2; // M3
  return 3; // M4 (qa / security)
}

function extractVisionFromBlueprint(project: Project, blueprintContent: string): string {
  if (project.description && project.description.trim().length > 10) {
    return project.description.trim();
  }
  const match = /##\s*1\.\s*Product Vision[^\n]*\n+([\s\S]*?)(?:\n---|\n##\s|$)/i.exec(blueprintContent);
  if (match?.[1]?.trim()) {
    return match[1].trim().slice(0, 600);
  }
  return `${project.name} — Autonomous multi-agent software project orchestrated by Emberline.`;
}

/**
 * Generates codebase-aware, domain-intelligent brainstorming suggestions by inspecting
 * the project's files, blueprint, existing roadmap items, and optional user focus query.
 */
export async function synthesizeBrainstormSuggestions(
  project: Project,
  blueprintContent: string,
  existingTitles: Set<string>,
  focus = '',
  currentSuggestionTitles = new Set<string>(),
  fSettings?: FactorySettings,
): Promise<BrainstormSuggestion[]> {
  const files = await listWorkspaceFilesFlat(project.path).catch(() => []);
  const fileNamesLower = files.map((f) => f.path.toLowerCase()).join(' ');
  const stackText = project.techStack
    ? `${project.techStack.language} ${project.techStack.frontend} ${project.techStack.backend} ${project.techStack.database}`
    : '';
  const combinedContext = `${project.name} ${project.appType} ${project.description} ${stackText} ${blueprintContent} ${fileNamesLower}`.toLowerCase();

  const isEmbeddedOrHardware =
    project.appType === 'embedded_iot' ||
    /esp32|esp8266|arduino|platformio|stm32|firmware|eeprom|i2c|spi|uart|gpio|chip|lexmark|mcu|\.ino\b|platformio\.ini/.test(
      combinedContext,
    );
  const isCliOrSystem =
    project.appType === 'cli_tool' ||
    /truenas|nvidia|driver|kernel|systemd|cron|installer|updater|cli|shell|bash|zfs|devops|daemon/.test(
      combinedContext,
    );
  const isDesktopOrMobile =
    project.appType === 'mobile_desktop' ||
    /tauri|electron|marquee|desktop|overlay|window|tray|flutter|react-native|qt|gtk|wpf|maui/.test(
      combinedContext,
    );
  const isAiAgents =
    project.appType === 'ai_agents' ||
    /multi-agent|nexus|orchestrat|llm|agentic|mcp|prompt-router|autonomous-agent|rag|vector/.test(
      combinedContext,
    );
  const isFlappyOrArcade = /flappy|bird|endless-runner|arcade|petiqa/.test(combinedContext);
  const isTowerOrStrategy = /tower-defen[cs]e|turret/.test(combinedContext);
  const isGameOrInteractive =
    project.appType === 'game_interactive' ||
    isFlappyOrArcade ||
    isTowerOrStrategy ||
    /\b(game|phaser|pixi|webgl|sprite|gameplay)\b/.test(combinedContext);
  const isApiOrBackend =
    project.appType === 'api_service' ||
    project.appType === 'library' ||
    /fastify|express|nest|fastapi|grpc|graphql|microservice|webhook|worker/.test(combinedContext);
  const isPortalOrFullstack =
    project.appType === 'fullstack' ||
    project.appType === 'web_saas' ||
    /portal|dashboard|form|kesinti|outage|workflow|approval|rbac|tenant|admin|crm|erp/.test(
      combinedContext,
    );

  const candidates: Array<Omit<BrainstormSuggestion, 'id'>> = [];

  if (focus.trim()) {
    const cleanFocus = focus.trim();
    candidates.push(
      {
        title: `Architecture & Core Implementation: ${cleanFocus.slice(0, 72)}`,
        rationale: `Directly implements "${cleanFocus}" across the project's domain logic, service layer, and state contracts.`,
        implementationPrompt: `Read PROJECT.md and inspect the codebase structure. Design and implement the following capability end-to-end: "${cleanFocus}". Maintain clean module boundaries, input validation, and verify the project's build/test pipeline when finished.`,
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `Interface, UX & Ergonomics for: ${cleanFocus.slice(0, 64)}`,
        rationale: `Delivers a clean, responsive user interface or CLI/GUI interaction flow for "${cleanFocus}".`,
        implementationPrompt: `Read PROJECT.md and implement the user-facing interface, views, forms, or CLI/GUI ergonomics for: "${cleanFocus}". Ensure clear feedback states, error handling, and verify the build passes cleanly.`,
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: `Automated Verification & Regression Tests for: ${cleanFocus.slice(0, 56)}`,
        rationale: `Verifies "${cleanFocus}" with automated unit/integration tests and build checks.`,
        implementationPrompt: `Verify the implementation of "${cleanFocus}". Add automated unit/integration tests covering happy paths and edge cases, and run the project's build/test suite to confirm zero regressions.`,
        category: 'qa_security',
        impact: 'medium',
        effort: 'small',
        persona: 'qa',
        preferredAgent: 'claude',
        preferredModel: 'sonnet',
        suggestedMilestoneCode: 'M4',
      },
    );
  }

  // 1. Embedded / IoT / Hardware Firmware (e.g., esp32_lexmark_chip_reset)
  if (isEmbeddedOrHardware) {
    candidates.push(
      {
        title: 'Hardware Bus Scanner (I2C/SPI/UART), Address Probing & CRC/ACK Verification',
        rationale:
          'Automatically scans connected bus addresses, validates device signatures, and checks ACK/CRC framing before any register write.',
        implementationPrompt:
          'Read PROJECT.md and implement a deterministic hardware bus scanner and protocol handshake verifier (I2C/SPI/UART address probing, device ID validation, timeout retries, and CRC/ACK checks). Document pinout and status codes.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'Safe EEPROM / Chip Register Dump, Hex Backup & Read-After-Write Verification',
        rationale:
          'Prevents corrupting target hardware chips by dumping original register/EEPROM bytes first, writing the reset payload in page-aligned chunks, and verifying byte-for-byte.',
        implementationPrompt:
          'Implement a safe Read -> Backup Dump -> Write -> Verify state machine for chip/EEPROM operations, including hex dump output over Serial/WebUI and automatic abort on write mismatch.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Interactive Serial / Web-Serial Diagnostic Console & Status LED Patterns',
        rationale:
          'Allows operators to trigger chip scan, dump, reset, and dry-run commands interactively via Serial/Web-UI with clear diagnostic telemetry.',
        implementationPrompt:
          'Add an interactive command parser (scan, dump, verify, reset, status, help) over Serial / Web interface along with clear hardware status indicator states and error codes.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'small',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
    );
  }

  // 2. System / CLI / Driver & Infrastructure Automation (e.g., truenas-nvidia-driver-updater)
  if (isCliOrSystem) {
    candidates.push(
      {
        title: 'Pre-Flight OS/Kernel Compatibility Check & Non-Destructive Dry-Run Mode (--dry-run)',
        rationale:
          'Validates OS version, kernel headers, disk space, and privileges before making any system changes, and lets admins preview every command via --dry-run.',
        implementationPrompt:
          'Read PROJECT.md and implement pre-flight environment checks (OS/release detection, kernel version match, root/privilege check, required binaries) and a comprehensive --dry-run mode that logs all planned system operations without mutating state.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'Atomic Backup Snapshot, Checksum Verification & Automatic Rollback on Failure',
        rationale:
          'Guarantees system safety during driver/package updates bysnapshotting current binaries/configs, verifying SHA256 checksums of downloads, and rolling back automatically if post-install validation fails.',
        implementationPrompt:
          'Implement SHA256 artifact checksum verification, pre-update state backup, post-install health check (e.g. module load / binary check), and automatic rollback handler on error traps.',
        category: 'qa_security',
        impact: 'high',
        effort: 'medium',
        persona: 'security',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M4',
      },
      {
        title: 'Structured CLI Flags, ANSI Progress Telemetry & Unattended Cron/Init Hook',
        rationale:
          'Supports both interactive terminal operators (clear progress steps & summary table) and unattended post-init/cron execution (--yes, --json, log rotation).',
        implementationPrompt:
          'Enhance the CLI interface with structured flag parsing (--check, --update, --rollback, --dry-run, --json, --yes), timestamped log file output, and an idempotent lockfile to prevent concurrent runs.',
        category: 'feature',
        impact: 'high',
        effort: 'small',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
    );
  }

  // 3. Desktop / Mobile / Display & Media Apps (e.g., Marquee, Tauri/Electron/Native GUI)
  if (isDesktopOrMobile) {
    candidates.push(
      {
        title: 'Multi-Monitor Window Positioning, Always-on-Top Overlay & Display Geometry Manager',
        rationale:
          'Provides precise control over screen docking, DPI scaling, frameless/transparent overlay modes, and multi-display persistence.',
        implementationPrompt:
          'Read PROJECT.md and implement display geometry & window management controls (monitor selection, docking/alignment, always-on-top toggle, click-through/overlay mode, and saved window bounds).',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'System Tray Controller, Global Keyboard Shortcuts & Live Preset Switcher',
        rationale:
          'Lets users control the desktop app seamlessly from the OS system tray or global hotkeys without interrupting their active window.',
        implementationPrompt:
          'Implement system tray menu integration, configurable global keyboard shortcuts, and a live preset/profile switcher persisted in local configuration.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: 'Cross-Platform Packaging, Crash-Safe Config Store & Hardware-Accelerated Rendering',
        rationale:
          'Ensures smooth 60fps rendering with minimal CPU/GPU footprint and atomic configuration saves across Linux, Windows, and macOS.',
        implementationPrompt:
          'Implement atomic config persistence with schema migration, optimize rendering performance when minimized/occluded, and configure cross-platform build targets.',
        category: 'performance',
        impact: 'medium',
        effort: 'small',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M4',
      },
    );
  }

  // 4. Multi-Agent AI / Orchestration Platforms (e.g., Nexus Agents)
  if (isAiAgents) {
    candidates.push(
      {
        title: 'Capability-Based Multi-Agent Router, Model Tier Fallback & Token Cost Ledger',
        rationale:
          'Routes complex tasks across specialized agents/models (e.g. deep reasoning vs fast execution) with automatic rate-limit fallback and per-run token accounting.',
        implementationPrompt:
          'Read PROJECT.md and implement a capability-based agent router with model tier selection, automatic retry/fallback on rate limits, and a persistent token/cost usage ledger.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'DAG Task Pipeline Executor, Shared Context Memory & Tool Call Inspector',
        rationale:
          'Coordinates multi-step agent handoffs (Planner -> Specialist -> Verifier) with structured artifact passing and live streaming telemetry.',
        implementationPrompt:
          'Implement a sequential/DAG task handoff coordinator with structured JSON contract validation between agents and a real-time execution timeline view.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
    );
  }

  // 5. Enterprise Portals, Business Forms & Full-Stack Systems (e.g., aktechportal, kesinti formu, duraq)
  if (isPortalOrFullstack || (!isEmbeddedOrHardware && !isCliOrSystem && !isGameOrInteractive)) {
    candidates.push(
      {
        title: 'Multi-Step Form Workflow, Strict Schema Validation & Draft Auto-Save',
        rationale:
          'Eliminates data entry errors in complex operational forms (e.g. outage/incident reports, service requests) with field-level Zod validation, conditional sections, and draft recovery.',
        implementationPrompt:
          'Read PROJECT.md and implement structured form workflows with strict client/server schema validation, clear inline error messages, attachment support, and automatic draft persistence.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Role-Based Access Control (RBAC), Approval Status Pipeline & Audit Trail',
        rationale:
          'Tracks every record transition (Submitted -> In Review -> Approved / Resolved) with user attribution, timestamps, and role permissions.',
        implementationPrompt:
          'Design and implement role-based permission guards, a structured status transition workflow, and an immutable audit log recording who changed what and when.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'Interactive Data Grid, Advanced Multi-Filter Search & CSV/PDF Report Export',
        rationale:
          'Lets operators filter records by date range, status, category, or keyword and export clean operational reports in 1 click.',
        implementationPrompt:
          'Implement a responsive data table with multi-criteria filtering, sorting, pagination, KPI summary cards at the top, and 1-click CSV/printable report export.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
    );
  }

  // 6. Backend API / Microservices & Data Layer
  if (isApiOrBackend) {
    candidates.push(
      {
        title: 'OpenAPI / Swagger Interactive Documentation & Strict Boundary Validation',
        rationale:
          'Provides self-documenting API contracts and strict request/response schema validation for every endpoint.',
        implementationPrompt:
          'Add comprehensive Zod/schema request and response validation across all API routes, standardized error envelopes, and an interactive API documentation/health endpoint.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'Database Indexing, Migration Safety & Query Performance Optimization',
        rationale:
          'Ensures fast response times under load with proper foreign-key indexes, safe transactional writes, and reversible migrations.',
        implementationPrompt:
          'Audit the database schema and queries in the project, add missing indexes and transactional boundaries, and verify migrations and seed data run cleanly.',
        category: 'performance',
        impact: 'high',
        effort: 'small',
        persona: 'dba',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Rate Limiting, Structured Audit Logging & Security Hardening',
        rationale:
          'Hardens the service against abuse with rate limiting, CORS/CSRF protection, and structured JSON audit trails.',
        implementationPrompt:
          'Implement request rate limiting, security headers, and structured audit logging for sensitive mutations, along with integration tests.',
        category: 'qa_security',
        impact: 'high',
        effort: 'small',
        persona: 'security',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M4',
      },
    );
  }

  // 7. Interactive / Game / Canvas (ONLY when project actually matches game/interactive)
  if (isGameOrInteractive) {
    if (isFlappyOrArcade) {
      candidates.push(
        {
          title: 'Power-Up Collectibles (Shield Bubble, Coin Magnet, Slow-Mo & Score 2x)',
          rationale:
            'Spawns collectible power-up orbs that grant temporary invulnerability, magnet attraction, or double points with HUD timers.',
          implementationPrompt:
            'Read PROJECT.md and implement collectible Power-Ups (Shield Bubble, Magnet, Slow-Mo, and 2x Score Multiplier) with visual aura effects and active duration bars in the HUD.',
          category: 'feature',
          impact: 'high',
          effort: 'medium',
          persona: 'coder',
          preferredAgent: 'claude',
          preferredModel: 'opus',
          suggestedMilestoneCode: 'M2',
        },
        {
          title: 'Unlockable Skins, Particle Trails & Customization Shop Modal',
          rationale:
            'Gives players a progression loop by unlocking custom character skins and particle trails persisted in localStorage.',
          implementationPrompt:
            'Implement an interactive Customization Shop accessible from the title/game-over screen to unlock and equip skins and particle trails.',
          category: 'ui_ux',
          impact: 'high',
          effort: 'medium',
          persona: 'ui_ux',
          preferredAgent: 'claude',
          preferredModel: 'opus',
          suggestedMilestoneCode: 'M3',
        },
      );
    }
    if (isTowerOrStrategy) {
      candidates.push({
        title: 'Boss Waves, Elite Modifiers & Branching Specialization Tech Tree',
        rationale:
          'Adds strategic depth with boss waves and branching Tier-3 unit/tower upgrade specializations.',
        implementationPrompt:
          'Read PROJECT.md and implement Boss Waves every 5 waves with a dedicated Boss HP bar and branching specialization upgrades.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      });
    }
    candidates.push({
      title: 'WebAudio Synthesizer SFX, Visual Juice & Persistent High-Score Leaderboard',
      rationale:
        'Adds zero-dependency WebAudio procedural sound effects, particle feedback, and persistent local statistics/achievements.',
      implementationPrompt:
        'Add a procedural WebAudio sound synthesizer (with Mute toggle), particle effects, and a persistent stats/achievements modal.',
      category: 'ui_ux',
      impact: 'high',
      effort: 'small',
      persona: 'ui_ux',
      preferredAgent: 'claude',
      preferredModel: 'opus',
      suggestedMilestoneCode: 'M3',
    });
  }

  // 8. Universal high-value engineering suggestions applicable to any software project
  candidates.push(
    {
      title: 'Responsive UX Polish, Keyboard Navigation & Empty/Error State Ergonomics',
      rationale:
        'Improves usability across desktop and mobile viewports with clear loading, empty, and error recovery states plus keyboard shortcuts.',
      implementationPrompt:
        'Read PROJECT.md and refine the user experience: improve visual hierarchy, keyboard navigation/shortcuts, responsive layout, and informative empty/error states.',
      category: 'ui_ux',
      impact: 'medium',
      effort: 'small',
      persona: 'ui_ux',
      preferredAgent: 'claude',
      preferredModel: 'opus',
      suggestedMilestoneCode: 'M3',
    },
    {
      title: 'State Export / Import (JSON Snapshot) & Diagnostics Summary View',
      rationale:
        'Lets users or administrators back up, restore, and inspect application configuration, records, and system health diagnostics.',
      implementationPrompt:
        'Implement JSON data/configuration export & import with schema validation and a diagnostics/metrics summary view.',
      category: 'feature',
      impact: 'medium',
      effort: 'small',
      persona: 'coder',
      preferredAgent: 'claude',
      preferredModel: 'opus',
      suggestedMilestoneCode: 'M2',
    },
    {
      title: 'End-to-End Automated Test Suite & Zero-Warning Build Hardening',
      rationale:
        'Verifies critical workflows automatically and ensures the compiler, linter, and build pipeline stay 100% clean.',
      implementationPrompt:
        'Audit the project for unhandled edge cases, compiler/lint warnings, or untested modules. Add comprehensive automated tests and verify the build pipeline succeeds cleanly.',
      category: 'qa_security',
      impact: 'high',
      effort: 'small',
      persona: 'qa',
      preferredAgent: 'claude',
      preferredModel: 'sonnet',
      suggestedMilestoneCode: 'M4',
    },
  );

  const notInRoadmap = candidates.filter((c) => !existingTitles.has(c.title.toLowerCase()));
  // Prioritize candidates that are NOT currently shown so clicking "Synthesize Ideas" rotates in fresh ideas
  const unseen = notInRoadmap.filter((c) => !currentSuggestionTitles.has(c.title.toLowerCase()));
  const alreadyShown = notInRoadmap.filter((c) => currentSuggestionTitles.has(c.title.toLowerCase()));
  const ordered = [...unseen, ...alreadyShown];

  return ordered.slice(0, 6).map((c) => {
    const route = defaultRoutingForPersona(c.persona, fSettings);
    return {
      ...c,
      preferredAgent: route.preferredAgent,
      preferredModel: route.preferredModel,
      id: `sug-${randomUUID().slice(0, 8)}`,
    };
  });
}

async function seedInitialRoadmap(
  project: Project,
  blueprintContent: string,
  projectTickets: Ticket[],
  fSettings?: FactorySettings,
): Promise<StoredRoadmapFile> {
  const now = new Date().toISOString();
  const milestones: RoadmapMilestone[] = [
    {
      id: 'ms-m1',
      code: 'M1',
      title: 'Foundation, Blueprint & System Architecture',
      description: 'Project specification (PROJECT.md), repository structure, build pipeline, and core contracts.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m2',
      code: 'M2',
      title: 'Core Domain, Services & Primary Workflows',
      description: 'Core business/system logic, data models, services, and primary functional workflows.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m3',
      code: 'M3',
      title: 'User Interface, API/CLI Surface & Experience',
      description: 'Web/Desktop UI views, forms, CLI/API ergonomics, reporting, and user experience polish.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m4',
      code: 'M4',
      title: 'QA Verification, Security & Release Readiness',
      description: 'Automated test suites, security hardening, performance optimization, and packaging.',
      status: 'planned',
      items: [],
    },
  ];

  // Map existing Kanban tickets into milestones so the roadmap immediately reflects real work
  for (const t of projectTickets) {
    const msIdx = milestoneIndexForPersona(t.persona);
    const ms = milestones[msIdx] ?? milestones[1]!;
    const routing = defaultRoutingForPersona(t.persona, fSettings);
    const itemStatus =
      t.status === 'done'
        ? 'done'
        : t.status === 'in_progress' || t.status === 'review'
          ? 'in_progress'
          : 'planned';
    ms.items.push({
      id: `item-${t.id.slice(0, 8)}`,
      milestoneId: ms.id,
      title: t.title,
      description: t.body || t.title,
      category: categoryForPersona(t.persona),
      persona: t.persona,
      preferredAgent: routing.preferredAgent,
      preferredModel: routing.preferredModel,
      priority: t.priority,
      status: itemStatus,
      ticketId: t.id,
      ticketKey: t.key,
      createdAt: t.createdAt,
    });
  }

  const existingTitles = new Set(
    milestones.flatMap((m) => m.items.map((i) => i.title.toLowerCase())),
  );
  const suggestions = await synthesizeBrainstormSuggestions(
    project,
    blueprintContent,
    existingTitles,
    '',
    new Set(),
    fSettings,
  );

  return {
    visionSummary: extractVisionFromBlueprint(project, blueprintContent),
    milestones,
    suggestions,
    updatedAt: now,
  };
}

async function readOrInitRoadmapFile(
  project: Project,
  ticketService: TicketService,
): Promise<StoredRoadmapFile> {
  const filePath = path.join(project.path, ROADMAP_REL_PATH);
  const blueprint = await readProjectBlueprint(project);
  const projectTickets = ticketService.list(project.id);
  const fSettings = ticketService.factorySettings();

  let stored: StoredRoadmapFile | null = null;
  let dirty = false;
  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf8');
      stored = JSON.parse(raw) as StoredRoadmapFile;
    } catch {
      stored = null;
    }
  }

  if (!stored || !Array.isArray(stored.milestones) || stored.milestones.length === 0) {
    stored = await seedInitialRoadmap(project, blueprint.content, projectTickets, fSettings);
    dirty = true;
  }

  // Normalize any uncustomized suggestion/item routes that still point to an unconfigured secondary agent
  // (e.g., `antigravity · argon` when the user's Settings route for that persona is `claude`).
  for (const sug of stored.suggestions ?? []) {
    const customFlag = (sug as BrainstormSuggestion & { routeCustomized?: boolean }).routeCustomized;
    const configuredRoute = defaultRoutingForPersona(sug.persona, fSettings);
    if (
      !customFlag &&
      sug.preferredAgent === 'antigravity' &&
      configuredRoute.preferredAgent !== 'antigravity'
    ) {
      sug.preferredAgent = configuredRoute.preferredAgent;
      sug.preferredModel = configuredRoute.preferredModel;
      dirty = true;
    }
  }
  for (const ms of stored.milestones) {
    for (const item of ms.items) {
      const customFlag = (item as RoadmapItem & { routeCustomized?: boolean }).routeCustomized;
      const configuredRoute = defaultRoutingForPersona(item.persona, fSettings);
      if (
        !customFlag &&
        !item.ticketId &&
        item.preferredAgent === 'antigravity' &&
        configuredRoute.preferredAgent !== 'antigravity'
      ) {
        item.preferredAgent = configuredRoute.preferredAgent;
        item.preferredModel = configuredRoute.preferredModel;
        dirty = true;
      }
    }
  }

  // Check if an AI agent wrote `.emberline/brainstorm-suggestions.json`
  const agentBrainstormPath = path.join(project.path, BRAINSTORM_OUT_REL_PATH);
  if (existsSync(agentBrainstormPath)) {
    try {
      const raw = await readFile(agentBrainstormPath, 'utf8');
      const parsed = JSON.parse(raw) as { suggestions?: Array<Partial<BrainstormSuggestion>> };
      if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
        const existingSuggestionTitles = new Set(stored.suggestions.map((s) => s.title.toLowerCase()));
        for (const s of parsed.suggestions) {
          if (!s.title || existingSuggestionTitles.has(s.title.toLowerCase())) continue;
          const persona: AgentPersona = s.persona ?? 'coder';
          const routing = defaultRoutingForPersona(persona, fSettings);
          const requestedAgent = s.preferredAgent ?? routing.preferredAgent;
          const useConfigured =
            requestedAgent === 'antigravity' && routing.preferredAgent !== 'antigravity';
          stored.suggestions.unshift({
            id: `sug-${randomUUID().slice(0, 8)}`,
            title: s.title,
            rationale: s.rationale ?? 'Suggested by AI Brainstorming Agent.',
            implementationPrompt: s.implementationPrompt ?? s.rationale ?? s.title,
            category: s.category ?? categoryForPersona(persona),
            impact: s.impact ?? 'high',
            effort: s.effort ?? 'medium',
            persona,
            preferredAgent: useConfigured ? routing.preferredAgent : requestedAgent,
            preferredModel: useConfigured ? routing.preferredModel : (s.preferredModel ?? routing.preferredModel),
            suggestedMilestoneCode: s.suggestedMilestoneCode ?? 'M2',
          });
          existingSuggestionTitles.add(s.title.toLowerCase());
          dirty = true;
        }
      }
      await rm(agentBrainstormPath, { force: true });
    } catch {
      // Ignore malformed agent output
    }
  }

  // Sync ticket statuses & auto-import any new tickets created outside the roadmap
  const ticketById = new Map(projectTickets.map((t) => [t.id, t]));
  const linkedTicketIds = new Set<string>();

  for (const ms of stored.milestones) {
    // Strip any accidental brainstorm meta-tickets that may have been imported earlier
    const beforeLen = ms.items.length;
    ms.items = ms.items.filter(
      (i) =>
        !i.title.startsWith('[Factory] Brainstorm & Roadmap Expansion') &&
        !i.title.startsWith('[Brainstorm]'),
    );
    if (ms.items.length !== beforeLen) dirty = true;
    for (const item of ms.items) {
      if (item.ticketId) {
        linkedTicketIds.add(item.ticketId);
        const t = ticketById.get(item.ticketId);
        if (t) {
          if (item.ticketKey !== t.key) {
            item.ticketKey = t.key;
            dirty = true;
          }
          const targetStatus =
            t.status === 'done'
              ? 'done'
              : t.status === 'in_progress' || t.status === 'review'
                ? 'in_progress'
                : item.status === 'done'
                  ? 'planned'
                  : item.status;
          if (item.status !== targetStatus) {
            item.status = targetStatus;
            dirty = true;
          }
        }
      }
    }
  }

  // Import any Kanban tickets not yet represented in the roadmap (excluding brainstorm meta-tickets)
  for (const t of projectTickets) {
    if (linkedTicketIds.has(t.id)) continue;
    if (
      t.title.startsWith('[Factory] Brainstorm & Roadmap Expansion') ||
      t.title.startsWith('[Brainstorm]')
    ) {
      continue;
    }
    const msIdx = milestoneIndexForPersona(t.persona);
    const ms = stored.milestones[msIdx] ?? stored.milestones[0];
    if (!ms) continue;
    const routing = defaultRoutingForPersona(t.persona, fSettings);
    const routeTagMatch = /\[Preferred Agent:\s*([a-z0-9_-]+)\s*·\s*Model:\s*([a-z0-9_-]+)\]/i.exec(
      t.body ?? '',
    );
    ms.items.push({
      id: `item-${t.id.slice(0, 8)}`,
      milestoneId: ms.id,
      title: t.title,
      description: t.body || t.title,
      category: categoryForPersona(t.persona),
      persona: t.persona,
      preferredAgent: (routeTagMatch?.[1] as AgentId | undefined) ?? routing.preferredAgent,
      preferredModel: (routeTagMatch?.[2] as AgentModelId | undefined) ?? routing.preferredModel,
      priority: t.priority,
      status:
        t.status === 'done'
          ? 'done'
          : t.status === 'in_progress' || t.status === 'review'
            ? 'in_progress'
            : 'planned',
      ticketId: t.id,
      ticketKey: t.key,
      createdAt: t.createdAt,
    });
    dirty = true;
  }

  // Update each milestone's derived status
  for (const ms of stored.milestones) {
    let nextMsStatus: RoadmapMilestone['status'] = 'planned';
    if (ms.items.length === 0) {
      nextMsStatus = 'planned';
    } else if (ms.items.every((i) => i.status === 'done')) {
      nextMsStatus = 'completed';
    } else if (ms.items.some((i) => i.status === 'in_progress' || i.status === 'done')) {
      nextMsStatus = 'active';
    }
    if (ms.status !== nextMsStatus) {
      ms.status = nextMsStatus;
      dirty = true;
    }
  }

  if (!stored.visionSummary) {
    stored.visionSummary = extractVisionFromBlueprint(project, blueprint.content);
    dirty = true;
  }

  if (dirty) {
    await saveRoadmapFile(project, stored);
  }
  return stored;
}

async function saveRoadmapFile(project: Project, data: StoredRoadmapFile): Promise<void> {
  const filePath = path.join(project.path, ROADMAP_REL_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  data.updatedAt = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function toRoadmapState(project: Project, stored: StoredRoadmapFile): ProjectRoadmapState {
  const allItems = stored.milestones.flatMap((m) => m.items);
  const totalItems = allItems.length;
  const completedItems = allItems.filter((i) => i.status === 'done').length;
  const completionPercent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  return {
    projectId: project.id,
    visionSummary: stored.visionSummary ?? project.description ?? '',
    totalItems,
    completedItems,
    completionPercent,
    milestones: stored.milestones,
    suggestions: stored.suggestions ?? [],
    updatedAt: stored.updatedAt,
  };
}

export async function getProjectRoadmap(
  project: Project,
  ticketService: TicketService,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  return toRoadmapState(project, stored);
}

export async function addRoadmapMilestone(
  project: Project,
  ticketService: TicketService,
  input: CreateMilestoneBody,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const nextIndex = stored.milestones.length + 1;
  const code = input.code?.trim() || `M${nextIndex}`;
  stored.milestones.push({
    id: `ms-${randomUUID().slice(0, 8)}`,
    code,
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    status: 'planned',
    items: [],
  });
  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function addRoadmapItem(
  project: Project,
  ticketService: TicketService,
  input: CreateRoadmapItemBody,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const targetMs =
    stored.milestones.find((m) => m.id === input.milestoneId || m.code === input.milestoneId) ??
    stored.milestones[0];
  if (!targetMs) {
    throw new Error('No milestone found in project roadmap');
  }

  const fSettings = ticketService.factorySettings();
  const persona = input.persona ?? 'coder';
  const routing = defaultRoutingForPersona(persona, fSettings);
  const newItem: RoadmapItem & { routeCustomized?: boolean } = {
    id: `item-${randomUUID().slice(0, 8)}`,
    milestoneId: targetMs.id,
    title: input.title.trim(),
    description: input.description?.trim() || input.title.trim(),
    category: input.category ?? categoryForPersona(persona),
    persona,
    preferredAgent: input.preferredAgent ?? routing.preferredAgent,
    preferredModel:
      input.preferredModel && input.preferredModel !== 'auto'
        ? input.preferredModel
        : routing.preferredModel,
    priority: input.priority ?? 2,
    status: input.status ?? 'planned',
    ticketId: null,
    ticketKey: null,
    createdAt: new Date().toISOString(),
    routeCustomized: Boolean(input.preferredAgent || input.preferredModel),
  };

  targetMs.items.push(newItem);
  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function updateRoadmapItem(
  project: Project,
  ticketService: TicketService,
  itemId: string,
  patch: UpdateRoadmapItemBody,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);

  // 1. Check if itemId refers to a Brainstorm Suggestion (`sug-*`) so users can customize routes on suggestions too!
  const sug = stored.suggestions.find((s) => s.id === itemId) as
    | (BrainstormSuggestion & { routeCustomized?: boolean })
    | undefined;
  if (sug) {
    if (patch.title !== undefined) sug.title = patch.title.trim();
    if (patch.description !== undefined) sug.rationale = patch.description.trim();
    if (patch.category !== undefined) sug.category = patch.category;
    if (patch.persona !== undefined) sug.persona = patch.persona;
    if (patch.preferredAgent !== undefined) {
      sug.preferredAgent = patch.preferredAgent;
      sug.routeCustomized = true;
    }
    if (patch.preferredModel !== undefined) {
      sug.preferredModel = patch.preferredModel;
      sug.routeCustomized = true;
    }
    if (patch.milestoneId !== undefined) {
      sug.suggestedMilestoneCode = patch.milestoneId;
    }
    await saveRoadmapFile(project, stored);
    return toRoadmapState(project, stored);
  }

  // 2. Otherwise update a Milestone RoadmapItem (`item-*`)
  let found: (RoadmapItem & { routeCustomized?: boolean }) | undefined;
  let sourceMs: RoadmapMilestone | undefined;

  for (const ms of stored.milestones) {
    const idx = ms.items.findIndex((i) => i.id === itemId);
    if (idx !== -1) {
      found = ms.items[idx] as RoadmapItem & { routeCustomized?: boolean };
      sourceMs = ms;
      break;
    }
  }
  if (!found || !sourceMs) {
    throw new Error('Roadmap item not found');
  }

  if (patch.title !== undefined) found.title = patch.title.trim();
  if (patch.description !== undefined) found.description = patch.description.trim();
  if (patch.category !== undefined) found.category = patch.category;
  if (patch.persona !== undefined) found.persona = patch.persona;
  if (patch.preferredAgent !== undefined) {
    found.preferredAgent = patch.preferredAgent;
    found.routeCustomized = true;
  }
  if (patch.preferredModel !== undefined) {
    found.preferredModel = patch.preferredModel;
    found.routeCustomized = true;
  }
  if (patch.priority !== undefined) found.priority = patch.priority;

  // Sync updated route or persona to the linked Kanban ticket if one exists
  if (
    found.ticketId &&
    (patch.preferredAgent !== undefined || patch.preferredModel !== undefined || patch.persona !== undefined)
  ) {
    try {
      const existingTicket = ticketService.get(found.ticketId);
      const cleanBody = existingTicket.body
        .replace(/\n*\[Preferred Agent:\s*[a-z0-9_-]+\s*·\s*Model:\s*[a-z0-9_-]+\]/gi, '')
        .trim();
      const updatedBody = `${cleanBody}\n\n[Preferred Agent: ${found.preferredAgent} · Model: ${found.preferredModel}]`.trim();
      ticketService.update(found.ticketId, {
        persona: found.persona,
        body: updatedBody,
      });
    } catch {
      // Ignore if ticket was deleted
    }
  }

  if (patch.status !== undefined) {
    found.status = patch.status;
    if (found.ticketId) {
      try {
        if (patch.status === 'done') {
          ticketService.update(found.ticketId, { status: 'done' });
        } else if (patch.status === 'planned') {
          ticketService.update(found.ticketId, { status: 'ready' });
        }
      } catch {
        // Ignore if linked ticket was removed
      }
    }
  }

  if (patch.milestoneId && patch.milestoneId !== sourceMs.id) {
    const destMs = stored.milestones.find(
      (m) => m.id === patch.milestoneId || m.code === patch.milestoneId,
    );
    if (destMs) {
      sourceMs.items = sourceMs.items.filter((i) => i.id !== itemId);
      found.milestoneId = destMs.id;
      destMs.items.push(found);
    }
  }

  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function deleteRoadmapItem(
  project: Project,
  ticketService: TicketService,
  itemId: string,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  for (const ms of stored.milestones) {
    ms.items = ms.items.filter((i) => i.id !== itemId);
  }
  // Also allow dismissing a suggestion by ID
  stored.suggestions = stored.suggestions.filter((s) => s.id !== itemId);
  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function runProjectBrainstorm(
  project: Project,
  ticketService: TicketService,
  input: BrainstormRequestBody,
): Promise<BrainstormResponse> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const blueprint = await readProjectBlueprint(project);
  const fSettings = ticketService.factorySettings();
  const existingTitles = new Set(
    stored.milestones.flatMap((m) => m.items.map((i) => i.title.toLowerCase())),
  );
  const currentSuggestionTitles = new Set(stored.suggestions.map((s) => s.title.toLowerCase()));

  const freshSuggestions = await synthesizeBrainstormSuggestions(
    project,
    blueprint.content,
    existingTitles,
    input.focus ?? '',
    currentSuggestionTitles,
    fSettings,
  );

  // Merge fresh suggestions at the top while deduplicating by title
  const seen = new Set<string>();
  const merged: BrainstormSuggestion[] = [];
  for (const s of [...freshSuggestions, ...stored.suggestions]) {
    const key = s.title.toLowerCase();
    if (seen.has(key) || existingTitles.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  stored.suggestions = merged.slice(0, 8);
  await saveRoadmapFile(project, stored);

  let agentRun = null;
  if (input.mode === 'agent') {
    const focusClause = input.focus?.trim()
      ? `Focus especially on: "${input.focus.trim()}".`
      : 'Cover high-impact gameplay/product features, UI/UX polish, architecture, and QA.';
    const prompt = [
      `Brainstorm & Roadmap Ideation for **${project.name}** (Read-Only Analysis + JSON Output):`,
      `${focusClause}`,
      `1. Read PROJECT.md and inspect the codebase structure.`,
      `2. Write 4 to 6 creative, concrete, high-value feature suggestions to \`${project.path}/.emberline/brainstorm-suggestions.json\` with the exact JSON format:`,
      `{"suggestions": [{"title": "...", "rationale": "Why this makes the project great", "implementationPrompt": "Detailed instructions for the coding agent", "category": "feature|ui_ux|architecture|performance|qa_security", "impact": "high|medium", "effort": "small|medium|large", "persona": "coder|ui_ux|architect|dba|qa|security", "preferredAgent": "claude", "preferredModel": "fable|opus|sonnet", "suggestedMilestoneCode": "M2|M3|M4"}]}`,
      `3. IMPORTANT: Do NOT create or modify \`.emberline/new-tickets.json\` and do NOT start implementation changes. Only write \`${project.path}/.emberline/brainstorm-suggestions.json\` so the user can review and select suggestions in the Roadmap Studio.`,
    ].join('\n');

    agentRun = await ticketService.startBrainstormRun(project.id, {
      prompt,
      persona: input.leadPersona ?? 'product_owner',
    });
  }

  return {
    roadmap: toRoadmapState(project, stored),
    agentRun,
  };
}

export async function dispatchRoadmapItems(
  project: Project,
  ticketService: TicketService,
  input: DispatchRoadmapItemsBody,
): Promise<DispatchRoadmapItemsResponse> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const itemIdsToDispatch = new Set(input.itemIds ?? []);
  const suggestionIds = new Set(input.suggestionIds ?? []);

  // 1. If suggestions were selected, promote them into their suggested (or target) milestone first
  if (suggestionIds.size > 0) {
    const remainingSuggestions: BrainstormSuggestion[] = [];
    for (const sug of stored.suggestions) {
      if (!suggestionIds.has(sug.id)) {
        remainingSuggestions.push(sug);
        continue;
      }
      const targetMs =
        (input.targetMilestoneId
          ? stored.milestones.find(
              (m) => m.id === input.targetMilestoneId || m.code === input.targetMilestoneId,
            )
          : undefined) ??
        stored.milestones.find((m) => m.code === sug.suggestedMilestoneCode) ??
        stored.milestones[1] ??
        stored.milestones[0];

      if (targetMs) {
        const newItemId = `item-${randomUUID().slice(0, 8)}`;
        targetMs.items.push({
          id: newItemId,
          milestoneId: targetMs.id,
          title: sug.title,
          description: `${sug.rationale}\n\n---\nImplementation Spec:\n${sug.implementationPrompt}`,
          category: sug.category,
          persona: sug.persona,
          preferredAgent: sug.preferredAgent,
          preferredModel: sug.preferredModel,
          priority: sug.impact === 'high' ? 3 : sug.impact === 'medium' ? 2 : 1,
          status: 'planned',
          ticketId: null,
          ticketKey: null,
          createdAt: new Date().toISOString(),
        });
        itemIdsToDispatch.add(newItemId);
      }
    }
    stored.suggestions = remainingSuggestions;
  }

  // 2. Create Kanban tickets for all selected roadmap items that don't have a ticket yet
  const createdTickets: Ticket[] = [];
  for (const ms of stored.milestones) {
    for (const item of ms.items) {
      if (!itemIdsToDispatch.has(item.id)) continue;
      if (item.ticketId && ticketService.get(item.ticketId)) {
        // Ensure existing ticket is at least 'ready' if it was in 'backlog'
        const existing = ticketService.get(item.ticketId)!;
        if (existing.status === 'backlog') {
          await ticketService.update(existing.id, { status: 'ready' });
        }
        continue;
      }
      const routeTag = `[Preferred Agent: ${item.preferredAgent} · Model: ${item.preferredModel}]`;
      const ticket = ticketService.create(project.id, {
        title: item.title,
        body: `${item.description}\n\n${routeTag}`,
        status: 'ready',
        priority: item.priority,
        persona: item.persona,
      });
      item.ticketId = ticket.id;
      item.ticketKey = ticket.key;
      item.status = 'planned';
      createdTickets.push(ticket);
    }
  }

  await saveRoadmapFile(project, stored);

  // 3. Optionally trigger the autonomous pipeline so agents immediately start executing the tickets
  let startedRun = null;
  if (input.autoStart && (createdTickets.length > 0 || itemIdsToDispatch.size > 0)) {
    ticketService.setAutoChain(project.id, true);
    const dispatched = await ticketService.dispatchNextReadyTicket(project.id);
    startedRun = dispatched?.run ?? null;
  }

  const finalStored = await readOrInitRoadmapFile(project, ticketService);
  return {
    roadmap: toRoadmapState(project, finalStored),
    createdTickets,
    startedRun,
  };
}

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  type AutoGenerateRoadmapBody,
  type AutoGenerateRoadmapResponse,
  type BrainstormRequestBody,
  type BrainstormResponse,
  type BrainstormSuggestion,
  coerceModelForProvider,
  type CreateMilestoneBody,
  type CreateRoadmapItemBody,
  type DispatchRoadmapItemsBody,
  type DispatchRoadmapItemsResponse,
  type FactorySettings,
  type Project,
  type ProjectRoadmapState,
  type RoadmapCategory,
  type RoadmapItem,
  type RoadmapMilestone,
  type Ticket,
  type UpdateRoadmapItemBody,
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
const ROADMAP_GEN_OUT_REL_PATH = '.emberline/roadmap-generated.json';

function defaultRoutingForPersona(
  persona: AgentPersona,
  fSettings?: FactorySettings,
): {
  preferredAgent: AgentId;
  preferredModel: AgentModelId;
} {
  if (fSettings) {
    const enabled: AgentId[] = fSettings.enabledProviders?.length
      ? fSettings.enabledProviders
      : ['claude'];
    const rawAgent = fSettings.personaAgents[persona] ?? fSettings.defaultAgent ?? 'claude';
    const preferredAgent: AgentId = enabled.includes(rawAgent)
      ? rawAgent
      : (enabled[0] ?? 'claude');
    const rawModel =
      fSettings.personaModels?.[persona] ??
      (persona === 'product_owner' || persona === 'architect'
        ? 'fable'
        : persona === 'qa'
          ? 'sonnet'
          : 'opus');
    const preferredModel = coerceModelForProvider(preferredAgent, rawModel, persona);
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

export function inferPersonaAndCategoryFromText(text: string): {
  persona: AgentPersona;
  category: RoadmapCategory;
  priority: 1 | 2 | 3;
} {
  const lower = text.toLowerCase();
  const priority: 1 | 2 | 3 = /\b(urgent|critical|core|blocker|security|crash)\b/.test(lower)
    ? 3
    : 2;

  if (
    /\b(test|qa|e2e|playwright|vitest|pytest|regression|coverage|assertion|verify)\b/.test(
      lower,
    )
  ) {
    return { persona: 'qa', category: 'qa_security', priority };
  }
  if (
    /\b(security|auth|oauth|jwt|rbac|permission|csrf|xss|encryption|audit|checksum|sha256)\b/.test(
      lower,
    )
  ) {
    return { persona: 'security', category: 'qa_security', priority: 3 };
  }
  if (
    /\b(database|sql|sqlite|postgres|schema|migration|query|table|drizzle|prisma|redis)\b/.test(
      lower,
    )
  ) {
    return { persona: 'dba', category: 'architecture', priority };
  }
  if (
    /\b(ui|ux|css|layout|theme|dark mode|responsive|modal|animation|canvas|hud|menu|screen|widget|design|polish)\b/.test(
      lower,
    )
  ) {
    return { persona: 'ui_ux', category: 'ui_ux', priority };
  }
  if (
    /\b(architecture|blueprint|refactor|protocol|contract|openapi|pipeline|dag|router|orchestrator|sdk)\b/.test(
      lower,
    )
  ) {
    return { persona: 'architect', category: 'architecture', priority };
  }
  if (/\b(performance|optimize|fps|latency|memory|cache|speed)\b/.test(lower)) {
    return { persona: 'coder', category: 'performance', priority };
  }
  return { persona: 'coder', category: 'feature', priority };
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

const LEGACY_STATIC_SUGGESTION_TITLES = new Set([
  'hardware bus scanner (i2c/spi/uart), address probing & crc/ack verification',
  'safe eeprom / chip register dump, hex backup & read-after-write verification',
  'interactive serial / web-serial diagnostic console & status led patterns',
  'pre-flight os/kernel compatibility check & non-destructive dry-run mode (--dry-run)',
  'atomic backup snapshot, checksum verification & automatic rollback on failure',
  'structured cli flags, ansi progress telemetry & unattended cron/init hook',
  'multi-monitor window positioning, always-on-top overlay & display geometry manager',
  'system tray controller, global keyboard shortcuts & live preset switcher',
  'cross-platform packaging, crash-safe config store & hardware-accelerated rendering',
  'capability-based multi-agent router, model tier fallback & token cost ledger',
  'dag task pipeline executor, shared context memory & tool call inspector',
  'multi-step form workflow, strict schema validation & draft auto-save',
  'role-based access control (rbac), approval status pipeline & audit trail',
  'interactive data grid, advanced multi-filter search & csv/pdf report export',
  'openapi / swagger interactive documentation & strict boundary validation',
  'database indexing, migration safety & query performance optimization',
  'rate limiting, structured audit logging & security hardening',
  'power-up collectibles (shield bubble, coin magnet, slow-mo & score 2x)',
  'unlockable skins, particle trails & customization shop modal',
  'boss waves, elite modifiers & branching specialization tech tree',
  'webaudio synthesizer sfx, visual juice & persistent high-score leaderboard',
  'responsive ux polish, keyboard navigation & empty/error state ergonomics',
  'state export / import (json snapshot) & diagnostics summary view',
  'end-to-end automated test suite & zero-warning build hardening',
  'dynamic day/night weather & parallax biome transitions',
  'daily challenge seed mode & ghost run comparison',
  'combo multiplier, near-miss bonus & Fever mode',
  'achievement badges, stats dashboard & milestone toasts',
  'interactive mini-map, wave preview & range indicators',
  'replay ghost recorder & shareable run summary card',
  'haptic screen-shake, floating combat/score text & juice settings',
  'accessibility suite: high-contrast palette, keybind remapper & speed control',
  'interactive tutorial overlay, help modal & keyboard shortcut bar',
  'performance telemetry overlay (fps / frame-time graph) & object pooling',
]);

type PrimaryDomain =
  | 'game_interactive'
  | 'embedded_iot'
  | 'cli_tool'
  | 'mobile_desktop'
  | 'ai_agents'
  | 'api_service'
  | 'fullstack';

function detectPrimaryProjectDomain(
  project: Project,
  blueprintContent: string,
  fileNamesLower: string,
): PrimaryDomain {
  const appType = project.appType;
  if (
    appType === 'game_interactive' ||
    appType === 'embedded_iot' ||
    appType === 'cli_tool' ||
    appType === 'mobile_desktop' ||
    appType === 'ai_agents' ||
    appType === 'api_service'
  ) {
    return appType;
  }
  if (appType === 'library') {
    return 'api_service';
  }

  // Inspect only the project name, description, and top heading of PROJECT.md with strict word boundaries
  const headerSnippet = `${project.name} ${project.description ?? ''} ${blueprintContent.slice(0, 600)}`.toLowerCase();

  if (/\b(flappy|arcade|endless-runner|tower-defense|phaser|pixi|game|gameplay)\b/.test(headerSnippet)) {
    return 'game_interactive';
  }
  if (
    /\b(esp32|esp8266|arduino|platformio|stm32|firmware|eeprom|i2c|uart|microcontroller)\b/.test(headerSnippet) ||
    /\bplatformio\.ini\b|\.ino\b/.test(fileNamesLower)
  ) {
    return 'embedded_iot';
  }
  if (/\b(driver-updater|kernel|zfs|systemd|cli-tool|shell-tool)\b/.test(headerSnippet)) {
    return 'cli_tool';
  }
  if (/\b(tauri|electron|flutter|react-native|qt|desktop-app|mobile-app)\b/.test(headerSnippet)) {
    return 'mobile_desktop';
  }
  if (/\b(multi-agent|agentic|mcp-server|llm-orchestrator)\b/.test(headerSnippet)) {
    return 'ai_agents';
  }
  if (/\b(fastapi|microservice|grpc|rest-api)\b/.test(headerSnippet)) {
    return 'api_service';
  }
  return 'fullstack';
}

/**
 * Generates codebase-aware, domain-intelligent brainstorming suggestions when explicitly requested
 * by the user via Instant Synthesize (`mode === 'instant'`).
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
  const domain = detectPrimaryProjectDomain(project, blueprintContent, fileNamesLower);

  const candidates: Array<Omit<BrainstormSuggestion, 'id'>> = [];

  // 0. If user typed a specific focus query, generate 3 tailored suggestions for that exact topic
  if (focus.trim()) {
    const cleanFocus = focus.trim();
    candidates.push(
      {
        title: `Core Implementation: ${cleanFocus.slice(0, 72)}`,
        rationale: `Implements "${cleanFocus}" in ${project.name} following the existing architecture in PROJECT.md.`,
        implementationPrompt: `Read PROJECT.md and inspect the codebase structure of ${project.name}. Design and implement the following capability end-to-end: "${cleanFocus}". Maintain clean module boundaries and verify the project's build/test pipeline when finished.`,
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `UI/UX & Interaction Polish: ${cleanFocus.slice(0, 64)}`,
        rationale: `Delivers a clean, responsive user interface and interaction flow for "${cleanFocus}".`,
        implementationPrompt: `Read PROJECT.md and implement the user-facing interface, visual feedback, and ergonomics for: "${cleanFocus}". Verify the build passes cleanly.`,
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: `Automated Verification & Edge-Case Tests: ${cleanFocus.slice(0, 56)}`,
        rationale: `Verifies "${cleanFocus}" with automated tests and build checks.`,
        implementationPrompt: `Verify the implementation of "${cleanFocus}" in ${project.name}. Add automated tests covering happy paths and edge cases, and run the project's build/test suite to confirm zero regressions.`,
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

  // 1. Extract any unchecked markdown checklist items (`- [ ] ...`) directly from PROJECT.md
  const uncheckedRegex = /^[\t ]*[-*]\s+\[\s\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = uncheckedRegex.exec(blueprintContent)) !== null) {
    const rawLine = (match[1] ?? '').replace(/\*\*/g, '').trim();
    if (rawLine.length < 8 || rawLine.length > 140) continue;
    candidates.push({
      title: rawLine.slice(0, 96),
      rationale: `Uncompleted specification item extracted directly from ${project.name}'s PROJECT.md blueprint.`,
      implementationPrompt: `Read PROJECT.md and implement this pending specification item in ${project.name}: "${rawLine}". Mark it completed when verified.`,
      category: 'feature',
      impact: 'high',
      effort: 'medium',
      persona: 'coder',
      preferredAgent: 'claude',
      preferredModel: 'opus',
      suggestedMilestoneCode: 'M2',
    });
    if (candidates.length >= 8) break;
  }

  // 2. Domain-specific suggestions strictly for the single detected primary domain
  if (domain === 'embedded_iot') {
    candidates.push(
      {
        title: `Bus Protocol Handshake & CRC Verification for ${project.name}`,
        rationale:
          'Validates connected hardware bus addresses, device signatures, and ACK/CRC framing before register writes.',
        implementationPrompt:
          'Read PROJECT.md and implement hardware bus address probing, device ID validation, timeout retries, and CRC/ACK checks.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: `Safe Register/EEPROM Backup Dump & Read-After-Write Verification`,
        rationale:
          'Backs up original register/EEPROM bytes first, writes in page-aligned chunks, and verifies byte-for-byte.',
        implementationPrompt:
          'Implement a Read -> Backup Dump -> Write -> Verify state machine with hex dump output and automatic abort on mismatch.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
    );
  } else if (domain === 'cli_tool') {
    candidates.push(
      {
        title: `Pre-Flight System Check & Non-Destructive Dry-Run Mode (--dry-run)`,
        rationale:
          'Validates environment prerequisites before mutating system state and previews commands via --dry-run.',
        implementationPrompt:
          'Read PROJECT.md and implement pre-flight environment checks and a --dry-run mode that logs planned operations without mutating state.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: `SHA256 Checksum Verification & Automatic Rollback on Failure`,
        rationale:
          'Backs up current state, verifies checksums, and rolls back automatically if post-install validation fails.',
        implementationPrompt:
          'Implement SHA256 checksum verification, pre-update backup, post-install health check, and automatic rollback on failure.',
        category: 'qa_security',
        impact: 'high',
        effort: 'medium',
        persona: 'security',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M4',
      },
    );
  } else if (domain === 'mobile_desktop') {
    candidates.push(
      {
        title: `Multi-Display Window Geometry & Persistent Profile Manager`,
        rationale:
          'Saves window bounds, display selection, always-on-top state, and user presets in local configuration.',
        implementationPrompt:
          'Read PROJECT.md and implement window geometry persistence, display positioning controls, and saved user presets.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `System Tray Controls, Global Hotkeys & Smooth Rendering Optimization`,
        rationale:
          'Provides quick tray/shortcut access and minimizes CPU/GPU usage during continuous rendering.',
        implementationPrompt:
          'Implement system tray controls, keyboard shortcuts, and frame-pacing optimization.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
    );
  } else if (domain === 'ai_agents') {
    candidates.push(
      {
        title: `Capability-Based Multi-Agent Router & Token Telemetry Ledger`,
        rationale:
          'Routes tasks across specialized agents/models with automatic fallback and per-run token accounting.',
        implementationPrompt:
          'Read PROJECT.md and implement a capability-based agent router with fallback handling and token/cost telemetry.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: `Live Agent Execution Timeline & Structured Handoff Inspector`,
        rationale:
          'Visualizes multi-step agent handoffs, tool calls, and intermediate artifacts in real time.',
        implementationPrompt:
          'Implement a real-time execution timeline and structured handoff inspector for agent runs.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
    );
  } else if (domain === 'game_interactive') {
    candidates.push(
      {
        title: `New Interactive Mechanics, Power-Ups & Progression Loop for ${project.name}`,
        rationale:
          'Expands core replayability with collectible power-ups, dynamic difficulty scaling, and milestone rewards.',
        implementationPrompt:
          `Read PROJECT.md and inspect ${project.name}. Implement collectible power-ups, smooth difficulty progression, and visual HUD indicators.`,
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `Visual Polish, Smooth Animations & Audio Feedback for ${project.name}`,
        rationale:
          'Enhances visual responsiveness, particle feedback, and sound/haptic polish across all screens.',
        implementationPrompt:
          `Read PROJECT.md and refine the visual animations, transitions, and sound/particle feedback in ${project.name}.`,
        category: 'ui_ux',
        impact: 'high',
        effort: 'small',
        persona: 'ui_ux',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: `Mobile/Desktop Viewport Responsiveness & Automated QA Check for ${project.name}`,
        rationale:
          'Ensures crisp scaling across mobile and desktop aspect ratios and verifies zero console errors.',
        implementationPrompt:
          `Verify responsive scaling, touch/keyboard input handling, and zero runtime errors across ${project.name}.`,
        category: 'qa_security',
        impact: 'high',
        effort: 'small',
        persona: 'qa',
        preferredAgent: 'claude',
        preferredModel: 'sonnet',
        suggestedMilestoneCode: 'M4',
      },
    );
  } else if (domain === 'api_service') {
    candidates.push(
      {
        title: `Schema Validation, OpenAPI Contracts & Health Diagnostics for ${project.name}`,
        rationale:
          'Provides strict request/response schema validation, standardized error envelopes, and health endpoints.',
        implementationPrompt:
          `Read PROJECT.md and add strict request/response validation, standardized error handling, and API documentation for ${project.name}.`,
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: `Integration Test Suite, Rate Limiting & Query Optimization`,
        rationale:
          'Verifies all service endpoints under load and hardens security and database performance.',
        implementationPrompt:
          `Implement integration tests, rate limiting, and query optimizations for ${project.name}.`,
        category: 'qa_security',
        impact: 'high',
        effort: 'small',
        persona: 'qa',
        preferredAgent: 'claude',
        preferredModel: 'sonnet',
        suggestedMilestoneCode: 'M4',
      },
    );
  } else {
    // fullstack / web_saas / portal / forms
    candidates.push(
      {
        title: `Workflow Validation, Status Pipeline & Data Export for ${project.name}`,
        rationale:
          'Strengthens core user workflows with strict form/input validation, status tracking, and CSV/JSON export.',
        implementationPrompt:
          `Read PROJECT.md and implement end-to-end workflow validation, status transitions, and data export for ${project.name}.`,
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `Responsive Dashboard UX, Filtering & Error Boundary Polish for ${project.name}`,
        rationale:
          'Improves layout responsiveness, search/filter ergonomics, and loading/error states across all views.',
        implementationPrompt:
          `Read PROJECT.md and enhance the UI layout, filtering controls, and responsive states in ${project.name}.`,
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

  const notInRoadmap = candidates.filter((c) => !existingTitles.has(c.title.toLowerCase()));
  const unseen = notInRoadmap.filter((c) => !currentSuggestionTitles.has(c.title.toLowerCase()));
  const alreadyShown = notInRoadmap.filter((c) => currentSuggestionTitles.has(c.title.toLowerCase()));
  const ordered = [...unseen, ...alreadyShown];

  return ordered.slice(0, 5).map((c) => {
    const route = defaultRoutingForPersona(c.persona, fSettings);
    return {
      ...c,
      preferredAgent: route.preferredAgent,
      preferredModel: route.preferredModel,
      id: `sug-${randomUUID().slice(0, 8)}`,
    };
  });
}

const GENERIC_LEGACY_MS_TITLES = new Set([
  'foundation, blueprint & system architecture',
  'core domain, services & primary workflows',
  'user interface, api/cli surface & experience',
  'qa verification, security & release readiness',
]);

function buildDomainMilestones(
  project: Project,
  blueprintContent: string,
  fileNamesLower = '',
): Array<{ id: string; code: string; title: string; description: string }> {
  const domain = detectPrimaryProjectDomain(project, blueprintContent, fileNamesLower);
  if (domain === 'game_interactive') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — Game Loop, Physics & Core Architecture`,
        description: 'Canvas/WebGL rendering loop, input handling, entity state machine, and core physics.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Gameplay Mechanics, Obstacles, Progression & Scoring',
        description: 'Core gameplay challenges, collision detection, scoring multipliers, and progression.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'HUD, Visual Juice, Audio SFX & Menus',
        description: 'Start/pause/game-over screens, particle effects, WebAudio SFX, and high-score UI.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'Responsive Controls, Playtest & Release Verification',
        description: 'Desktop/mobile viewport scaling, 60 FPS optimization, and automated playtest verification.',
      },
    ];
  }
  if (domain === 'embedded_iot') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — Hardware Pinout, Bus & Firmware Architecture`,
        description: 'MCU/board configuration, I2C/SPI/UART bus initialization, and protocol framing.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Driver Logic, Sensor/Memory I/O & State Machine',
        description: 'Register read/write workflows, non-blocking state machines, and buffer management.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'Serial Telemetry, Diagnostic CLI & Status Indicators',
        description: 'Interactive serial console, status LED/OLED feedback, and diagnostic commands.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'CRC/Safety Verification, Watchdog & Firmware Build',
        description: 'Read-after-write verification, fault recovery, and clean firmware compilation.',
      },
    ];
  }
  if (domain === 'cli_tool') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — CLI Argument Parser & Pre-Flight Architecture`,
        description: 'Subcommand structure, configuration loading, and environment/OS compatibility checks.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Core Execution Engine, Automation & Dry-Run Workflow',
        description: 'Primary command execution, idempotent operations, and non-destructive --dry-run mode.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'Terminal UX, ANSI Progress Telemetry & Structured Output',
        description: 'Clear progress indicators, human-readable & --json output modes, and actionable error messages.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'Rollback Safety, Checksum Verification & Test Suite',
        description: 'Backup/restore safety, checksum validation, and automated CLI integration tests.',
      },
    ];
  }
  if (domain === 'mobile_desktop') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — Native Shell, Windowing & State Architecture`,
        description: 'Application shell, IPC/bridge contracts, and persistent configuration storage.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Core Desktop/Mobile Features & System Integration',
        description: 'Primary functional modules, native OS integration, and background worker flows.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'Responsive Interface, Tray/Shortcuts & Theme Polish',
        description: 'Polished native-feeling UI, global keyboard shortcuts, and smooth animations.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'Cross-Platform Packaging, Performance & QA Suite',
        description: 'Startup performance, memory footprint optimization, and build packaging verification.',
      },
    ];
  }
  if (domain === 'ai_agents') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — Agent Protocol, Tooling & Router Architecture`,
        description: 'Model/provider contracts, capability routing, and context/prompt orchestration.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Execution Pipeline, Memory Store & Tool Dispatch',
        description: 'Multi-step task execution, tool call handlers, and state persistence.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'Control Console, Live Telemetry & Trace Inspector',
        description: 'Interactive operator UI/CLI, live run telemetry, and token/cost visibility.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'Guardrails, Fallback Resilience & Evaluation Suite',
        description: 'Rate-limit fallbacks, output validation, and automated end-to-end verification.',
      },
    ];
  }
  if (domain === 'api_service') {
    return [
      {
        id: 'ms-m1',
        code: 'M1',
        title: `${project.name} — Service Schema, Contracts & Data Layer`,
        description: 'API contracts, request/response schemas, and database models/migrations.',
      },
      {
        id: 'ms-m2',
        code: 'M2',
        title: 'Core Endpoints, Domain Services & Business Logic',
        description: 'Primary REST/RPC handlers, domain workflows, and background processing.',
      },
      {
        id: 'ms-m3',
        code: 'M3',
        title: 'OpenAPI Docs, Developer Ergonomics & Status Dashboard',
        description: 'Interactive API documentation, health/metrics endpoints, and client ergonomics.',
      },
      {
        id: 'ms-m4',
        code: 'M4',
        title: 'Auth Hardening, Rate Limiting & Integration Tests',
        description: 'Authentication/authorization checks, boundary validation, and automated API tests.',
      },
    ];
  }
  return [
    {
      id: 'ms-m1',
      code: 'M1',
      title: `${project.name} — Architecture, Data Schema & Core Setup`,
      description: 'Project blueprint (PROJECT.md), data models, API contracts, and build pipeline.',
    },
    {
      id: 'ms-m2',
      code: 'M2',
      title: 'Core Domain Logic, Services & Primary Workflows',
      description: 'End-to-end business logic, persistence layer, and primary application features.',
    },
    {
      id: 'ms-m3',
      code: 'M3',
      title: 'Interactive UI/UX, Views & Responsive Polish',
      description: 'User-facing views, interactive forms/controls, filtering, and visual ergonomics.',
    },
    {
      id: 'ms-m4',
      code: 'M4',
      title: 'Automated QA, Security Hardening & Release Readiness',
      description: 'End-to-end verification, edge-case handling, and zero-error production build.',
    },
  ];
}

async function seedInitialRoadmap(
  project: Project,
  blueprintContent: string,
  projectTickets: Ticket[],
  fSettings?: FactorySettings,
): Promise<StoredRoadmapFile> {
  const now = new Date().toISOString();
  const files = await listWorkspaceFilesFlat(project.path).catch(() => []);
  const fileNamesLower = files.map((f) => f.path.toLowerCase()).join(' ');
  const defs = buildDomainMilestones(project, blueprintContent, fileNamesLower);
  const milestones: RoadmapMilestone[] = defs.map((d) => ({
    ...d,
    status: 'planned',
    items: [],
  }));

  const seenTitles = new Set<string>();

  // 1. Map existing Kanban tickets into milestones so the roadmap immediately reflects real work
  for (const t of projectTickets) {
    if (
      t.title.startsWith('[Factory] Brainstorm & Roadmap Expansion') ||
      t.title.startsWith('[Brainstorm]') ||
      t.title.startsWith('[Roadmap]')
    ) {
      continue;
    }
    const msIdx = milestoneIndexForPersona(t.persona);
    const ms = milestones[msIdx] ?? milestones[1]!;
    const routing = defaultRoutingForPersona(t.persona, fSettings);
    const itemStatus =
      t.status === 'done'
        ? 'done'
        : t.status === 'in_progress' || t.status === 'review'
          ? 'in_progress'
          : 'planned';
    seenTitles.add(t.title.trim().toLowerCase());
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

  // 2. Also extract any markdown checklist items (`- [ ] ...` or `- [x] ...`) from PROJECT.md
  const checklistRegex = /^[\t ]*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = checklistRegex.exec(blueprintContent)) !== null) {
    const isChecked = (match[1] ?? '').toLowerCase() === 'x';
    const rawLine = (match[2] ?? '').replace(/\*\*/g, '').trim();
    if (rawLine.length < 6 || rawLine.length > 150) continue;
    if (seenTitles.has(rawLine.toLowerCase())) continue;
    seenTitles.add(rawLine.toLowerCase());
    const inferred = inferPersonaAndCategoryFromText(rawLine);
    const msIdx = milestoneIndexForPersona(inferred.persona);
    const ms = milestones[msIdx] ?? milestones[1]!;
    const routing = defaultRoutingForPersona(inferred.persona, fSettings);
    ms.items.push({
      id: `item-${randomUUID().slice(0, 8)}`,
      milestoneId: ms.id,
      title: rawLine.slice(0, 110),
      description: `Specification item from PROJECT.md: "${rawLine}". Implement and verify against the project build gate.`,
      category: inferred.category,
      persona: inferred.persona,
      preferredAgent: routing.preferredAgent,
      preferredModel: routing.preferredModel,
      priority: inferred.priority,
      status: isChecked ? 'done' : 'planned',
      ticketId: null,
      ticketKey: null,
      createdAt: now,
    });
  }

  return {
    visionSummary: extractVisionFromBlueprint(project, blueprintContent),
    milestones,
    suggestions: [],
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
  } else {
    // Automatically upgrade legacy generic milestone titles to domain-tailored titles
    const hasLegacyGenericTitles = stored.milestones.some((m) =>
      GENERIC_LEGACY_MS_TITLES.has(m.title.trim().toLowerCase()),
    );
    if (hasLegacyGenericTitles) {
      const files = await listWorkspaceFilesFlat(project.path).catch(() => []);
      const fileNamesLower = files.map((f) => f.path.toLowerCase()).join(' ');
      const defs = buildDomainMilestones(project, blueprint.content, fileNamesLower);
      for (const def of defs) {
        const ms = stored.milestones.find((m) => m.code === def.code);
        if (ms && GENERIC_LEGACY_MS_TITLES.has(ms.title.trim().toLowerCase())) {
          ms.title = def.title;
          ms.description = def.description;
          dirty = true;
        }
      }
    }
  }

  // Purge any legacy pre-seeded static template suggestions so projects start clean/empty until user brainstorms
  if (Array.isArray(stored.suggestions) && stored.suggestions.length > 0) {
    const beforeSugLen = stored.suggestions.length;
    stored.suggestions = stored.suggestions.filter(
      (s) => !LEGACY_STATIC_SUGGESTION_TITLES.has(s.title.trim().toLowerCase()),
    );
    if (stored.suggestions.length !== beforeSugLen) {
      dirty = true;
    }
  }

  const enabledProviders = fSettings.enabledProviders?.length
    ? fSettings.enabledProviders
    : (['claude'] as AgentId[]);

  // Check if an AI Architect agent wrote `.emberline/roadmap-generated.json`
  const agentRoadmapGenPath = path.join(project.path, ROADMAP_GEN_OUT_REL_PATH);
  if (existsSync(agentRoadmapGenPath)) {
    try {
      const raw = await readFile(agentRoadmapGenPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        visionSummary?: string;
        milestones?: Array<{
          code?: string;
          title?: string;
          description?: string;
          items?: Array<Partial<RoadmapItem>>;
        }>;
      };
      if (parsed.visionSummary?.trim()) {
        stored.visionSummary = parsed.visionSummary.trim();
        dirty = true;
      }
      if (Array.isArray(parsed.milestones) && parsed.milestones.length > 0) {
        const existingTitles = new Set(
          stored.milestones.flatMap((m) => m.items.map((i) => i.title.trim().toLowerCase())),
        );
        for (let idx = 0; idx < parsed.milestones.length; idx++) {
          const genMs = parsed.milestones[idx]!;
          const code = genMs.code?.trim() || `M${idx + 1}`;
          let targetMs = stored.milestones.find((m) => m.code === code);
          if (!targetMs) {
            targetMs = {
              id: `ms-${randomUUID().slice(0, 8)}`,
              code,
              title: genMs.title?.trim() || `Milestone ${code}`,
              description: genMs.description?.trim() ?? '',
              status: 'planned',
              items: [],
            };
            stored.milestones.push(targetMs);
          } else {
            if (genMs.title?.trim()) targetMs.title = genMs.title.trim();
            if (genMs.description?.trim()) targetMs.description = genMs.description.trim();
          }
          for (const rawItem of genMs.items ?? []) {
            if (!rawItem.title?.trim()) continue;
            const normTitle = rawItem.title.trim().toLowerCase();
            if (existingTitles.has(normTitle)) continue;
            existingTitles.add(normTitle);
            const inferred = inferPersonaAndCategoryFromText(
              `${rawItem.title} ${rawItem.description ?? ''}`,
            );
            const persona: AgentPersona = rawItem.persona ?? inferred.persona;
            const routing = defaultRoutingForPersona(persona, fSettings);
            targetMs.items.push({
              id: `item-${randomUUID().slice(0, 8)}`,
              milestoneId: targetMs.id,
              title: rawItem.title.trim(),
              description: rawItem.description?.trim() || rawItem.title.trim(),
              category: rawItem.category ?? inferred.category,
              persona,
              preferredAgent: routing.preferredAgent,
              preferredModel: routing.preferredModel,
              priority: rawItem.priority ?? inferred.priority,
              status: 'planned',
              ticketId: null,
              ticketKey: null,
              createdAt: new Date().toISOString(),
            });
          }
        }
        dirty = true;
      }
      await rm(agentRoadmapGenPath, { force: true });
    } catch {
      // Ignore malformed agent output
    }
  }

  // Normalize any suggestion/item routes that point to a disabled provider or a mismatched cross-provider model
  for (const sug of stored.suggestions ?? []) {
    const configuredRoute = defaultRoutingForPersona(sug.persona, fSettings);
    const agentAllowed = enabledProviders.includes(sug.preferredAgent);
    const nextAgent = agentAllowed ? sug.preferredAgent : configuredRoute.preferredAgent;
    const nextModel = coerceModelForProvider(
      nextAgent,
      agentAllowed ? sug.preferredModel : configuredRoute.preferredModel,
      sug.persona,
    );
    if (sug.preferredAgent !== nextAgent || sug.preferredModel !== nextModel) {
      sug.preferredAgent = nextAgent;
      sug.preferredModel = nextModel;
      dirty = true;
    }
  }
  for (const ms of stored.milestones) {
    for (const item of ms.items) {
      const configuredRoute = defaultRoutingForPersona(item.persona, fSettings);
      const agentAllowed = enabledProviders.includes(item.preferredAgent);
      const nextAgent = agentAllowed ? item.preferredAgent : configuredRoute.preferredAgent;
      const nextModel = coerceModelForProvider(
        nextAgent,
        agentAllowed ? item.preferredModel : configuredRoute.preferredModel,
        item.persona,
      );
      if (item.preferredAgent !== nextAgent || item.preferredModel !== nextModel) {
        item.preferredAgent = nextAgent;
        item.preferredModel = nextModel;
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
          const validAgent = enabledProviders.includes(requestedAgent)
            ? requestedAgent
            : routing.preferredAgent;
          const validModel = coerceModelForProvider(
            validAgent,
            s.preferredModel ?? routing.preferredModel,
            persona,
          );
          stored.suggestions.unshift({
            id: `sug-${randomUUID().slice(0, 8)}`,
            title: s.title,
            rationale: s.rationale ?? 'Suggested by AI Brainstorming Agent.',
            implementationPrompt: s.implementationPrompt ?? s.rationale ?? s.title,
            category: s.category ?? categoryForPersona(persona),
            impact: s.impact ?? 'high',
            effort: s.effort ?? 'medium',
            persona,
            preferredAgent: validAgent,
            preferredModel: validModel,
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
    // Strip any accidental brainstorm/roadmap meta-tickets that may have been imported earlier
    const beforeLen = ms.items.length;
    ms.items = ms.items.filter(
      (i) =>
        !i.title.startsWith('[Factory] Brainstorm & Roadmap Expansion') &&
        !i.title.startsWith('[Brainstorm]') &&
        !i.title.startsWith('[Roadmap]'),
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

  // Import any Kanban tickets not yet represented in the roadmap (excluding brainstorm/roadmap meta-tickets)
  for (const t of projectTickets) {
    if (linkedTicketIds.has(t.id)) continue;
    if (
      t.title.startsWith('[Factory] Brainstorm & Roadmap Expansion') ||
      t.title.startsWith('[Brainstorm]') ||
      t.title.startsWith('[Roadmap]')
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
    description:
      input.description?.trim() ||
      `Delivery milestone ${code} for ${project.name}: ${input.title.trim()}.`,
    status: 'planned',
    items: [],
  });
  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function deleteRoadmapMilestone(
  project: Project,
  ticketService: TicketService,
  milestoneId: string,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  if (stored.milestones.length <= 1) {
    throw new Error('Cannot delete the only remaining milestone');
  }
  const idx = stored.milestones.findIndex((m) => m.id === milestoneId || m.code === milestoneId);
  if (idx === -1) {
    throw new Error('Milestone not found');
  }
  const [removed] = stored.milestones.splice(idx, 1);
  if (removed && removed.items.length > 0) {
    const fallbackMs = stored.milestones[Math.max(0, idx - 1)] ?? stored.milestones[0]!;
    for (const item of removed.items) {
      item.milestoneId = fallbackMs.id;
      fallbackMs.items.push(item);
    }
  }
  await saveRoadmapFile(project, stored);
  return toRoadmapState(project, stored);
}

export async function addRoadmapItem(
  project: Project,
  ticketService: TicketService,
  input: CreateRoadmapItemBody,
): Promise<ProjectRoadmapState> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const inferred = inferPersonaAndCategoryFromText(`${input.title} ${input.description ?? ''}`);
  const persona: AgentPersona = input.persona ?? inferred.persona;
  const category: RoadmapCategory = input.category ?? inferred.category;
  const priority = input.priority ?? inferred.priority;

  const autoMsIdx = milestoneIndexForPersona(persona);
  const targetMs =
    (!input.milestoneId || input.milestoneId === 'auto'
      ? (stored.milestones[autoMsIdx] ?? stored.milestones[0])
      : stored.milestones.find((m) => m.id === input.milestoneId || m.code === input.milestoneId)) ??
    stored.milestones[0];
  if (!targetMs) {
    throw new Error('No milestone found in project roadmap');
  }

  const fSettings = ticketService.factorySettings();
  const routing = defaultRoutingForPersona(persona, fSettings);
  const chosenAgent = input.preferredAgent ?? routing.preferredAgent;
  const chosenModel = coerceModelForProvider(
    chosenAgent,
    input.preferredModel && input.preferredModel !== 'auto'
      ? input.preferredModel
      : routing.preferredModel,
    persona,
  );
  const cleanTitle = input.title.trim();
  const autoDescription =
    input.description?.trim() ||
    `Read PROJECT.md and implement "${cleanTitle}" in ${project.name}. Ensure clean module boundaries and verify the project's build/test gate passes.`;

  const newItem: RoadmapItem & { routeCustomized?: boolean } = {
    id: `item-${randomUUID().slice(0, 8)}`,
    milestoneId: targetMs.id,
    title: cleanTitle,
    description: autoDescription,
    category,
    persona,
    preferredAgent: chosenAgent,
    preferredModel: chosenModel,
    priority,
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

export async function autoGenerateProjectRoadmap(
  project: Project,
  ticketService: TicketService,
  input: AutoGenerateRoadmapBody,
): Promise<AutoGenerateRoadmapResponse> {
  const stored = await readOrInitRoadmapFile(project, ticketService);
  const blueprint = await readProjectBlueprint(project);
  const fSettings = ticketService.factorySettings();
  const files = await listWorkspaceFilesFlat(project.path).catch(() => []);
  const fileNamesLower = files.map((f) => f.path.toLowerCase()).join(' ');

  if (input.mode === 'agent') {
    const focusClause = input.instructions?.trim()
      ? `User focus / instructions: "${input.instructions.trim()}".`
      : `Design a structured, project-specific 4-milestone roadmap (M1..M4) for **${project.name}**.`;
    const prompt = [
      `[Roadmap] Auto-Generate Structured Milestones & Roadmap for **${project.name}**:`,
      focusClause,
      `1. Read \`PROJECT.md\` and inspect the files in \`${project.path}\`.`,
      `2. Write a comprehensive, project-tailored roadmap JSON file to \`${project.path}/.emberline/roadmap-generated.json\` with the exact structure:`,
      `{"visionSummary": "1-2 sentence executive summary of ${project.name}", "milestones": [{"code": "M1", "title": "...", "description": "...", "items": [{"title": "...", "description": "Detailed implementation spec", "persona": "architect|coder|ui_ux|dba|qa|security", "category": "architecture|feature|ui_ux|performance|qa_security", "priority": 2}]}]}`,
      `3. Include 4 clear milestones (M1..M4) with 2-4 concrete, non-duplicate tasks per milestone tailored strictly to **${project.name}**. Do NOT modify application source files in this run.`,
    ].join('\n');

    const agentRun = await ticketService.startBrainstormRun(project.id, {
      prompt,
      persona: 'architect',
    });

    return {
      roadmap: toRoadmapState(project, stored),
      agentRun,
    };
  }

  // Instant mode: refresh milestone definitions + extract PROJECT.md checklists + synthesize domain tasks
  const defs = buildDomainMilestones(project, blueprint.content, fileNamesLower);
  for (const def of defs) {
    let ms = stored.milestones.find((m) => m.code === def.code);
    if (!ms) {
      ms = {
        ...def,
        status: 'planned',
        items: [],
      };
      stored.milestones.push(ms);
    } else {
      ms.title = def.title;
      ms.description = def.description;
    }
  }

  const existingTitles = new Set(
    stored.milestones.flatMap((m) => m.items.map((i) => i.title.trim().toLowerCase())),
  );

  // 1. Extract any markdown checklist items (`- [ ] ...`) from PROJECT.md
  const checklistRegex = /^[\t ]*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = checklistRegex.exec(blueprint.content)) !== null) {
    const isChecked = (match[1] ?? '').toLowerCase() === 'x';
    const rawLine = (match[2] ?? '').replace(/\*\*/g, '').trim();
    if (rawLine.length < 6 || rawLine.length > 150) continue;
    if (existingTitles.has(rawLine.toLowerCase())) continue;
    existingTitles.add(rawLine.toLowerCase());
    const inferred = inferPersonaAndCategoryFromText(rawLine);
    const ms = stored.milestones[milestoneIndexForPersona(inferred.persona)] ?? stored.milestones[0]!;
    const routing = defaultRoutingForPersona(inferred.persona, fSettings);
    ms.items.push({
      id: `item-${randomUUID().slice(0, 8)}`,
      milestoneId: ms.id,
      title: rawLine.slice(0, 110),
      description: `Specification item from PROJECT.md: "${rawLine}".`,
      category: inferred.category,
      persona: inferred.persona,
      preferredAgent: routing.preferredAgent,
      preferredModel: routing.preferredModel,
      priority: inferred.priority,
      status: isChecked ? 'done' : 'planned',
      ticketId: null,
      ticketKey: null,
      createdAt: new Date().toISOString(),
    });
  }

  // 2. Synthesize domain-specific roadmap items and place them directly into their target milestones
  const synthesized = await synthesizeBrainstormSuggestions(
    project,
    blueprint.content,
    existingTitles,
    input.instructions ?? '',
    new Set(),
    fSettings,
  );
  for (const sug of synthesized) {
    if (existingTitles.has(sug.title.toLowerCase())) continue;
    existingTitles.add(sug.title.toLowerCase());
    const targetMs =
      stored.milestones.find((m) => m.code === sug.suggestedMilestoneCode) ??
      stored.milestones[milestoneIndexForPersona(sug.persona)] ??
      stored.milestones[0]!;
    targetMs.items.push({
      id: `item-${randomUUID().slice(0, 8)}`,
      milestoneId: targetMs.id,
      title: sug.title,
      description: `${sug.rationale}\n\n---\nImplementation Spec:\n${sug.implementationPrompt}`,
      category: sug.category,
      persona: sug.persona,
      preferredAgent: sug.preferredAgent,
      preferredModel: sug.preferredModel,
      priority: sug.impact === 'high' ? 3 : 2,
      status: 'planned',
      ticketId: null,
      ticketKey: null,
      createdAt: new Date().toISOString(),
    });
  }

  await saveRoadmapFile(project, stored);
  const refreshed = await readOrInitRoadmapFile(project, ticketService);
  return {
    roadmap: toRoadmapState(project, refreshed),
    agentRun: null,
  };
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
    sug.preferredModel = coerceModelForProvider(sug.preferredAgent, sug.preferredModel, sug.persona);
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
  found.preferredModel = coerceModelForProvider(found.preferredAgent, found.preferredModel, found.persona);
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
  if (itemId === '__all_suggestions__') {
    stored.suggestions = [];
    await saveRoadmapFile(project, stored);
    return toRoadmapState(project, stored);
  }
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

  let agentRun = null;
  if (input.mode === 'agent') {
    // Do NOT pre-fill static templates when launching the AI Brainstorming Agent!
    // The agent will inspect PROJECT.md + repository files and write `.emberline/brainstorm-suggestions.json`.
    const existingItemTitles = stored.milestones
      .flatMap((m) => m.items.map((i) => `- ${i.title}`))
      .slice(0, 30)
      .join('\n');
    const focusClause = input.focus?.trim()
      ? `Focus specifically on: "${input.focus.trim()}".`
      : `Analyze what features, architectural improvements, UI/UX enhancements, or QA checks would be most valuable next for **${project.name}**.`;
    const prompt = [
      `Brainstorm & Roadmap Ideation for **${project.name}** (Read-Only Analysis + JSON Output):`,
      `${focusClause}`,
      `1. Read \`PROJECT.md\` and inspect the actual files in \`${project.path}\` to understand this specific project's domain, tech stack, and current implementation.`,
      existingItemTitles
        ? `2. Avoid duplicating already completed/planned roadmap items:\n${existingItemTitles}`
        : `2. Propose new, non-duplicate ideas tailored strictly to this project.`,
      `3. Write 4 to 6 concrete, project-specific suggestions to \`${project.path}/.emberline/brainstorm-suggestions.json\` with the exact JSON format:`,
      `{"suggestions": [{"title": "...", "rationale": "Why this improves ${project.name}", "implementationPrompt": "Detailed instructions for the specialist agent", "category": "feature|ui_ux|architecture|performance|qa_security", "impact": "high|medium", "effort": "small|medium|large", "persona": "coder|ui_ux|architect|dba|qa|security", "preferredAgent": "claude", "preferredModel": "fable|opus|sonnet", "suggestedMilestoneCode": "M2|M3|M4"}]}`,
      `4. IMPORTANT: Every suggestion MUST be 100% relevant to **${project.name}**. Do NOT modify source files or create \`.emberline/new-tickets.json\`—only write \`${project.path}/.emberline/brainstorm-suggestions.json\`.`,
    ].join('\n');

    agentRun = await ticketService.startBrainstormRun(project.id, {
      prompt,
      persona: input.leadPersona ?? 'product_owner',
    });
  } else {
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

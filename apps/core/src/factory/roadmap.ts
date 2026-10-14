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
  const combinedContext = `${project.name} ${project.description} ${blueprintContent} ${fileNamesLower}`.toLowerCase();

  const isFlappyOrArcade = /flappy|bird|jump|flap|obstacle|pipe|endless|runner|arcade|cat|petiqa|paw/.test(
    combinedContext,
  );
  const isTowerOrStrategy = /tower|defen[cs]e|wave|turret/.test(combinedContext);
  const isGameOrInteractive =
    isFlappyOrArcade ||
    isTowerOrStrategy ||
    /game|canvas|phaser|pixi|three|webgl|enemy|sprite|player|score/.test(combinedContext);
  const isApiOrBackend = /fastify|express|nest|prisma|drizzle|postgres|sqlite|graphql|endpoint|webhook/.test(
    combinedContext,
  );

  const candidates: Array<Omit<BrainstormSuggestion, 'id'>> = [];

  if (focus.trim()) {
    const cleanFocus = focus.trim();
    candidates.push(
      {
        title: `Feature Spec & Core Implementation: ${cleanFocus.slice(0, 72)}`,
        rationale: `Directly addresses your brainstorm focus ("${cleanFocus}") with end-to-end domain logic and state integration.`,
        implementationPrompt: `Read PROJECT.md and inspect the codebase. Design and implement the following capability end-to-end: "${cleanFocus}". Include clean state management, modular code structure, and run npm run build when finished.`,
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: `Interactive UI/UX & Visual Polish for: ${cleanFocus.slice(0, 64)}`,
        rationale: `Builds an intuitive, responsive HUD/UI surface and visual feedback loop for "${cleanFocus}".`,
        implementationPrompt: `Read PROJECT.md and design the user interface, HUD controls, animations, and visual feedback for: "${cleanFocus}". Ensure responsive layout, run npm run build, and verify in the Live Browser ($EMBERLINE_DEMO_URL).`,
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'antigravity',
        preferredModel: 'argon',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: `Automated QA & Live Browser Verification for: ${cleanFocus.slice(0, 60)}`,
        rationale: `Ensures "${cleanFocus}" works reliably with zero console errors and full test coverage.`,
        implementationPrompt: `Verify the implementation of "${cleanFocus}". Add unit/integration tests, run npm run build, open $EMBERLINE_DEMO_URL with Playwright MCP, exercise the new user flow, and confirm zero console errors.`,
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

  if (isFlappyOrArcade) {
    candidates.push(
      {
        title: 'Power-Up Collectibles (Shield Bubble, Coin Magnet, Slow-Mo & Score 2x)',
        rationale:
          'Spawns collectible power-up orbs between obstacle gaps that grant temporary invulnerability, magnet attraction, or double points with HUD timers.',
        implementationPrompt:
          'Read PROJECT.md and implement collectible Power-Ups (Shield Bubble that absorbs 1 hit, Magnet that pulls nearby collectibles, Slow-Mo Feather, and 2x Score Multiplier) with visual aura effects and active duration bars in the HUD. Run npm run build.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Unlockable Character Skins, Particle Trails & Pet Shop Modal',
        rationale:
          'Gives players a compelling reason to collect coins/points by unlocking custom character skins, rainbow/paw particle trails, and accessories persisted in localStorage.',
        implementationPrompt:
          'Implement an interactive Character & Trail Customization Shop accessible from the title/game-over screen: let players spend collected currency to unlock and equip character skins and particle trails, persisted in localStorage. Run npm run build.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'medium',
        persona: 'ui_ux',
        preferredAgent: 'antigravity',
        preferredModel: 'argon',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: 'Dynamic Day/Sunset/Night Parallax Biomes & Weather Effects',
        rationale:
          'Smoothly transitions the sky, clouds, and background scenery every 15 points (Sunny Day -> Golden Sunset -> Starry Night -> Sakura/Snowfall) to make long runs visually rewarding.',
        implementationPrompt:
          'Add dynamic biome & time-of-day transitions as the player score increases (Day, Sunset, Starry Night) with multi-layer parallax scrolling and subtle ambient weather particles. Run npm run build.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'small',
        persona: 'ui_ux',
        preferredAgent: 'antigravity',
        preferredModel: 'argon',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: 'Near-Miss Combo Multiplier, Fever Mode & Floating Score Popups',
        rationale:
          'Rewards skillful close passes through obstacle centers ("PERFECT +2", "FEVER x3!") with juicy floating text and combo streak feedback.',
        implementationPrompt:
          'Implement a Near-Miss / Sweet-Spot Combo system: passing through the center of an obstacle gap increments a combo streak with floating "+2 PERFECT!" popups and triggers Fever Mode visual glow at 5x streak. Run npm run build.',
        category: 'feature',
        impact: 'high',
        effort: 'small',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Daily Seeded Challenge Mode, Ghost Replay & Shareable Score Card',
        rationale:
          'Adds a deterministic Daily Challenge seed so every player faces the exact same obstacle layout each day, plus a Ghost silhouette of their personal best run.',
        implementationPrompt:
          'Implement a Daily Challenge mode using a date-seeded PRNG for obstacle generation, record the player best run trajectory to render a semi-transparent Ghost replay, and add a Share Score Card summary on Game Over. Run npm run build.',
        category: 'feature',
        impact: 'medium',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
    );
  }

  if (isGameOrInteractive) {
    candidates.push(
      {
        title: 'WebAudio Synthesizer Sound Effects, Particle Explosions & Screen Shake',
        rationale:
          'Zero-dependency procedural WebAudio SFX (jump/flap chime, score ding, power-up synth, collision thud) plus floating score popups make gameplay feel visceral and alive.',
        implementationPrompt:
          'Add a procedural WebAudio API sound synthesizer (with Mute/Volume toggle in HUD), floating score numbers, particle burst effects, and subtle screen shake on collision. Run npm run build and verify in $EMBERLINE_DEMO_URL.',
        category: 'ui_ux',
        impact: 'high',
        effort: 'small',
        persona: 'ui_ux',
        preferredAgent: 'antigravity',
        preferredModel: 'argon',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: 'Persistent Meta-Progression, Achievements & LocalStorage Leaderboard',
        rationale:
          'Tracks lifetime statistics, top 10 local high scores, and 8 unlockable achievement badges with animated toast notifications.',
        implementationPrompt:
          'Implement a High Score Leaderboard & Stats modal and 8 unlockable Achievements (e.g. First 10 Points, 5x Combo, Survivor) persisted in localStorage with in-game toast banners when unlocked. Run npm run build.',
        category: 'architecture',
        impact: 'medium',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M3',
      },
      {
        title: '60 FPS Render Loop Optimization, Object Pooling & Automated Playtest Suite',
        rationale:
          'Eliminates garbage-collection frame drops on mobile devices by pooling particles/obstacles and adds deterministic simulation tests.',
        implementationPrompt:
          'Optimize rendering and simulation performance using object pooling, ensure responsive touch/click latency on mobile viewports, and add automated tests verifying physics, collision bounds, and scoring. Run npm run build.',
        category: 'performance',
        impact: 'medium',
        effort: 'small',
        persona: 'qa',
        preferredAgent: 'claude',
        preferredModel: 'sonnet',
        suggestedMilestoneCode: 'M4',
      },
    );
  }

  if (isTowerOrStrategy) {
    candidates.push(
      {
        title: 'Boss Waves, Elite Enemy Modifiers & Special Abilities',
        rationale:
          'Adds strategic depth and excitement every 5th/10th wave with unique boss mechanics (shield aura, speed burst, summoners) and boss health bar HUD.',
        implementationPrompt:
          'Read PROJECT.md and implement Boss Waves & Elite Enemy Modifiers: every 5 waves spawn a Boss unit with a dedicated Boss HP bar at the top of the HUD, unique abilities, and bonus reward currency. Run npm run build when complete.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
      {
        title: 'Tower Specialization Tech Tree & Tier-3 Ultimate Upgrades',
        rationale:
          'Lets players customize their defense strategy with branching upgrade paths (e.g. Sniper vs Rapid-Fire, AoE Frost vs Chain Lightning).',
        implementationPrompt:
          'Implement a branching Tower Upgrade & Specialization Tree in the game engine and selection panel: allow towers at max base level to specialize into 1 of 2 unique Tier-3 paths. Run npm run build.',
        category: 'feature',
        impact: 'high',
        effort: 'medium',
        persona: 'coder',
        preferredAgent: 'claude',
        preferredModel: 'opus',
        suggestedMilestoneCode: 'M2',
      },
    );
  } else if (isApiOrBackend) {
    candidates.push(
      {
        title: 'OpenAPI / Swagger Interactive Documentation & Schema Validation',
        rationale:
          'Provides self-documenting interactive API explorer and strict boundary validation for every route.',
        implementationPrompt:
          'Add comprehensive Zod request/response schemas and an interactive API documentation endpoint (/docs or /api/openapi.json) with health and telemetry metrics.',
        category: 'architecture',
        impact: 'high',
        effort: 'medium',
        persona: 'architect',
        preferredAgent: 'claude',
        preferredModel: 'fable',
        suggestedMilestoneCode: 'M1',
      },
      {
        title: 'Rate Limiting, Structured Audit Logging & Security Headers',
        rationale:
          'Hardens the service against abuse with token-bucket rate limiting and structured JSON audit trails.',
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

  // Universal high-value software factory suggestions
  candidates.push(
    {
      title: 'Mobile Touch Ergonomics, Safe-Area Viewport Fit & Haptic Feedback',
      rationale:
        'Ensures full-screen edge-to-edge responsiveness on iOS/Android viewports (100dvh, safe-area-inset) with optional navigator.vibrate haptic feedback.',
      implementationPrompt:
        'Audit and refine mobile viewport sizing (100dvh, safe-area-inset padding, touch-action: manipulation, zero overscroll bounce) and add subtle haptic feedback on mobile devices. Run npm run build.',
      category: 'ui_ux',
      impact: 'high',
      effort: 'small',
      persona: 'ui_ux',
      preferredAgent: 'antigravity',
      preferredModel: 'argon',
      suggestedMilestoneCode: 'M3',
    },
    {
      title: 'Interactive Onboarding Tour, Command Shortcuts & Empty-State Polish',
      rationale:
        'Makes first-time user experience effortless with contextual hints, keyboard shortcuts overlay (?), and polished empty/loading states.',
      implementationPrompt:
        'Read PROJECT.md and polish the user experience with a keyboard shortcuts modal, interactive quick-start guide, and refined micro-interactions across all primary views. Run npm run build.',
      category: 'ui_ux',
      impact: 'medium',
      effort: 'small',
      persona: 'ui_ux',
      preferredAgent: 'antigravity',
      preferredModel: 'argon',
      suggestedMilestoneCode: 'M3',
    },
    {
      title: 'Data Export / Import (JSON & Shareable Snapshot) + Telemetry Dashboard',
      rationale:
        'Lets users back up, share, or inspect their application state and view real-time performance/usage statistics.',
      implementationPrompt:
        'Implement JSON state export/import and an in-app statistics/analytics summary modal so users can inspect metrics and back up their progress. Run npm run build.',
      category: 'feature',
      impact: 'medium',
      effort: 'small',
      persona: 'coder',
      preferredAgent: 'claude',
      preferredModel: 'opus',
      suggestedMilestoneCode: 'M2',
    },
    {
      title: 'End-to-End Smoke Test Suite & Zero-Warning Build Hardening',
      rationale:
        'Verifies all critical user journeys automatically and ensures TypeScript/ESLint/build pipelines stay 100% clean.',
      implementationPrompt:
        'Audit the project for any unhandled edge cases, TypeScript/lint warnings, or untested modules. Add comprehensive smoke tests and verify npm run build succeeds cleanly.',
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
      title: 'Foundation, Blueprint & Core Architecture',
      description: 'Project specification (PROJECT.md), repository structure, build pipeline, and core contracts.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m2',
      code: 'M2',
      title: 'Core Domain Engine & Primary Features',
      description: 'Primary gameplay/business logic, state management, entities, and core workflows.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m3',
      code: 'M3',
      title: 'Interactive UI/UX, Audio/Visual Polish & Progression',
      description: 'HUD, responsive interface, visual effects, sound design, and user experience.',
      status: 'planned',
      items: [],
    },
    {
      id: 'ms-m4',
      code: 'M4',
      title: 'QA Verification, Performance & Release Readiness',
      description: 'Automated test suites, Live Browser QA verification, performance optimization, and security.',
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

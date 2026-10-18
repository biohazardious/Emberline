/** Starting-point presets per project type. Data only. */
import { optionsForType, PROJECT_TYPES } from './options.js';
import { type PresetDef, type ProjectChoices, STACK_DIMENSION_IDS, type StackDimensionId } from './types.js';

const COMMON = [
  'Set up the project skeleton for the stack chosen in PROJECT.md.',
  'The build gate runs the approved `checks` in `.emberline/worktree.yml`: make the project satisfy them (add the build, lint and test scripts) instead of editing them; an edited worktree.yml only applies after a person approves it in the project banner. Make `setup` and the preview service real as well.',
  'Keep PROJECT.md accurate as you decide things; items marked "decided by agent" must be filled in.',
];

/** For presets that leave the stack open: there are no generated commands to satisfy yet. */
const OPEN = [
  'Set up the project skeleton for the stack you choose, and make the setup, build, lint and test commands you write into `.emberline/worktree.yml` pass.',
  'Keep PROJECT.md accurate as you decide things; items marked "decided by agent" must be filled in.',
];

function p(
  id: string,
  type: PresetDef['type'],
  label: string,
  description: string,
  bestFor: string,
  tradeoff: string,
  choices: PresetDef['choices'],
  bootstrap: string[] = [],
  starter: PresetDef['starter'] = null,
  steps: readonly string[] = COMMON,
): PresetDef {
  return { id, type, label, description, bestFor, tradeoff, choices, starter, bootstrap: [...bootstrap, ...steps] };
}

export const AUTO_PRESET_PREFIX = 'auto-';
export const isAutoPreset = (id: string | null | undefined): boolean => Boolean(id?.startsWith(AUTO_PRESET_PREFIX));

/**
 * "Auto" for one type: every dimension with options for the type is left to the agent, the rest
 * are none. Listed first, so it is the default when a type is picked.
 */
function autoPreset(type: PresetDef['type']): PresetDef {
  const choices: Partial<Record<StackDimensionId, string>> = {};
  for (const id of STACK_DIMENSION_IDS) choices[id] = optionsForType(id, type).length > 0 ? 'agent' : 'none';
  return p(
    `${AUTO_PRESET_PREFIX}${type}`,
    type,
    'Auto — let the agent choose',
    'Describe what you want; the Bootstrap agent picks the stack from your vision and explains it in PROJECT.md',
    'Best for when you are not sure which stack fits: the agent picks one from your vision.',
    'You review its picks in PROJECT.md, and runs have no setup until you approve its worktree.yml.',
    choices,
    [],
    null,
    OPEN,
  );
}

/** Below this many characters (trimmed) the vision is too thin for the agent to decide from. */
export const VISION_MIN_LENGTH = 20;

const PRIMARY_DIMENSIONS: readonly StackDimensionId[] = ['frontend', 'backend', 'database', 'auth', 'deploy'];

/** The vision is required for Auto, and whenever three or more primary dimensions are left to the agent. */
export function visionRequired(presetId: string | null | undefined, choices: ProjectChoices): boolean {
  if (isAutoPreset(presetId)) return true;
  return PRIMARY_DIMENSIONS.filter((id) => choices[id] === 'agent').length >= 3;
}

export const PRESETS: readonly PresetDef[] = [
  ...PROJECT_TYPES.map((t) => autoPreset(t.id)),

  // fullstack
  p('fullstack-react-fastify', 'fullstack', 'React + Fastify + PostgreSQL/SQLite', 'TypeScript monorepo with Vite, Fastify and Drizzle ORM',
    'Best for business apps that need a separate typed API and a rich UI in one TypeScript repo.',
    'More moving parts than a single framework: two apps, a shared package and a database to run.',
  {
    language: 'typescript-node', frontend: 'react-vite', backend: 'fastify', database: 'postgres-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }, ['Use a pnpm monorepo: `apps/web`, `apps/api`, `packages/shared` (shared zod schemas).']),
  p('fullstack-nextjs', 'fullstack', 'Next.js full-stack + PostgreSQL', 'App Router, server actions and route handlers with Drizzle',
    'Best for product apps where pages, data loading and the API live in one framework.',
    'Ties you to Next.js conventions; its server features fit Vercel or a Node host best.',
  {
    language: 'typescript-node', frontend: 'nextjs', backend: 'nextjs-routes', database: 'postgres-drizzle', auth: 'email-password', deploy: 'vercel', styling: 'tailwind-shadcn', testing: 'vitest-playwright',
  }),
  p('fullstack-react-fastapi', 'fullstack', 'React + FastAPI + PostgreSQL', 'TypeScript SPA paired with a Python FastAPI backend',
    'Best for teams with Python data or ML code behind a TypeScript web UI.',
    'Two languages and toolchains to maintain, and types are not shared across the API boundary.',
  {
    language: 'typescript-python', frontend: 'react-vite', backend: 'fastapi', database: 'postgres-sqlalchemy', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'pytest-vitest-playwright',
  }),
  p('fullstack-react-go', 'fullstack', 'React + Go API + PostgreSQL', 'High-throughput Go backend with a React frontend',
    'Best for APIs with heavy traffic or concurrency, with a React UI on top.',
    'Go and TypeScript in one repo, and more boilerplate than a Node backend for simple CRUD.',
  {
    language: 'typescript-go', frontend: 'react-vite', backend: 'go-http', database: 'postgres-sqlc', auth: 'jwt-bearer', deploy: 'docker-compose', styling: 'tailwind', testing: 'go-test',
  }),
  p('fullstack-nuxt', 'fullstack', 'Nuxt full-stack platform', 'Nuxt / Vue 3 frontend with a Nitro server',
    'Best for Vue developers who want pages and server routes in one framework.',
    'A smaller ecosystem than React, and SQLite keeps it to a single server instance.',
  {
    language: 'typescript-node', frontend: 'nuxt', backend: 'nitro', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // web_saas
  p('web-react-fastify', 'web_saas', 'React + Vite + Fastify portal', 'Interactive web portal with a light API and SQLite/Postgres',
    'Best for internal portals and dashboards backed by a light API.',
    'You wire routing and data loading yourself, and pages render in the browser, not on the server.',
  {
    language: 'typescript-node', frontend: 'react-vite', backend: 'fastify', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('web-nextjs-saas', 'web_saas', 'Next.js SaaS starter', 'App Router SaaS dashboard with auth, forms and Postgres',
    'Best for SaaS products that need sign-in, dashboards and public pages that rank in search.',
    'Clerk is a hosted service that costs money past its free tier, and hosting leans on Vercel.',
  {
    language: 'typescript-node', frontend: 'nextjs', backend: 'nextjs-routes', database: 'postgres-drizzle', auth: 'clerk', deploy: 'vercel', styling: 'tailwind-shadcn', testing: 'vitest-playwright',
  }),
  p('web-sveltekit', 'web_saas', 'SvelteKit operational web app', 'Lean, fast forms and dashboards',
    'Best for lean forms and dashboards where small bundles and simple code matter.',
    'A smaller ecosystem with fewer ready-made component libraries than React.',
  {
    language: 'typescript-node', frontend: 'sveltekit', backend: 'sveltekit-server', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('web-spa', 'web_saas', 'Frontend SPA only', 'Pure client-side app consuming an external API',
    'Best for a browser-only app that talks to an API someone else runs.',
    'No server of its own: data stays in the browser unless the external API stores it.',
  {
    language: 'typescript-node', frontend: 'react-vite', backend: 'none', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // static_site
  p('static-plain', 'static_site', 'Plain HTML/CSS/JS', 'Three hand-written files, no build step, served by a tiny static server',
    'Best for one or a few pages you edit by hand: no build, edit and refresh.',
    'No components or templating, so shared parts such as the header are copied by hand.',
  {
    language: 'javascript', frontend: 'plain-html', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'none',
  }, ['The starter files `index.html`, `styles.css` and `script.js` already exist: build the site from the vision on top of them, keeping it build-free.'], 'static-plain'),
  p('static-vite', 'static_site', 'Vite (vanilla)', 'Vite with vanilla JS and a fast dev server',
    'Best for small interactive pages that want ES modules and instant reloads.',
    'Adds a Node build step and dependencies to what is still a hand-written site.',
  {
    language: 'javascript', frontend: 'vite-vanilla', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'css-tokens', testing: 'none',
  }, ['Scaffold a vanilla Vite project (no framework) with a pnpm lockfile.']),
  p('static-astro', 'static_site', 'Astro', 'Content-focused static site with islands',
    'Best for content sites with a few interactive islands; it ships static HTML.',
    'Needs a Node build step, and interactive parts follow the Astro islands model.',
  {
    language: 'typescript-node', frontend: 'astro', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'css-tokens', testing: 'link-check',
  }, ['Scaffold an Astro project with static output.']),
  p('static-eleventy', 'static_site', 'Eleventy', 'Simple template-driven static site generator',
    'Best for Markdown blogs and docs with almost no JavaScript.',
    'Interactivity is hand-written, and templates (Nunjucks, Liquid) are looser than components.',
  {
    language: 'javascript', frontend: 'eleventy', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'link-check',
  }, ['Scaffold an Eleventy project that builds to `_site`.']),

  // api_service
  p('api-ts-fastify', 'api_service', 'TypeScript Fastify + PostgreSQL service', 'Typed REST service with Drizzle and Redis',
    'Best for typed REST services that share TypeScript with a web frontend.',
    'Node runs one thread per process, so CPU-heavy work needs workers or another service.',
  {
    language: 'typescript-node', frontend: 'openapi-docs', backend: 'fastify', database: 'postgres-drizzle', auth: 'api-keys', deploy: 'docker-compose', testing: 'vitest',
  }),
  p('api-python-fastapi', 'api_service', 'Python FastAPI + async SQLAlchemy', 'Async Python service with Pydantic',
    'Best for services close to Python data, ML or scripting code, with automatic API docs.',
    'Lower raw throughput than Go or Rust, and async SQLAlchemy takes some learning.',
  {
    language: 'python', frontend: 'openapi-docs', backend: 'fastapi', database: 'postgres-sqlalchemy', auth: 'jwt-bearer', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('api-go', 'api_service', 'Go high-throughput API / gRPC', 'Go net/http or Chi with gRPC and sqlc',
    'Best for high-throughput APIs and gRPC services shipped as one small binary.',
    'More boilerplate for simple CRUD, and sqlc means writing the SQL by hand.',
  {
    language: 'go', frontend: 'none', backend: 'go-http', database: 'postgres-sqlc', auth: 'jwt-bearer', deploy: 'docker-compose', testing: 'go-test',
  }),
  p('api-rust-axum', 'api_service', 'Rust Axum + SQLx service', 'Tokio-based service with compile-time checked SQL',
    'Best for services where latency, memory use and correctness matter most.',
    'Slow compiles and a steep learning curve; SQLx checks need a database or cached query data to build.',
  {
    language: 'rust', frontend: 'none', backend: 'rust-axum', database: 'postgres-sqlx', auth: 'jwt-bearer', deploy: 'fly-io', testing: 'cargo-test',
  }),

  // ai_agents
  p('agents-hybrid', 'ai_agents', 'TypeScript + Python multi-agent platform', 'React streaming console over an agent router with pgvector',
    'Best for multi-agent products with a live web console and vector search in Postgres.',
    'Two languages, a database and a router to operate: the most setup of the agent presets.',
  {
    language: 'typescript-python', frontend: 'react-vite', backend: 'agent-router', database: 'pgvector', auth: 'api-keys', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('agents-python-rag', 'ai_agents', 'Python autonomous agent and RAG pipeline', 'FastAPI service with provider SDKs and a vector store',
    'Best for retrieval (RAG) pipelines and autonomous agents built on Python AI libraries.',
    'No web UI, only a terminal stream, and Qdrant is one more service to run.',
  {
    language: 'python', frontend: 'cli-stream', backend: 'fastapi', database: 'qdrant', auth: 'api-keys', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('agents-mcp-server', 'ai_agents', 'MCP server and tool suite', 'Model Context Protocol server with a local knowledge index',
    'Best for giving AI assistants tools and data over the Model Context Protocol.',
    'It serves other agents, not end users, so it is only useful from clients that speak MCP.',
  {
    language: 'typescript-node', frontend: 'mcp-inspector', backend: 'mcp-sdk', database: 'local-index', auth: 'none', deploy: 'package-registry', testing: 'vitest',
  }),

  // mobile_desktop
  p('app-tauri', 'mobile_desktop', 'Tauri desktop app (Rust + React)', 'Small native shell around a React UI',
    'Best for small, fast desktop apps with a web UI and Rust for native work.',
    "Native code is Rust, and the UI runs in each OS's own webview, so test on every platform.",
  {
    language: 'typescript-rust', frontend: 'react-vite', backend: 'tauri-core', database: 'local-sqlite', auth: 'none', deploy: 'github-releases', styling: 'tailwind', testing: 'cargo-test',
  }),
  p('app-capacitor', 'mobile_desktop', 'Capacitor Android / hybrid app', 'React web UI wrapped for Android',
    'Best for turning a React web app into an Android app with access to device APIs.',
    'Feels less native than a native UI, and heavy animation can stutter in the webview.',
  {
    language: 'typescript-kotlin', frontend: 'react-vite', backend: 'capacitor-bridge', database: 'indexeddb', auth: 'none', deploy: 'app-stores', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('app-expo', 'mobile_desktop', 'React Native / Expo app', 'Cross-platform mobile app with Expo Router',
    'Best for iOS and Android apps from one React Native codebase with fast iteration.',
    'Native modules outside Expo need a custom dev build, and app store review applies.',
  {
    language: 'typescript-node', frontend: 'react-native-expo', backend: 'expo-modules', database: 'expo-sqlite', auth: 'oauth-provider', deploy: 'app-stores', testing: 'vitest',
  }),
  p('app-flutter', 'mobile_desktop', 'Flutter cross-platform app', 'Material/Cupertino UI for mobile and desktop',
    'Best for one polished UI that looks the same on phones and desktops.',
    'Dart is a separate language from web code, and apps are larger than native ones.',
  {
    language: 'dart', frontend: 'flutter', backend: 'none', database: 'drift', auth: 'firebase-auth', deploy: 'app-stores',
  }),
  p('app-electron', 'mobile_desktop', 'Electron desktop studio', 'TypeScript Electron app with a React renderer',
    'Best for feature-rich desktop tools that need Node APIs and the same UI on every OS.',
    'Large downloads and high memory use, since every app ships its own Chromium.',
  {
    language: 'typescript-node', frontend: 'react-vite', backend: 'electron-main', database: 'local-sqlite', auth: 'none', deploy: 'github-releases', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // cli_tool
  p('cli-python', 'cli_tool', 'Python CLI and system automation', 'Typer subcommands with Rich output and rollback manifests',
    'Best for system automation and admin scripts with friendly terminal output.',
    'Users need a Python runtime, and it starts slower than a compiled binary.',
  {
    language: 'bash-python', frontend: 'typer-rich', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'package-registry', styling: 'ansi-rich', testing: 'pytest',
  }),
  p('cli-go', 'cli_tool', 'Go single-binary CLI / TUI', 'Cobra with BubbleTea interactive screens',
    'Best for CLIs and TUIs shipped as one static binary for every OS.',
    "BubbleTea's model-update-view style takes getting used to for simple tools.",
  {
    language: 'go', frontend: 'cobra-bubbletea', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'github-releases', testing: 'go-test',
  }),
  p('cli-rust', 'cli_tool', 'Rust CLI / TUI utility', 'Clap derive with Ratatui',
    'Best for fast, reliable CLI and TUI utilities with strict argument parsing.',
    'Slow compiles and a steeper learning curve than Go or Python.',
  {
    language: 'rust', frontend: 'clap-ratatui', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'github-releases', testing: 'cargo-test',
  }),
  p('cli-node', 'cli_tool', 'TypeScript / Node CLI', 'Commander or Clack prompts for DevOps automation',
    'Best for DevOps and JavaScript-ecosystem tools that npm users install in one command.',
    'Needs Node on the target machine, and it starts slower than a binary.',
  {
    language: 'typescript-node', frontend: 'commander-clack', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'package-registry', testing: 'vitest',
  }),

  // embedded_iot
  p('iot-platformio', 'embedded_iot', 'ESP32 / Arduino / PlatformIO', 'Hardware tooling with a serial console',
    'Best for ESP32 and Arduino boards with a quick build, flash and monitor loop.',
    'The Arduino layer hides details, so advanced Wi-Fi, power or RTOS tuning gets harder.',
  {
    language: 'c-cpp', frontend: 'serial-console', backend: 'platformio-arduino', database: 'nvs-flash', deploy: 'firmware-flash', testing: 'platformio-test',
  }),
  p('iot-esp-idf', 'embedded_iot', 'ESP-IDF IoT firmware', 'Wi-Fi/BLE/MQTT firmware with a captive portal',
    'Best for connected ESP32 devices that need Wi-Fi, BLE, MQTT and a setup portal.',
    'ESP32 only, with a larger and lower-level SDK than Arduino.',
  {
    language: 'c-cpp', frontend: 'captive-portal', backend: 'esp-idf', database: 'littlefs', auth: 'device-token', deploy: 'firmware-flash', testing: 'platformio-test',
  }),
  p('iot-stm32', 'embedded_iot', 'STM32 / RP2040 firmware', 'Embedded C/C++ or Rust on a Cortex-M part',
    'Best for low-level firmware on Cortex-M chips with tight timing or power budgets.',
    'More manual work: clock and pin setup, linker scripts and flashing tools.',
  {
    language: 'c-cpp', frontend: 'serial-console', backend: 'stm32-hal', database: 'external-flash', deploy: 'firmware-flash',
  }),

  // library
  p('lib-typescript', 'library', 'TypeScript universal SDK', 'ESM + CJS + type declarations with VitePress docs',
    'Best for SDKs used from Node and browsers, with typed APIs and a docs site.',
    'Shipping both ESM and CommonJS adds build and packaging config to maintain.',
  {
    language: 'typescript-node', frontend: 'docs-vitepress', backend: 'typed-core', database: 'storage-adapters', deploy: 'package-registry', styling: 'docs-theme', testing: 'vitest',
  }),
  p('lib-python', 'library', 'Python SDK / PyPI package', 'Typed Python core with MkDocs',
    'Best for Python packages on PyPI with typed APIs and a MkDocs site.',
    'Packaging and the range of supported Python versions need ongoing upkeep.',
  {
    language: 'python', frontend: 'docs-mkdocs', backend: 'typed-core', database: 'in-memory', deploy: 'package-registry', styling: 'docs-theme', testing: 'pytest',
  }),
  p('lib-rust', 'library', 'Rust crate', 'Library crate with rustdoc and examples',
    'Best for Rust crates on crates.io with API docs and runnable examples.',
    'Only Rust code can use it directly; other languages need bindings.',
  {
    language: 'rust', frontend: 'rustdoc', backend: 'typed-core', database: 'in-memory', deploy: 'package-registry', testing: 'cargo-test',
  }),

  // game_interactive
  p('game-canvas', 'game_interactive', '2D canvas / WebGL + TypeScript', 'Canvas game on Vite with a fixed-timestep loop',
    'Best for 2D browser games with a hand-written loop and no engine overhead.',
    'No engine: sprites, collisions, audio and scenes are all yours to build.',
  {
    language: 'typescript-node', frontend: 'canvas-vite', backend: 'tick-engine', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'vitest',
  }),
  p('game-three', 'game_interactive', '3D WebGL scene (Three.js)', 'Three.js scene with Rapier physics',
    'Best for 3D scenes, visualisations and physics toys in the browser.',
    '3D assets and performance tuning take time, and phone GPUs limit scene size.',
  {
    language: 'typescript-node', frontend: 'threejs', backend: 'physics-workers', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', testing: 'vitest',
  }),

  // custom
  p('custom-polyglot', 'custom', 'Polyglot monorepo', 'TypeScript, Python and Go or Rust in one repo; you decide the rest',
    'Best for repos that combine TypeScript, Python and Go or Rust parts.',
    'Several toolchains to set up and keep working from the repo root.',
  {
    language: 'agent', frontend: 'agent', backend: 'agent', database: 'agent', auth: 'agent', deploy: 'agent',
  }, [], null, OPEN),
  p('custom-blank', 'custom', 'Blank project', 'Only the project docs; the agent proposes a stack in the Bootstrap ticket',
    'Best for starting from the project docs alone and reviewing the stack the agent proposes.',
    'Nothing is set up until the Bootstrap ticket runs and you approve its worktree.yml.',
  {
    language: 'agent', frontend: 'agent', backend: 'agent', database: 'agent', auth: 'agent', deploy: 'agent',
  }, [], null, OPEN),
];

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((x) => x.id === id);
}

export function presetsForType(type: string): PresetDef[] {
  return PRESETS.filter((x) => x.type === type);
}

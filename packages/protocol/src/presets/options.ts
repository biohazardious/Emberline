/** Project types, stack dimensions and their options. Data only. */
import type {
  ProjectTypeDef,
  ProjectTypeId,
  StackDimensionDef,
  StackDimensionId,
  StackOption,
  VersionPolicy,
  WorktreeHints,
} from './types.js';

export const VERSION_POLICIES: readonly VersionPolicy[] = [
  {
    id: 'Latest Stable / LTS',
    label: 'Latest Stable / LTS (Recommended)',
    hint: 'Use current stable / LTS releases without pinning legacy versions',
  },
  {
    id: 'Bleeding Edge / Latest Release',
    label: 'Bleeding Edge / Latest Release',
    hint: 'Target the newest upstream language & framework releases',
  },
  {
    id: 'Environment Default (Auto-Detect)',
    label: 'Environment Default (Auto-Detect)',
    hint: 'Use the runtime versions installed in the runner environment',
  },
  {
    id: 'Version-Agnostic (Unconstrained)',
    label: 'Version-Agnostic (Unconstrained)',
    hint: 'Do not specify version constraints in blueprint',
  },
];

export const PROJECT_TYPES: readonly ProjectTypeDef[] = [
  {
    id: 'fullstack',
    label: 'Full-Stack Platform',
    description: 'Frontend, backend API and database in one repo (portals, ERP/CRM, workflow systems)',
    icon: 'Building',
    archNotes:
      '- Organize workspace as a modular monorepo (`apps/web`, `apps/api`, `packages/shared`).\n- Validate all API payloads and contracts with shared schemas.\n- Include automated integration and UI tests with every feature.',
  },
  {
    id: 'web_saas',
    label: 'Web App / SaaS',
    description: 'Dashboards, multi-step forms, incident tracking and client web apps',
    icon: 'Globe',
    archNotes:
      '- Prioritize responsive layouts, accessible form validation, and clear state management.\n- Keep UI components modular and reusable.\n- Validate all user inputs on both client and server.',
  },
  {
    id: 'static_site',
    label: 'Static Website',
    description: 'Landing pages, portfolios, docs and blogs served as plain files',
    icon: 'FileText',
    archNotes:
      '- Ship semantic, accessible HTML with a responsive layout.\n- Keep assets small; no runtime server is required.\n- Every page must work without JavaScript where practical.',
  },
  {
    id: 'api_service',
    label: 'Backend API / Microservice',
    description: 'REST, GraphQL or gRPC service, background workers or a data pipeline',
    icon: 'Zap',
    archNotes:
      '- Separate transport/HTTP handlers, domain services, and repository/data access layers.\n- Enforce strict request/response schema validation and structured JSON logging.\n- Provide a `/health` endpoint and API documentation.',
  },
  {
    id: 'ai_agents',
    label: 'AI Agents / Orchestrator',
    description: 'Multi-agent systems, RAG pipelines, MCP servers and tool suites',
    icon: 'Bot',
    archNotes:
      '- Keep agent prompts, tools and orchestration separate and individually testable.\n- Validate every tool input and output with schemas.\n- Log model calls and tool results so runs can be replayed.',
  },
  {
    id: 'mobile_desktop',
    label: 'Desktop / Mobile App',
    description: 'Native, hybrid or cross-platform apps for phones and desktops',
    icon: 'Smartphone',
    archNotes:
      '- Keep platform shell code thin; put logic in shared, testable modules.\n- Design for offline use and slow networks.\n- Respect platform conventions for navigation and permissions.',
  },
  {
    id: 'cli_tool',
    label: 'CLI / Automation Tool',
    description: 'Command-line tools, TUIs, system and infrastructure automation',
    icon: 'Terminal',
    archNotes:
      '- Provide clear subcommands, `--help` and meaningful exit codes.\n- Make destructive actions explicit and support a dry-run mode.\n- Keep output machine-readable behind a flag.',
  },
  {
    id: 'embedded_iot',
    label: 'Embedded / IoT Firmware',
    description: 'Microcontroller firmware, hardware tools and connected devices',
    icon: 'Cpu',
    archNotes:
      '- Isolate hardware access behind a thin HAL so logic can be tested on the host.\n- Budget RAM, flash and power explicitly.\n- Never block the main loop; handle watchdog and brown-out paths.',
  },
  {
    id: 'library',
    label: 'SDK / Package Library',
    description: 'Reusable libraries and SDKs published to a package registry',
    icon: 'Package',
    archNotes:
      '- Keep the public API small, typed and documented; treat changes as semver events.\n- Ship examples and keep them compiling in CI.\n- Avoid heavy runtime dependencies.',
  },
  {
    id: 'game_interactive',
    label: 'Game / Interactive Canvas',
    description: '2D/3D WebGL, canvas, physics simulations and browser games',
    icon: 'Gamepad2',
    archNotes:
      '- Separate simulation (fixed timestep) from rendering.\n- Load assets through one manager with loading and error states.\n- Support keyboard, pointer and touch input.',
  },
  {
    id: 'custom',
    label: 'Custom Project',
    description: 'Tailored or polyglot architecture with your own workflow',
    icon: 'Layers',
    archNotes: '- Document each component and how they communicate in PROJECT.md.\n- Keep build and test commands working from the repo root.',
  },
];

// Type groups used to scope options.
const WEB: ProjectTypeId[] = ['fullstack', 'web_saas'];
const WEBISH: ProjectTypeId[] = ['fullstack', 'web_saas', 'static_site', 'custom'];
const ALL: ProjectTypeId[] = PROJECT_TYPES.map((t) => t.id);

const PNPM: WorktreeHints = { setup: 'pnpm install --frozen-lockfile', build: 'pnpm build', test: 'pnpm test', lint: 'pnpm lint' };

function o(id: string, label: string, types: readonly ProjectTypeId[], worktree?: WorktreeHints): StackOption {
  return worktree ? { id, label, types, worktree } : { id, label, types };
}

const frontend: StackOption[] = [
  o('react-vite', 'React + Vite', ['fullstack', 'web_saas', 'ai_agents', 'mobile_desktop', 'custom'], {
    ...PNPM,
    service: 'pnpm dev --port $PORT --host 0.0.0.0',
  }),
  o('nextjs', 'Next.js (App Router)', WEB, { ...PNPM, service: 'pnpm dev -p $PORT -H 0.0.0.0' }),
  o('vue-vite', 'Vue + Vite', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('nuxt', 'Nuxt', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('sveltekit', 'SvelteKit', ['fullstack', 'web_saas', 'custom'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('solid-vite', 'SolidJS + Vite', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('angular', 'Angular', WEB, { ...PNPM, service: 'pnpm start --port $PORT --host 0.0.0.0' }),
  o('htmx', 'HTMX + server templates', WEB),
  o('astro', 'Astro', ['web_saas', 'static_site'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  // static_site
  o('plain-html', 'Plain HTML/CSS/JS', ['static_site'], { service: 'python3 -m http.server $PORT --bind 0.0.0.0' }),
  o('vite-vanilla', 'Vite (vanilla)', ['static_site', 'game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('eleventy', 'Eleventy (11ty)', ['static_site'], { ...PNPM, service: 'pnpm exec eleventy --serve --port $PORT' }),
  // api / ai
  o('openapi-docs', 'OpenAPI docs UI (headless API)', ['api_service']),
  o('mcp-inspector', 'MCP Inspector / CLI status', ['ai_agents']),
  o('cli-stream', 'CLI / TUI stream', ['ai_agents', 'custom']),
  // mobile / desktop
  o('react-native-expo', 'React Native + Expo', ['mobile_desktop'], { ...PNPM, service: 'pnpm exec expo start --web --port $PORT' }),
  o('flutter', 'Flutter widgets', ['mobile_desktop'], { setup: 'flutter pub get', build: 'flutter build web', test: 'flutter test', lint: 'flutter analyze' }),
  // cli
  o('commander-clack', 'Commander / Clack (Node)', ['cli_tool'], PNPM),
  o('cobra-bubbletea', 'Cobra + BubbleTea (Go)', ['cli_tool']),
  o('clap-ratatui', 'Clap + Ratatui (Rust)', ['cli_tool']),
  o('typer-rich', 'Typer + Rich (Python)', ['cli_tool']),
  o('bash-subcommands', 'Bash subcommands', ['cli_tool']),
  // embedded
  o('serial-console', 'Serial console / Web-Serial', ['embedded_iot']),
  o('captive-portal', 'Captive portal / web dashboard', ['embedded_iot']),
  o('oled-status', 'OLED / display status', ['embedded_iot']),
  // library
  o('docs-vitepress', 'VitePress docs', ['library'], { ...PNPM, service: 'pnpm exec vitepress dev --port $PORT --host 0.0.0.0' }),
  o('docs-mkdocs', 'MkDocs site', ['library'], { service: 'mkdocs serve -a 0.0.0.0:$PORT' }),
  o('storybook', 'Storybook playground', ['library'], { service: 'pnpm exec storybook dev -p $PORT' }),
  o('rustdoc', 'rustdoc + example binaries', ['library']),
  // game
  o('canvas-vite', 'HTML5 Canvas + Vite', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('phaser', 'Phaser 3', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('pixijs', 'PixiJS', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('threejs', 'Three.js / React Three Fiber', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('babylonjs', 'Babylon.js', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('kaplay', 'Kaplay', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
];

const backend: StackOption[] = [
  o('fastify', 'Fastify + Zod', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom'], PNPM),
  o('hono', 'Hono', ['fullstack', 'web_saas', 'api_service', 'custom'], PNPM),
  o('nestjs', 'NestJS', ['fullstack', 'api_service'], PNPM),
  o('express', 'Express + TypeScript', ['fullstack', 'web_saas', 'api_service'], PNPM),
  o('trpc-fastify', 'tRPC + Fastify', ['fullstack', 'api_service'], PNPM),
  o('nextjs-routes', 'Next.js route handlers / server actions', WEB, PNPM),
  o('sveltekit-server', 'SvelteKit server routes', ['web_saas', 'fullstack'], PNPM),
  o('nitro', 'Nuxt / Nitro server', ['fullstack'], PNPM),
  o('supabase-functions', 'Supabase edge functions', ['web_saas']),
  o('fastapi', 'FastAPI + Pydantic', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('django', 'Django / Django Ninja', ['fullstack', 'api_service'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('go-http', 'Go (net/http, Chi, gRPC)', ['fullstack', 'api_service', 'custom'], { setup: 'go mod download', build: 'go build ./...', test: 'go test ./...' }),
  o('rust-axum', 'Rust (Axum + Tokio)', ['fullstack', 'api_service', 'custom'], { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' }),
  o('aspnet', 'ASP.NET Core Web API', ['fullstack', 'api_service'], { setup: 'dotnet restore', build: 'dotnet build', test: 'dotnet test' }),
  o('spring-boot', 'Spring Boot', ['fullstack', 'api_service']),
  o('agent-router', 'Agent router + provider SDKs', ['ai_agents']),
  o('mcp-sdk', 'MCP SDK (stdio / SSE) + Zod', ['ai_agents'], PNPM),
  o('tauri-core', 'Tauri core (Rust IPC)', ['mobile_desktop'], { build: 'cargo build', test: 'cargo test' }),
  o('electron-main', 'Electron main + preload IPC', ['mobile_desktop'], PNPM),
  o('capacitor-bridge', 'Capacitor native bridge', ['mobile_desktop'], PNPM),
  o('expo-modules', 'Expo native modules / REST sync', ['mobile_desktop'], PNPM),
  o('os-exec', 'OS / system integration', ['cli_tool']),
  o('platformio-arduino', 'PlatformIO / Arduino (ESP32, I2C, SPI)', ['embedded_iot'], { build: 'pio run', test: 'pio test' }),
  o('esp-idf', 'ESP-IDF + FreeRTOS (Wi-Fi, BLE, MQTT)', ['embedded_iot'], { build: 'idf.py build' }),
  o('stm32-hal', 'STM32 / RP2040 HAL', ['embedded_iot'], { build: 'cmake --build build' }),
  o('typed-core', 'Typed SDK core', ['library']),
  o('plugin-sdk', 'Plugin / adapter SDK', ['library']),
  o('tick-engine', 'Deterministic tick engine + Web Audio', ['game_interactive']),
  o('ws-multiplayer', 'WebSockets multiplayer server', ['game_interactive'], PNPM),
  o('physics-workers', 'Physics in Web Workers (Rapier)', ['game_interactive']),
];

const database: StackOption[] = [
  o('sqlite-drizzle', 'SQLite + Drizzle ORM', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-drizzle', 'PostgreSQL + Drizzle ORM', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-prisma', 'PostgreSQL + Prisma', ['fullstack', 'web_saas', 'api_service', 'custom']),
  o('postgres-sqlalchemy', 'PostgreSQL + SQLAlchemy', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-sqlc', 'PostgreSQL + sqlc / pgx', ['fullstack', 'api_service', 'custom']),
  o('postgres-sqlx', 'PostgreSQL / SQLite + SQLx', ['api_service', 'custom']),
  o('supabase-db', 'Supabase (Postgres)', ['fullstack', 'web_saas', 'custom']),
  o('firestore', 'Firebase / Firestore', ['web_saas', 'mobile_desktop']),
  o('mysql', 'MySQL / MariaDB', ['fullstack', 'api_service', 'custom']),
  o('mongodb', 'MongoDB', ['fullstack', 'api_service', 'custom']),
  o('redis', 'Redis', ['api_service', 'fullstack', 'custom']),
  o('pgvector', 'PostgreSQL + pgvector', ['ai_agents']),
  o('qdrant', 'Qdrant vector store', ['ai_agents']),
  o('local-index', 'SQLite / local knowledge index', ['ai_agents']),
  o('indexeddb', 'IndexedDB / LocalStorage', ['web_saas', 'game_interactive', 'mobile_desktop', 'static_site']),
  o('local-sqlite', 'Local SQLite / JSON store', ['mobile_desktop', 'cli_tool', 'custom']),
  o('expo-sqlite', 'expo-sqlite / MMKV', ['mobile_desktop']),
  o('drift', 'Drift (SQLite)', ['mobile_desktop']),
  o('config-files', 'TOML / YAML / JSON config files', ['cli_tool', 'library']),
  o('nvs-flash', 'NVS / EEPROM flash storage', ['embedded_iot']),
  o('littlefs', 'LittleFS / SPIFFS', ['embedded_iot']),
  o('external-flash', 'External SPI NOR flash', ['embedded_iot']),
  o('in-memory', 'Stateless / in-memory', ['library', 'cli_tool']),
  o('storage-adapters', 'Pluggable storage interface', ['library']),
  o('sqlite-leaderboard', 'SQLite leaderboard API', ['game_interactive']),
];

const AUTH_WEB = ['fullstack', 'web_saas', 'custom'] as const;
const auth: StackOption[] = [
  o('email-password', 'Email + password', AUTH_WEB),
  o('oauth-provider', 'OAuth via provider (Google, GitHub…)', ['fullstack', 'web_saas', 'mobile_desktop', 'custom']),
  o('magic-link', 'Magic link / one-time code', AUTH_WEB),
  o('passkeys', 'Passkeys (WebAuthn)', AUTH_WEB),
  o('clerk', 'Clerk', AUTH_WEB),
  o('auth0', 'Auth0', ['fullstack', 'web_saas', 'api_service', 'custom']),
  o('supabase-auth', 'Supabase Auth', AUTH_WEB),
  o('firebase-auth', 'Firebase Auth', ['web_saas', 'mobile_desktop', 'custom']),
  o('sso-oidc', 'Company SSO (OIDC / SAML)', ['fullstack', 'web_saas', 'api_service']),
  o('api-keys', 'API keys', ['api_service', 'ai_agents', 'fullstack']),
  o('jwt-bearer', 'JWT bearer tokens', ['api_service', 'ai_agents', 'fullstack']),
  o('biometric-local', 'Device biometrics / local lock', ['mobile_desktop']),
  o('device-flow', 'Device-flow login / API token', ['cli_tool']),
  o('device-token', 'Per-device token / mTLS', ['embedded_iot']),
  o('basic-gate', 'Shared password gate', ['static_site', 'game_interactive']),
];

const deploy: StackOption[] = [
  o('docker-compose', 'Docker Compose', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'cli_tool', 'custom']),
  o('static-hosting', 'Static hosting (GitHub Pages / Cloudflare Pages / Netlify)', ['static_site', 'web_saas', 'library', 'game_interactive']),
  o('vercel', 'Vercel', ['static_site', 'web_saas', 'fullstack']),
  o('fly-io', 'Fly.io', ['fullstack', 'web_saas', 'api_service', 'ai_agents']),
  o('vps-ssh', 'VPS over SSH', ['fullstack', 'web_saas', 'static_site', 'api_service', 'ai_agents', 'game_interactive', 'custom']),
  o('app-stores', 'App stores (Google Play / App Store)', ['mobile_desktop']),
  o('github-releases', 'GitHub Releases (binaries / installers)', ['cli_tool', 'mobile_desktop', 'library']),
  o('package-registry', 'Package registry (npm / PyPI / crates.io)', ['library', 'cli_tool', 'ai_agents']),
  o('firmware-flash', 'Firmware flashing / OTA updates', ['embedded_iot']),
];

const language: StackOption[] = [
  o('typescript-node', 'TypeScript (Node.js)', ALL.filter((t) => t !== 'embedded_iot'), PNPM),
  o('typescript-bun', 'TypeScript (Bun)', ['fullstack', 'web_saas', 'api_service', 'cli_tool', 'custom'], { setup: 'bun install --frozen-lockfile', build: 'bun run build', test: 'bun test' }),
  o('javascript', 'JavaScript (ESNext)', ['static_site', 'web_saas', 'game_interactive']),
  o('typescript-python', 'TypeScript + Python', ['fullstack', 'ai_agents', 'custom']),
  o('typescript-go', 'TypeScript + Go', ['fullstack', 'custom']),
  o('typescript-rust', 'TypeScript + Rust', ['fullstack', 'mobile_desktop', 'game_interactive', 'custom']),
  o('typescript-kotlin', 'TypeScript + Kotlin (Android)', ['mobile_desktop']),
  o('python', 'Python', ['api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('go', 'Go', ['api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { setup: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' }),
  o('rust', 'Rust', ['api_service', 'ai_agents', 'cli_tool', 'library', 'mobile_desktop', 'custom'], { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' }),
  o('csharp-dotnet', 'C# (.NET)', ['fullstack', 'api_service', 'library', 'custom'], { setup: 'dotnet restore', build: 'dotnet build', test: 'dotnet test' }),
  o('java-kotlin', 'Java / Kotlin', ['fullstack', 'api_service', 'custom']),
  o('dart', 'Dart', ['mobile_desktop']),
  o('bash-python', 'Python + Bash', ['cli_tool']),
  o('bash', 'Bash / POSIX shell', ['cli_tool']),
  o('c-cpp', 'C / C++', ['embedded_iot', 'cli_tool', 'library', 'game_interactive', 'custom'], { build: 'cmake --build build' }),
  o('embedded-rust', 'Embedded Rust (Embassy)', ['embedded_iot'], { build: 'cargo build', test: 'cargo test' }),
  o('elixir', 'Elixir', ['api_service'], { setup: 'mix deps.get', build: 'mix compile', test: 'mix test' }),
  o('gdscript', 'GDScript / C# (Godot)', ['game_interactive']),
];

const styling: StackOption[] = [
  o('tailwind', 'Tailwind CSS', [...WEBISH, 'game_interactive', 'mobile_desktop', 'ai_agents']),
  o('tailwind-shadcn', 'Tailwind CSS + shadcn/ui', WEB),
  o('radix-tailwind', 'Radix UI + Tailwind CSS', WEB),
  o('css-tokens', 'Modern CSS + design tokens', [...WEBISH, 'mobile_desktop', 'ai_agents', 'game_interactive']),
  o('css-modules', 'CSS Modules', ['fullstack', 'web_saas', 'custom']),
  o('plain-css', 'Plain CSS', ['static_site', 'game_interactive']),
  o('mantine', 'Mantine UI', WEB),
  o('mui', 'Material UI (MUI)', WEB),
  o('ansi-rich', 'ANSI / Rich terminal output', ['cli_tool']),
  o('docs-theme', 'Default docs theme', ['library']),
];

const testing: StackOption[] = [
  o('vitest-playwright', 'Vitest + Playwright', [...WEBISH, 'ai_agents', 'mobile_desktop', 'game_interactive', 'library', 'api_service'], { test: 'pnpm test' }),
  o('vitest-testing-library', 'Vitest + Testing Library', WEB, { test: 'pnpm test' }),
  o('playwright-e2e', 'Playwright end-to-end', [...WEBISH, 'game_interactive']),
  o('jest-cypress', 'Jest + Cypress', WEB, { test: 'pnpm test' }),
  o('vitest', 'Vitest', ['api_service', 'ai_agents', 'cli_tool', 'library', 'game_interactive', 'mobile_desktop', 'custom'], { test: 'pnpm test' }),
  o('pytest', 'Pytest', ['fullstack', 'api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { test: 'pytest' }),
  o('pytest-vitest-playwright', 'Pytest + Vitest + Playwright', ['fullstack'], { test: 'pytest' }),
  o('go-test', 'go test', ['fullstack', 'api_service', 'cli_tool', 'library', 'custom'], { test: 'go test ./...' }),
  o('cargo-test', 'cargo test', ['api_service', 'cli_tool', 'library', 'mobile_desktop', 'custom'], { test: 'cargo test' }),
  o('platformio-test', 'PlatformIO unit tests (host)', ['embedded_iot'], { test: 'pio test -e native' }),
  o('link-check', 'HTML validation + link check', ['static_site']),
];

const dim = (
  id: StackDimensionId,
  label: string,
  advanced: boolean,
  options: StackOption[],
): StackDimensionDef => ({ id, label, advanced, options });

export const STACK_DIMENSIONS: readonly StackDimensionDef[] = [
  dim('frontend', 'Frontend', false, frontend),
  dim('backend', 'Backend', false, backend),
  dim('database', 'Database', false, database),
  dim('auth', 'Authentication', false, auth),
  dim('deploy', 'Deploy target', false, deploy),
  dim('language', 'Language & runtime', true, language),
  dim('styling', 'Styling', true, styling),
  dim('testing', 'Testing', true, testing),
];


export function getProjectType(id: string): ProjectTypeDef | undefined {
  return PROJECT_TYPES.find((t) => t.id === id);
}

export function getDimension(id: StackDimensionId): StackDimensionDef | undefined {
  return STACK_DIMENSIONS.find((d) => d.id === id);
}

/** Options of one dimension that apply to a project type. */
export function optionsForType(dimension: StackDimensionId, type: ProjectTypeId): StackOption[] {
  const d = getDimension(dimension);
  return d ? d.options.filter((opt) => opt.types.includes(type)) : [];
}

export function findOption(dimension: StackDimensionId, id: string): StackOption | undefined {
  return getDimension(dimension)?.options.find((opt) => opt.id === id);
}

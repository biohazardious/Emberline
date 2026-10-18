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

function o(
  id: string,
  label: string,
  bestFor: string,
  types: readonly ProjectTypeId[],
  worktree?: WorktreeHints,
): StackOption {
  return worktree ? { id, label, bestFor, types, worktree } : { id, label, bestFor, types };
}

const frontend: StackOption[] = [
  o('react-vite', 'React + Vite', 'Interactive single-page apps and dashboards; the largest ecosystem, rendered in the browser.', ['fullstack', 'web_saas', 'ai_agents', 'mobile_desktop', 'custom'], {
    ...PNPM,
    service: 'pnpm dev --port $PORT --host 0.0.0.0',
  }),
  o('nextjs', 'Next.js (App Router)', 'React with routing, server rendering and API routes built in; good when pages need SEO.', WEB, { ...PNPM, service: 'pnpm dev -p $PORT -H 0.0.0.0' }),
  o('vue-vite', 'Vue + Vite', 'Vue single-page apps; approachable templates and a gentle learning curve.', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('nuxt', 'Nuxt', 'Vue with file routing, server rendering and server routes built in.', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('sveltekit', 'SvelteKit', 'Small, fast apps with little boilerplate; the compiler removes most framework code.', ['fullstack', 'web_saas', 'custom'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('solid-vite', 'SolidJS + Vite', 'Fine-grained reactive UIs with very small bundles; a smaller ecosystem than React.', WEB, { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('angular', 'Angular', 'Large teams that want one opinionated framework with forms, routing and DI built in.', WEB, { ...PNPM, service: 'pnpm start --port $PORT --host 0.0.0.0' }),
  o('htmx', 'HTMX + server templates', 'Server-rendered pages with a little interactivity and almost no client JavaScript.', WEB),
  o('astro', 'Astro', 'Content sites with a few interactive islands; ships static HTML by default.', ['web_saas', 'static_site'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  // static_site
  o('plain-html', 'Plain HTML/CSS/JS', 'No build step: edit a file and refresh. No components or templating.', ['static_site'], { service: 'python3 -m http.server $PORT --bind 0.0.0.0' }),
  o('vite-vanilla', 'Vite (vanilla)', 'Plain JavaScript with ES modules and hot reload; no framework.', ['static_site', 'game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('eleventy', 'Eleventy (11ty)', 'Markdown blogs and docs built from templates into plain HTML with almost no JS.', ['static_site'], { ...PNPM, service: 'pnpm exec eleventy --serve --port $PORT' }),
  // api / ai
  o('openapi-docs', 'OpenAPI docs UI (headless API)', 'Headless APIs: an OpenAPI page documents the endpoints and lets people try them.', ['api_service']),
  o('mcp-inspector', 'MCP Inspector / CLI status', "Checking an MCP server's tools and resources with the official inspector or a CLI.", ['ai_agents']),
  o('cli-stream', 'CLI / TUI stream', 'Agents watched from a terminal: streamed output, no web UI to build.', ['ai_agents', 'custom']),
  // mobile / desktop
  o('react-native-expo', 'React Native + Expo', "iOS and Android apps in React, with Expo's build tooling and over-the-air updates.", ['mobile_desktop'], { ...PNPM, service: 'pnpm exec expo start --web --port $PORT' }),
  o('flutter', 'Flutter widgets', 'One Dart UI codebase for mobile, desktop and web, drawn by Flutter itself.', ['mobile_desktop'], { setup: 'flutter pub get', build: 'flutter build web', test: 'flutter test', lint: 'flutter analyze' }),
  // cli
  o('commander-clack', 'Commander / Clack (Node)', 'Node CLIs: Commander parses subcommands, Clack draws friendly prompts.', ['cli_tool'], PNPM),
  o('cobra-bubbletea', 'Cobra + BubbleTea (Go)', 'Go CLIs with subcommands (Cobra) and interactive terminal screens (BubbleTea).', ['cli_tool']),
  o('clap-ratatui', 'Clap + Ratatui (Rust)', 'Rust CLIs with derived argument parsing (Clap) and full-screen TUIs (Ratatui).', ['cli_tool']),
  o('typer-rich', 'Typer + Rich (Python)', 'Python CLIs built from type hints (Typer) with tables, colours and progress bars (Rich).', ['cli_tool']),
  o('bash-subcommands', 'Bash subcommands', 'Small automation with no runtime to install; gets hard to test as it grows.', ['cli_tool']),
  // embedded
  o('serial-console', 'Serial console / Web-Serial', 'Debugging and controlling a device over USB serial, also from Chrome via Web Serial.', ['embedded_iot']),
  o('captive-portal', 'Captive portal / web dashboard', 'Wi-Fi setup and status pages served by the device itself.', ['embedded_iot']),
  o('oled-status', 'OLED / display status', 'Showing status on a small attached display, with no network needed.', ['embedded_iot']),
  // library
  o('docs-vitepress', 'VitePress docs', 'Library docs written in Markdown, built into a fast Vite-powered site.', ['library'], { ...PNPM, service: 'pnpm exec vitepress dev --port $PORT --host 0.0.0.0' }),
  o('docs-mkdocs', 'MkDocs site', 'Markdown docs for Python projects; pairs with mkdocstrings for API reference.', ['library'], { service: 'mkdocs serve -a 0.0.0.0:$PORT' }),
  o('storybook', 'Storybook playground', 'UI component libraries: browse and test each component on its own.', ['library'], { service: 'pnpm exec storybook dev -p $PORT' }),
  o('rustdoc', 'rustdoc + example binaries', 'Rust API docs generated from doc comments, plus runnable examples.', ['library']),
  // game
  o('canvas-vite', 'HTML5 Canvas + Vite', '2D games drawn directly on a canvas, with full control and no engine.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('phaser', 'Phaser 3', 'Complete 2D games: the engine handles scenes, sprites, physics and input.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('pixijs', 'PixiJS', 'Fast WebGL 2D rendering for games and visuals; you write the game logic.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('threejs', 'Three.js / React Three Fiber', '3D scenes in WebGL; React Three Fiber if the UI is already React.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('babylonjs', 'Babylon.js', '3D games with a full engine: physics, GUI and a scene inspector included.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
  o('kaplay', 'Kaplay', 'Quick, playful 2D games and game jams with a very small API.', ['game_interactive'], { ...PNPM, service: 'pnpm dev --port $PORT --host 0.0.0.0' }),
];

const backend: StackOption[] = [
  o('fastify', 'Fastify + Zod', 'Fast Node HTTP APIs with schema-validated routes (Zod) and a plugin system.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom'], PNPM),
  o('hono', 'Hono', 'Small TypeScript APIs that run on Node, Bun, Deno or edge runtimes.', ['fullstack', 'web_saas', 'api_service', 'custom'], PNPM),
  o('nestjs', 'NestJS', 'Large Node backends that want modules, dependency injection and decorators.', ['fullstack', 'api_service'], PNPM),
  o('express', 'Express + TypeScript', 'Simple Node APIs with the most middleware and tutorials available; minimal structure.', ['fullstack', 'web_saas', 'api_service'], PNPM),
  o('trpc-fastify', 'tRPC + Fastify', 'TypeScript frontends that call the backend with end-to-end types and no API schema.', ['fullstack', 'api_service'], PNPM),
  o('nextjs-routes', 'Next.js route handlers / server actions', 'Server code inside the Next.js app; no separate backend to run.', WEB, PNPM),
  o('sveltekit-server', 'SvelteKit server routes', 'Server logic and form actions inside the SvelteKit app.', ['web_saas', 'fullstack'], PNPM),
  o('nitro', 'Nuxt / Nitro server', 'Server routes inside the Nuxt app; deploys to many hosts.', ['fullstack'], PNPM),
  o('supabase-functions', 'Supabase edge functions', 'Small serverless functions next to a Supabase database, on the Deno runtime.', ['web_saas']),
  o('fastapi', 'FastAPI + Pydantic', 'Python APIs with type-checked requests and automatic OpenAPI docs.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('django', 'Django / Django Ninja', 'Python apps that want an ORM, admin panel and auth included.', ['fullstack', 'api_service'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('go-http', 'Go (net/http, Chi, gRPC)', 'Fast, low-memory HTTP and gRPC services compiled to a single binary.', ['fullstack', 'api_service', 'custom'], { setup: 'go mod download', build: 'go build ./...', test: 'go test ./...' }),
  o('rust-axum', 'Rust (Axum + Tokio)', 'Services where latency and memory matter; a strict compiler and slower builds.', ['fullstack', 'api_service', 'custom'], { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' }),
  o('aspnet', 'ASP.NET Core Web API', 'C# teams: fast, mature web APIs with strong tooling.', ['fullstack', 'api_service'], { setup: 'dotnet restore', build: 'dotnet build', test: 'dotnet test' }),
  o('spring-boot', 'Spring Boot', 'Java or Kotlin teams and enterprise integrations; a heavier runtime.', ['fullstack', 'api_service']),
  o('agent-router', 'Agent router + provider SDKs', 'Routing tasks between agents and model providers behind one service.', ['ai_agents']),
  o('mcp-sdk', 'MCP SDK (stdio / SSE) + Zod', 'Exposing tools and resources to AI clients over the Model Context Protocol.', ['ai_agents'], PNPM),
  o('tauri-core', 'Tauri core (Rust IPC)', 'Native work (files, OS APIs) in Rust, called from the UI over IPC.', ['mobile_desktop'], { build: 'cargo build', test: 'cargo test' }),
  o('electron-main', 'Electron main + preload IPC', 'Node and OS access in the main process, exposed to the UI through a preload script.', ['mobile_desktop'], PNPM),
  o('capacitor-bridge', 'Capacitor native bridge', 'Calling device APIs such as camera and storage from a web UI on mobile.', ['mobile_desktop'], PNPM),
  o('expo-modules', 'Expo native modules / REST sync', 'Device features through Expo modules, with data synced to a REST API.', ['mobile_desktop'], PNPM),
  o('os-exec', 'OS / system integration', 'Running system commands and working with files: the core of most CLIs.', ['cli_tool']),
  o('platformio-arduino', 'PlatformIO / Arduino (ESP32, I2C, SPI)', 'ESP32 and Arduino boards using Arduino libraries for I2C, SPI and sensors.', ['embedded_iot'], { build: 'pio run', test: 'pio test' }),
  o('esp-idf', 'ESP-IDF + FreeRTOS (Wi-Fi, BLE, MQTT)', "Espressif's own SDK with FreeRTOS, for Wi-Fi, BLE and MQTT on the ESP32.", ['embedded_iot'], { build: 'idf.py build' }),
  o('stm32-hal', 'STM32 / RP2040 HAL', 'The STM32 HAL or the RP2040 Pico SDK, for low-level control of the chip.', ['embedded_iot'], { build: 'cmake --build build' }),
  o('typed-core', 'Typed SDK core', 'A small, typed public API that the rest of the library builds on.', ['library']),
  o('plugin-sdk', 'Plugin / adapter SDK', 'Libraries that others extend with their own plugins or adapters.', ['library']),
  o('tick-engine', 'Deterministic tick engine + Web Audio', 'Fixed-timestep game logic that replays the same way every time, with Web Audio sound.', ['game_interactive']),
  o('ws-multiplayer', 'WebSockets multiplayer server', 'Real-time multiplayer: a server owns the game state and syncs the players.', ['game_interactive'], PNPM),
  o('physics-workers', 'Physics in Web Workers (Rapier)', 'Heavy physics off the main thread, so rendering stays smooth.', ['game_interactive']),
];

const database: StackOption[] = [
  o('sqlite-drizzle', 'SQLite + Drizzle ORM', 'One database file and no server to run; fits a single app instance. Typed queries.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-drizzle', 'PostgreSQL + Drizzle ORM', 'A server database for many users and app instances, with typed SQL-like queries.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-prisma', 'PostgreSQL + Prisma', 'Postgres through a schema file, a generated client and managed migrations.', ['fullstack', 'web_saas', 'api_service', 'custom']),
  o('postgres-sqlalchemy', 'PostgreSQL + SQLAlchemy', 'Postgres from Python with the most mature ORM and Alembic migrations.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'custom']),
  o('postgres-sqlc', 'PostgreSQL + sqlc / pgx', 'Go code generated from hand-written SQL; fast and explicit.', ['fullstack', 'api_service', 'custom']),
  o('postgres-sqlx', 'PostgreSQL / SQLite + SQLx', 'Rust with SQL checked against the database at compile time.', ['api_service', 'custom']),
  o('supabase-db', 'Supabase (Postgres)', 'Hosted Postgres with auth, storage and a dashboard; less to run yourself.', ['fullstack', 'web_saas', 'custom']),
  o('firestore', 'Firebase / Firestore', 'Hosted document data with live sync to clients; limited queries and joins.', ['web_saas', 'mobile_desktop']),
  o('mysql', 'MySQL / MariaDB', 'Teams or hosts that already run MySQL or MariaDB.', ['fullstack', 'api_service', 'custom']),
  o('mongodb', 'MongoDB', 'Flexible documents whose shape changes often; joins are weaker than in SQL.', ['fullstack', 'api_service', 'custom']),
  o('redis', 'Redis', 'Caches, queues, rate limits and sessions; not meant as the only data store.', ['api_service', 'fullstack', 'custom']),
  o('pgvector', 'PostgreSQL + pgvector', 'Embeddings next to regular data in Postgres: one database for RAG.', ['ai_agents']),
  o('qdrant', 'Qdrant vector store', 'A dedicated vector database for large or fast similarity search.', ['ai_agents']),
  o('local-index', 'SQLite / local knowledge index', 'A local SQLite index the server reads; no database service to run.', ['ai_agents']),
  o('indexeddb', 'IndexedDB / LocalStorage', "Data kept in the user's browser only: nothing to host, nothing shared between devices.", ['web_saas', 'game_interactive', 'mobile_desktop', 'static_site']),
  o('local-sqlite', 'Local SQLite / JSON store', "Data on the user's own device, in SQLite or JSON files.", ['mobile_desktop', 'cli_tool', 'custom']),
  o('expo-sqlite', 'expo-sqlite / MMKV', 'On-device storage in Expo apps: SQLite for records, MMKV for fast key-value data.', ['mobile_desktop']),
  o('drift', 'Drift (SQLite)', 'Typed, reactive SQLite queries in Flutter apps.', ['mobile_desktop']),
  o('config-files', 'TOML / YAML / JSON config files', 'Settings kept in human-editable TOML, YAML or JSON files.', ['cli_tool', 'library']),
  o('nvs-flash', 'NVS / EEPROM flash storage', 'Small key-value settings kept on the chip across reboots.', ['embedded_iot']),
  o('littlefs', 'LittleFS / SPIFFS', "Files such as configs, web assets or logs on the chip's flash.", ['embedded_iot']),
  o('external-flash', 'External SPI NOR flash', 'Bulk logs or assets on an external SPI flash chip.', ['embedded_iot']),
  o('in-memory', 'Stateless / in-memory', 'No storage: state lives only while the process runs.', ['library', 'cli_tool']),
  o('storage-adapters', 'Pluggable storage interface', 'Letting users plug in their own storage behind one interface.', ['library']),
  o('sqlite-leaderboard', 'SQLite leaderboard API', 'High scores saved through a small API backed by SQLite.', ['game_interactive']),
];

const AUTH_WEB = ['fullstack', 'web_saas', 'custom'] as const;
const auth: StackOption[] = [
  o('email-password', 'Email + password', 'Classic accounts you own; you handle hashing, resets and email delivery.', AUTH_WEB),
  o('oauth-provider', 'OAuth via provider (Google, GitHub…)', 'Sign-in with Google, GitHub and others; no passwords to store.', ['fullstack', 'web_saas', 'mobile_desktop', 'custom']),
  o('magic-link', 'Magic link / one-time code', 'Passwordless sign-in by email link or code; needs reliable email delivery.', AUTH_WEB),
  o('passkeys', 'Passkeys (WebAuthn)', 'Phishing-resistant sign-in with device keys; keep a fallback for older devices.', AUTH_WEB),
  o('clerk', 'Clerk', 'Hosted sign-in UI and user management; quick to add, paid beyond the free tier.', AUTH_WEB),
  o('auth0', 'Auth0', 'Hosted identity with enterprise features; the cost grows with users.', ['fullstack', 'web_saas', 'api_service', 'custom']),
  o('supabase-auth', 'Supabase Auth', 'Sign-in that pairs with a Supabase database and its row-level security.', AUTH_WEB),
  o('firebase-auth', 'Firebase Auth', 'Hosted sign-in for Firebase apps, including phone and social login.', ['web_saas', 'mobile_desktop', 'custom']),
  o('sso-oidc', 'Company SSO (OIDC / SAML)', "Business apps where staff sign in with the company's identity provider.", ['fullstack', 'web_saas', 'api_service']),
  o('api-keys', 'API keys', 'Machine clients and integrations calling your API.', ['api_service', 'ai_agents', 'fullstack']),
  o('jwt-bearer', 'JWT bearer tokens', 'Stateless API auth; a token is hard to revoke before it expires.', ['api_service', 'ai_agents', 'fullstack']),
  o('biometric-local', 'Device biometrics / local lock', 'Locking a local app with fingerprint or face; no accounts.', ['mobile_desktop']),
  o('device-flow', 'Device-flow login / API token', 'CLIs that sign in through a browser, then keep a token.', ['cli_tool']),
  o('device-token', 'Per-device token / mTLS', 'Each device proving itself to the backend with its own token or certificate.', ['embedded_iot']),
  o('basic-gate', 'Shared password gate', 'Hiding a site or game behind one shared password; not real accounts.', ['static_site', 'game_interactive']),
];

const deploy: StackOption[] = [
  o('docker-compose', 'Docker Compose', 'Running the app and its services on any machine with Docker.', ['fullstack', 'web_saas', 'api_service', 'ai_agents', 'cli_tool', 'custom']),
  o('static-hosting', 'Static hosting (GitHub Pages / Cloudflare Pages / Netlify)', 'Plain files served from a CDN; free or cheap, no server to maintain.', ['static_site', 'web_saas', 'library', 'game_interactive']),
  o('vercel', 'Vercel', 'Next.js and frontend apps with a preview deploy per branch; usage-based pricing.', ['static_site', 'web_saas', 'fullstack']),
  o('fly-io', 'Fly.io', 'Containers running close to users in several regions; you pay for running machines.', ['fullstack', 'web_saas', 'api_service', 'ai_agents']),
  o('vps-ssh', 'VPS over SSH', 'Your own server: full control, but you patch, back up and monitor it.', ['fullstack', 'web_saas', 'static_site', 'api_service', 'ai_agents', 'game_interactive', 'custom']),
  o('app-stores', 'App stores (Google Play / App Store)', 'Reaching phone users; needs developer accounts and passing store review.', ['mobile_desktop']),
  o('github-releases', 'GitHub Releases (binaries / installers)', 'Downloadable binaries and installers attached to tagged releases.', ['cli_tool', 'mobile_desktop', 'library']),
  o('package-registry', 'Package registry (npm / PyPI / crates.io)', 'Libraries and tools that people install with npm, pip or cargo.', ['library', 'cli_tool', 'ai_agents']),
  o('firmware-flash', 'Firmware flashing / OTA updates', 'Flashing devices over USB, with OTA updates for devices in the field.', ['embedded_iot']),
];

const language: StackOption[] = [
  o('typescript-node', 'TypeScript (Node.js)', 'Types on top of JavaScript, running on Node; one language for UI and server.', ALL.filter((t) => t !== 'embedded_iot'), PNPM),
  o('typescript-bun', 'TypeScript (Bun)', 'TypeScript on Bun: fast installs and a built-in test runner; less mature than Node.', ['fullstack', 'web_saas', 'api_service', 'cli_tool', 'custom'], { setup: 'bun install --frozen-lockfile', build: 'bun run build', test: 'bun test' }),
  o('javascript', 'JavaScript (ESNext)', 'No type-checking step; the quickest start for small sites and games.', ['static_site', 'web_saas', 'game_interactive']),
  o('typescript-python', 'TypeScript + Python', 'A TypeScript UI with a Python backend for AI or data work.', ['fullstack', 'ai_agents', 'custom']),
  o('typescript-go', 'TypeScript + Go', 'A TypeScript UI with a fast, compiled Go backend.', ['fullstack', 'custom']),
  o('typescript-rust', 'TypeScript + Rust', 'A TypeScript UI with Rust for native or performance-critical parts.', ['fullstack', 'mobile_desktop', 'game_interactive', 'custom']),
  o('typescript-kotlin', 'TypeScript + Kotlin (Android)', 'A TypeScript UI with Kotlin for Android-specific native code.', ['mobile_desktop']),
  o('python', 'Python', 'AI, data and scripting work, with the largest library ecosystem for it.', ['api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { setup: 'pip install -r requirements.txt', test: 'pytest' }),
  o('go', 'Go', 'Simple, fast compiled services and CLIs that ship as one binary.', ['api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { setup: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' }),
  o('rust', 'Rust', 'Speed and memory safety without a garbage collector; a steep learning curve.', ['api_service', 'ai_agents', 'cli_tool', 'library', 'mobile_desktop', 'custom'], { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' }),
  o('csharp-dotnet', 'C# (.NET)', 'C# teams: strong tooling and a fast runtime on every OS.', ['fullstack', 'api_service', 'library', 'custom'], { setup: 'dotnet restore', build: 'dotnet build', test: 'dotnet test' }),
  o('java-kotlin', 'Java / Kotlin', 'JVM teams and enterprise systems with a mature library ecosystem.', ['fullstack', 'api_service', 'custom']),
  o('dart', 'Dart', 'Flutter apps: one language for all their platforms.', ['mobile_desktop']),
  o('bash-python', 'Python + Bash', 'Shell glue for system steps, with Python for the real logic.', ['cli_tool']),
  o('bash', 'Bash / POSIX shell', 'Short automation on any Unix machine, with nothing to install.', ['cli_tool']),
  o('c-cpp', 'C / C++', 'Microcontrollers and native code with full hardware control; memory is managed by hand.', ['embedded_iot', 'cli_tool', 'library', 'game_interactive', 'custom'], { build: 'cmake --build build' }),
  o('embedded-rust', 'Embedded Rust (Embassy)', 'Memory-safe firmware with async tasks (Embassy); a younger ecosystem than C.', ['embedded_iot'], { build: 'cargo build', test: 'cargo test' }),
  o('elixir', 'Elixir', 'Highly concurrent, fault-tolerant services on the BEAM virtual machine.', ['api_service'], { setup: 'mix deps.get', build: 'mix compile', test: 'mix test' }),
  o('gdscript', 'GDScript / C# (Godot)', 'Games in the Godot engine; GDScript is quick to write, C# runs faster.', ['game_interactive']),
];

const styling: StackOption[] = [
  o('tailwind', 'Tailwind CSS', 'Utility classes in the markup; fast to build with consistent spacing and colours.', [...WEBISH, 'game_interactive', 'mobile_desktop', 'ai_agents']),
  o('tailwind-shadcn', 'Tailwind CSS + shadcn/ui', 'Tailwind plus accessible components copied into your repo, which you own and edit.', WEB),
  o('radix-tailwind', 'Radix UI + Tailwind CSS', 'Unstyled accessible Radix primitives, styled with Tailwind.', WEB),
  o('css-tokens', 'Modern CSS + design tokens', 'Hand-written CSS with variables for colours and spacing; no dependency.', [...WEBISH, 'mobile_desktop', 'ai_agents', 'game_interactive']),
  o('css-modules', 'CSS Modules', 'Plain CSS scoped per component, so class names never clash.', ['fullstack', 'web_saas', 'custom']),
  o('plain-css', 'Plain CSS', 'One or a few stylesheets: the simplest option, nothing to install.', ['static_site', 'game_interactive']),
  o('mantine', 'Mantine UI', 'A complete React component kit with hooks and theming; a less custom look.', WEB),
  o('mui', 'Material UI (MUI)', "Google's Material Design components for React; heavy but complete.", WEB),
  o('ansi-rich', 'ANSI / Rich terminal output', 'Colours, tables and progress bars in the terminal.', ['cli_tool']),
  o('docs-theme', 'Default docs theme', "The docs tool's default theme; no design work needed.", ['library']),
];

const testing: StackOption[] = [
  o('vitest-playwright', 'Vitest + Playwright', 'Unit tests in Vitest plus end-to-end tests in real browsers with Playwright.', [...WEBISH, 'ai_agents', 'mobile_desktop', 'game_interactive', 'library', 'api_service'], { test: 'pnpm test' }),
  o('vitest-testing-library', 'Vitest + Testing Library', 'Component tests that check behaviour the way a user sees it.', WEB, { test: 'pnpm test' }),
  o('playwright-e2e', 'Playwright end-to-end', 'End-to-end tests in real browsers only; slower, but high confidence.', [...WEBISH, 'game_interactive']),
  o('jest-cypress', 'Jest + Cypress', 'The long-standing Jest unit setup, with Cypress for browser tests.', WEB, { test: 'pnpm test' }),
  o('vitest', 'Vitest', 'Fast unit tests for TypeScript, compatible with the Jest API.', ['api_service', 'ai_agents', 'cli_tool', 'library', 'game_interactive', 'mobile_desktop', 'custom'], { test: 'pnpm test' }),
  o('pytest', 'Pytest', "Python's standard test runner, with fixtures and plugins.", ['fullstack', 'api_service', 'ai_agents', 'cli_tool', 'library', 'custom'], { test: 'pytest' }),
  o('pytest-vitest-playwright', 'Pytest + Vitest + Playwright', 'Pytest for the Python API, Vitest for the UI and Playwright end to end.', ['fullstack'], { test: 'pytest' }),
  o('go-test', 'go test', "Go's built-in tests and benchmarks; nothing to install.", ['fullstack', 'api_service', 'cli_tool', 'library', 'custom'], { test: 'go test ./...' }),
  o('cargo-test', 'cargo test', "Rust's built-in unit, integration and doc tests.", ['api_service', 'cli_tool', 'library', 'mobile_desktop', 'custom'], { test: 'cargo test' }),
  o('platformio-test', 'PlatformIO unit tests (host)', 'Firmware logic tested on your computer, without the board.', ['embedded_iot'], { test: 'pio test -e native' }),
  o('link-check', 'HTML validation + link check', 'Static sites: validate the HTML and catch broken links.', ['static_site']),
];

const dim = (
  id: StackDimensionId,
  label: string,
  advanced: boolean,
  affects: string,
  options: StackOption[],
): StackDimensionDef => ({ id, label, advanced, affects, options });

export const STACK_DIMENSIONS: readonly StackDimensionDef[] = [
  dim('frontend', 'Frontend', false, 'What people see and use (UI, CLI or docs): sets the build tooling, dev server and preview.', frontend),
  dim('backend', 'Backend', false, 'Where the logic runs: shapes the API, what the host must run and how it is tested.', backend),
  dim('database', 'Database', false, 'Where data lives: shapes setup, backups and deploy.', database),
  dim('auth', 'Authentication', false, 'Who can get in and how: adds accounts, secrets to manage and privacy duties.', auth),
  dim('deploy', 'Deploy target', false, 'Where it ships: the Deploy ticket prepares config and docs for this target.', deploy),
  dim('language', 'Language & runtime', true, 'The main language: sets the package manager and the build, lint and test commands.', language),
  dim('styling', 'Styling', true, 'How the interface looks: affects component code and visual consistency.', styling),
  dim('testing', 'Testing', true, 'How changes are verified: becomes the test check the build gate runs.', testing),
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

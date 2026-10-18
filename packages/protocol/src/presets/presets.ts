/** Starting-point presets per project type. Data only. */
import type { PresetDef } from './types.js';

const COMMON = [
  'Set up the project skeleton for the stack chosen in PROJECT.md.',
  'Make the `setup`, `build`, `test` and `services` commands in `.emberline/worktree.yml` real and passing.',
  'Keep PROJECT.md accurate as you decide things; items marked "decided by agent" must be filled in.',
];

function p(
  id: string,
  type: PresetDef['type'],
  label: string,
  description: string,
  choices: PresetDef['choices'],
  bootstrap: string[] = [],
  starter: PresetDef['starter'] = null,
): PresetDef {
  return { id, type, label, description, choices, starter, bootstrap: [...bootstrap, ...COMMON] };
}

export const PRESETS: readonly PresetDef[] = [
  // fullstack
  p('fullstack-react-fastify', 'fullstack', 'React + Fastify + PostgreSQL/SQLite', 'TypeScript monorepo with Vite, Fastify and Drizzle ORM', {
    language: 'typescript-node', frontend: 'react-vite', backend: 'fastify', database: 'postgres-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }, ['Use a pnpm monorepo: `apps/web`, `apps/api`, `packages/shared` (shared zod schemas).']),
  p('fullstack-nextjs', 'fullstack', 'Next.js full-stack + PostgreSQL', 'App Router, server actions and route handlers with Drizzle', {
    language: 'typescript-node', frontend: 'nextjs', backend: 'nextjs-routes', database: 'postgres-drizzle', auth: 'email-password', deploy: 'vercel', styling: 'tailwind-shadcn', testing: 'vitest-playwright',
  }),
  p('fullstack-react-fastapi', 'fullstack', 'React + FastAPI + PostgreSQL', 'TypeScript SPA paired with a Python FastAPI backend', {
    language: 'typescript-python', frontend: 'react-vite', backend: 'fastapi', database: 'postgres-sqlalchemy', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'pytest-vitest-playwright',
  }),
  p('fullstack-react-go', 'fullstack', 'React + Go API + PostgreSQL', 'High-throughput Go backend with a React frontend', {
    language: 'typescript-go', frontend: 'react-vite', backend: 'go-http', database: 'postgres-sqlc', auth: 'jwt-bearer', deploy: 'docker-compose', styling: 'tailwind', testing: 'go-test',
  }),
  p('fullstack-nuxt', 'fullstack', 'Nuxt full-stack platform', 'Nuxt / Vue 3 frontend with a Nitro server', {
    language: 'typescript-node', frontend: 'nuxt', backend: 'nitro', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // web_saas
  p('web-react-fastify', 'web_saas', 'React + Vite + Fastify portal', 'Interactive web portal with a light API and SQLite/Postgres', {
    language: 'typescript-node', frontend: 'react-vite', backend: 'fastify', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('web-nextjs-saas', 'web_saas', 'Next.js SaaS starter', 'App Router SaaS dashboard with auth, forms and Postgres', {
    language: 'typescript-node', frontend: 'nextjs', backend: 'nextjs-routes', database: 'postgres-drizzle', auth: 'clerk', deploy: 'vercel', styling: 'tailwind-shadcn', testing: 'vitest-playwright',
  }),
  p('web-sveltekit', 'web_saas', 'SvelteKit operational web app', 'Lean, fast forms and dashboards', {
    language: 'typescript-node', frontend: 'sveltekit', backend: 'sveltekit-server', database: 'sqlite-drizzle', auth: 'email-password', deploy: 'docker-compose', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('web-spa', 'web_saas', 'Frontend SPA only', 'Pure client-side app consuming an external API', {
    language: 'typescript-node', frontend: 'react-vite', backend: 'none', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // static_site
  p('static-plain', 'static_site', 'Plain HTML/CSS/JS', 'Three hand-written files, no build step, served by a tiny static server', {
    language: 'javascript', frontend: 'plain-html', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'none',
  }, ['The starter files `index.html`, `styles.css` and `script.js` already exist: build the site from the vision on top of them, keeping it build-free.'], 'static-plain'),
  p('static-vite', 'static_site', 'Vite (vanilla)', 'Vite with vanilla JS and a fast dev server', {
    language: 'javascript', frontend: 'vite-vanilla', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'css-tokens', testing: 'none',
  }, ['Scaffold a vanilla Vite project (no framework) with a pnpm lockfile.']),
  p('static-astro', 'static_site', 'Astro', 'Content-focused static site with islands', {
    language: 'typescript-node', frontend: 'astro', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'css-tokens', testing: 'link-check',
  }, ['Scaffold an Astro project with static output.']),
  p('static-eleventy', 'static_site', 'Eleventy', 'Simple template-driven static site generator', {
    language: 'javascript', frontend: 'eleventy', backend: 'none', database: 'none', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'link-check',
  }, ['Scaffold an Eleventy project that builds to `_site`.']),

  // api_service
  p('api-ts-fastify', 'api_service', 'TypeScript Fastify + PostgreSQL service', 'Typed REST service with Drizzle and Redis', {
    language: 'typescript-node', frontend: 'openapi-docs', backend: 'fastify', database: 'postgres-drizzle', auth: 'api-keys', deploy: 'docker-compose', testing: 'vitest',
  }),
  p('api-python-fastapi', 'api_service', 'Python FastAPI + async SQLAlchemy', 'Async Python service with Pydantic', {
    language: 'python', frontend: 'openapi-docs', backend: 'fastapi', database: 'postgres-sqlalchemy', auth: 'jwt-bearer', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('api-go', 'api_service', 'Go high-throughput API / gRPC', 'Go net/http or Chi with gRPC and sqlc', {
    language: 'go', frontend: 'none', backend: 'go-http', database: 'postgres-sqlc', auth: 'jwt-bearer', deploy: 'docker-compose', testing: 'go-test',
  }),
  p('api-rust-axum', 'api_service', 'Rust Axum + SQLx service', 'Tokio-based service with compile-time checked SQL', {
    language: 'rust', frontend: 'none', backend: 'rust-axum', database: 'postgres-sqlx', auth: 'jwt-bearer', deploy: 'fly-io', testing: 'cargo-test',
  }),

  // ai_agents
  p('agents-hybrid', 'ai_agents', 'TypeScript + Python multi-agent platform', 'React streaming console over an agent router with pgvector', {
    language: 'typescript-python', frontend: 'react-vite', backend: 'agent-router', database: 'pgvector', auth: 'api-keys', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('agents-python-rag', 'ai_agents', 'Python autonomous agent and RAG pipeline', 'FastAPI service with provider SDKs and a vector store', {
    language: 'python', frontend: 'cli-stream', backend: 'fastapi', database: 'qdrant', auth: 'api-keys', deploy: 'docker-compose', testing: 'pytest',
  }),
  p('agents-mcp-server', 'ai_agents', 'MCP server and tool suite', 'Model Context Protocol server with a local knowledge index', {
    language: 'typescript-node', frontend: 'mcp-inspector', backend: 'mcp-sdk', database: 'local-index', auth: 'none', deploy: 'package-registry', testing: 'vitest',
  }),

  // mobile_desktop
  p('app-tauri', 'mobile_desktop', 'Tauri desktop app (Rust + React)', 'Small native shell around a React UI', {
    language: 'typescript-rust', frontend: 'react-vite', backend: 'tauri-core', database: 'local-sqlite', auth: 'none', deploy: 'github-releases', styling: 'tailwind', testing: 'cargo-test',
  }),
  p('app-capacitor', 'mobile_desktop', 'Capacitor Android / hybrid app', 'React web UI wrapped for Android', {
    language: 'typescript-kotlin', frontend: 'react-vite', backend: 'capacitor-bridge', database: 'indexeddb', auth: 'none', deploy: 'app-stores', styling: 'tailwind', testing: 'vitest-playwright',
  }),
  p('app-expo', 'mobile_desktop', 'React Native / Expo app', 'Cross-platform mobile app with Expo Router', {
    language: 'typescript-node', frontend: 'react-native-expo', backend: 'expo-modules', database: 'expo-sqlite', auth: 'oauth-provider', deploy: 'app-stores', testing: 'vitest',
  }),
  p('app-flutter', 'mobile_desktop', 'Flutter cross-platform app', 'Material/Cupertino UI for mobile and desktop', {
    language: 'dart', frontend: 'flutter', backend: 'none', database: 'drift', auth: 'firebase-auth', deploy: 'app-stores',
  }),
  p('app-electron', 'mobile_desktop', 'Electron desktop studio', 'TypeScript Electron app with a React renderer', {
    language: 'typescript-node', frontend: 'react-vite', backend: 'electron-main', database: 'local-sqlite', auth: 'none', deploy: 'github-releases', styling: 'tailwind', testing: 'vitest-playwright',
  }),

  // cli_tool
  p('cli-python', 'cli_tool', 'Python CLI and system automation', 'Typer subcommands with Rich output and rollback manifests', {
    language: 'bash-python', frontend: 'typer-rich', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'package-registry', styling: 'ansi-rich', testing: 'pytest',
  }),
  p('cli-go', 'cli_tool', 'Go single-binary CLI / TUI', 'Cobra with BubbleTea interactive screens', {
    language: 'go', frontend: 'cobra-bubbletea', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'github-releases', testing: 'go-test',
  }),
  p('cli-rust', 'cli_tool', 'Rust CLI / TUI utility', 'Clap derive with Ratatui', {
    language: 'rust', frontend: 'clap-ratatui', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'github-releases', testing: 'cargo-test',
  }),
  p('cli-node', 'cli_tool', 'TypeScript / Node CLI', 'Commander or Clack prompts for DevOps automation', {
    language: 'typescript-node', frontend: 'commander-clack', backend: 'os-exec', database: 'config-files', auth: 'none', deploy: 'package-registry', testing: 'vitest',
  }),

  // embedded_iot
  p('iot-platformio', 'embedded_iot', 'ESP32 / Arduino / PlatformIO', 'Hardware tooling with a serial console', {
    language: 'c-cpp', frontend: 'serial-console', backend: 'platformio-arduino', database: 'nvs-flash', deploy: 'firmware-flash', testing: 'platformio-test',
  }),
  p('iot-esp-idf', 'embedded_iot', 'ESP-IDF IoT firmware', 'Wi-Fi/BLE/MQTT firmware with a captive portal', {
    language: 'c-cpp', frontend: 'captive-portal', backend: 'esp-idf', database: 'littlefs', auth: 'device-token', deploy: 'firmware-flash', testing: 'platformio-test',
  }),
  p('iot-stm32', 'embedded_iot', 'STM32 / RP2040 firmware', 'Embedded C/C++ or Rust on a Cortex-M part', {
    language: 'c-cpp', frontend: 'serial-console', backend: 'stm32-hal', database: 'external-flash', deploy: 'firmware-flash',
  }),

  // library
  p('lib-typescript', 'library', 'TypeScript universal SDK', 'ESM + CJS + type declarations with VitePress docs', {
    language: 'typescript-node', frontend: 'docs-vitepress', backend: 'typed-core', database: 'storage-adapters', deploy: 'package-registry', styling: 'docs-theme', testing: 'vitest',
  }),
  p('lib-python', 'library', 'Python SDK / PyPI package', 'Typed Python core with MkDocs', {
    language: 'python', frontend: 'docs-mkdocs', backend: 'typed-core', database: 'in-memory', deploy: 'package-registry', styling: 'docs-theme', testing: 'pytest',
  }),
  p('lib-rust', 'library', 'Rust crate', 'Library crate with rustdoc and examples', {
    language: 'rust', frontend: 'rustdoc', backend: 'typed-core', database: 'in-memory', deploy: 'package-registry', testing: 'cargo-test',
  }),

  // game_interactive
  p('game-canvas', 'game_interactive', '2D canvas / WebGL + TypeScript', 'Canvas game on Vite with a fixed-timestep loop', {
    language: 'typescript-node', frontend: 'canvas-vite', backend: 'tick-engine', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'vitest',
  }),
  p('game-three', 'game_interactive', '3D WebGL scene (Three.js)', 'Three.js scene with Rapier physics', {
    language: 'typescript-node', frontend: 'threejs', backend: 'physics-workers', database: 'indexeddb', auth: 'none', deploy: 'static-hosting', testing: 'vitest',
  }),

  // custom
  p('custom-polyglot', 'custom', 'Polyglot monorepo', 'TypeScript, Python and Go or Rust in one repo; you decide the rest', {
    language: 'agent', frontend: 'agent', backend: 'agent', database: 'agent', auth: 'agent', deploy: 'agent',
  }),
  p('custom-blank', 'custom', 'Blank project', 'Only the project docs; the agent proposes a stack in the Bootstrap ticket', {
    language: 'agent', frontend: 'agent', backend: 'agent', database: 'agent', auth: 'agent', deploy: 'agent',
  }),
];

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((x) => x.id === id);
}

export function presetsForType(type: string): PresetDef[] {
  return PRESETS.filter((x) => x.type === type);
}

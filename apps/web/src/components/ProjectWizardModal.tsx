import type {
  CreateProjectResponse,
  ProjectAppType,
  ProjectTechStack,
} from '@emberline/protocol';
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';

interface StackPreset {
  label: string;
  summary: string;
  stack: Omit<ProjectTechStack, 'versionPolicy'>;
}

interface LayerCatalog {
  language: string[];
  frontend: string[];
  backend: string[];
  database: string[];
  styling: string[];
  testing: string[];
}

interface LayerLabels {
  language: string;
  frontend: string;
  backend: string;
  database: string;
  styling: string;
  testing: string;
}

interface AppTypeProfile {
  id: ProjectAppType;
  icon: string;
  label: string;
  desc: string;
  layerLabels: LayerLabels;
  presets: StackPreset[];
  catalog: LayerCatalog;
  defaultArchNotes: string;
}

const VERSION_POLICIES: Array<{ id: string; label: string; hint: string }> = [
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

const STANDARD_LAYER_LABELS: LayerLabels = {
  language: 'Language & Runtime',
  frontend: 'Frontend / Client Framework',
  backend: 'Backend / API Framework',
  database: 'Database & ORM / Persistence',
  styling: 'UI / Styling System',
  testing: 'Testing & QA Suite',
};

const APP_TYPE_PROFILES: Record<ProjectAppType, AppTypeProfile> = {
  fullstack: {
    id: 'fullstack',
    icon: '🏢',
    label: 'Full-Stack Multi-Layer Platform',
    desc: 'Frontend + Backend API + Database monorepo (Portals, ERP/CRM, Workflow systems)',
    layerLabels: STANDARD_LAYER_LABELS,
    defaultArchNotes:
      '- Organize workspace as a modular monorepo (`apps/web`, `apps/api`, `packages/shared`).\n- Validate all API payloads and contracts with shared schemas.\n- Include automated integration and UI tests with every feature.',
    presets: [
      {
        label: 'React + Fastify + PostgreSQL/SQLite',
        summary: 'TypeScript monorepo with Vite, Fastify, and Drizzle ORM',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'React + Vite',
          backend: 'Fastify + Zod',
          database: 'PostgreSQL / SQLite + Drizzle ORM',
          styling: 'Tailwind CSS / Design Tokens',
          testing: 'Vitest + Playwright',
        },
      },
      {
        label: 'Next.js Full-Stack + PostgreSQL',
        summary: 'App Router, Server Actions / Route Handlers, and Drizzle/Prisma',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'Next.js App Router + React',
          backend: 'Next.js Route Handlers + Server Actions',
          database: 'PostgreSQL + Drizzle ORM',
          styling: 'Tailwind CSS + shadcn/ui',
          testing: 'Vitest + Playwright',
        },
      },
      {
        label: 'React + Python FastAPI + PostgreSQL',
        summary: 'TypeScript SPA frontend paired with a Python FastAPI backend',
        stack: {
          language: 'TypeScript + Python',
          frontend: 'React + Vite + TanStack Query',
          backend: 'FastAPI + Pydantic',
          database: 'PostgreSQL + SQLAlchemy / Alembic',
          styling: 'Tailwind CSS',
          testing: 'Pytest + Vitest + Playwright',
        },
      },
      {
        label: 'React + Go API + PostgreSQL',
        summary: 'High-throughput Go backend with a React + TypeScript frontend',
        stack: {
          language: 'Go + TypeScript',
          frontend: 'React + Vite',
          backend: 'Go (Chi / Gin / ConnectRPC)',
          database: 'PostgreSQL + sqlc / pgx',
          styling: 'Tailwind CSS',
          testing: 'go test + Playwright',
        },
      },
      {
        label: 'Vue / Nuxt Full-Stack Platform',
        summary: 'Nuxt / Vue 3 reactive frontend with Nitro / Node or Go backend',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'Vue + Nuxt',
          backend: 'Nitro / Fastify API',
          database: 'PostgreSQL / SQLite + Drizzle ORM',
          styling: 'Tailwind CSS / UnoCSS',
          testing: 'Vitest + Playwright',
        },
      },
    ],
    catalog: {
      language: [
        'TypeScript (Node.js)',
        'TypeScript (Bun)',
        'TypeScript + Python',
        'TypeScript + Go',
        'TypeScript + Rust',
        'C# (.NET) + TypeScript',
        'Java / Kotlin + TypeScript',
      ],
      frontend: [
        'React + Vite',
        'Next.js App Router + React',
        'Vue + Vite',
        'Nuxt',
        'SvelteKit',
        'SolidJS + Vite',
        'Angular',
        'HTMX + Server Templates',
      ],
      backend: [
        'Fastify + Zod',
        'Hono',
        'NestJS',
        'Express + TypeScript',
        'tRPC + Fastify',
        'Next.js Route Handlers',
        'FastAPI + Pydantic',
        'Django / Django Ninja',
        'Go (Chi / Gin / Fiber)',
        'Rust (Axum)',
        'ASP.NET Core Web API',
        'Spring Boot',
      ],
      database: [
        'PostgreSQL + Drizzle ORM',
        'SQLite + Drizzle ORM',
        'PostgreSQL + Prisma',
        'PostgreSQL + SQLAlchemy',
        'PostgreSQL + sqlc / pgx',
        'Supabase (Postgres + Auth)',
        'MySQL / MariaDB',
        'MongoDB',
        'Redis + PostgreSQL',
      ],
      styling: [
        'Tailwind CSS',
        'Tailwind CSS + shadcn/ui',
        'Modern CSS / Design Tokens',
        'CSS Modules',
        'Radix UI + Tailwind CSS',
        'Mantine UI',
        'Material UI (MUI)',
      ],
      testing: [
        'Vitest + Playwright',
        'Pytest + Vitest + Playwright',
        'Jest + Cypress',
        'go test + Playwright',
      ],
    },
  },

  web_saas: {
    id: 'web_saas',
    icon: '🌐',
    label: 'Web SaaS / Portal / Form App',
    desc: 'Dashboards, multi-step operational forms, incident tracking & client web apps',
    layerLabels: STANDARD_LAYER_LABELS,
    defaultArchNotes:
      '- Prioritize responsive layouts, accessible form validation, and clear state management.\n- Keep UI components modular and reusable.\n- Validate all user inputs on both client and server.',
    presets: [
      {
        label: 'React + Vite + Fastify Portal',
        summary: 'Fast interactive web portal with lightweight API & SQLite/Postgres',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'React + Vite',
          backend: 'Fastify + REST API',
          database: 'SQLite / PostgreSQL + Drizzle ORM',
          styling: 'Tailwind CSS / Design Tokens',
          testing: 'Vitest + Playwright',
        },
      },
      {
        label: 'Next.js SaaS Starter',
        summary: 'SSR/App Router SaaS dashboard with auth, forms, and Postgres',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'Next.js App Router + React',
          backend: 'Next.js Server Actions / API Routes',
          database: 'PostgreSQL + Drizzle / Prisma',
          styling: 'Tailwind CSS + shadcn/ui',
          testing: 'Vitest + Playwright',
        },
      },
      {
        label: 'SvelteKit Operational Web App',
        summary: 'Lean, fast form & dashboard web application',
        stack: {
          language: 'TypeScript',
          frontend: 'SvelteKit',
          backend: 'SvelteKit Server Routes',
          database: 'SQLite / Turso + Drizzle ORM',
          styling: 'Tailwind CSS',
          testing: 'Vitest + Playwright',
        },
      },
      {
        label: 'Frontend SPA Only (Static / External API)',
        summary: 'Pure client-side web app consuming external REST/GraphQL endpoints',
        stack: {
          language: 'TypeScript',
          frontend: 'React + Vite + TanStack Router',
          backend: 'None (Client-Side SPA / External API)',
          database: 'IndexedDB / LocalStorage',
          styling: 'Tailwind CSS',
          testing: 'Vitest + Playwright',
        },
      },
    ],
    catalog: {
      language: ['TypeScript (Node.js)', 'TypeScript (Bun)', 'JavaScript (ESNext)', 'TypeScript + Python'],
      frontend: ['React + Vite', 'Next.js App Router', 'Vue + Vite', 'Nuxt', 'SvelteKit', 'Astro + React', 'Angular'],
      backend: [
        'Fastify + Zod',
        'Hono',
        'Next.js Server Actions / API',
        'Express',
        'FastAPI',
        'Supabase Edge Functions',
        'None (Client-Side SPA)',
      ],
      database: [
        'SQLite + Drizzle ORM',
        'PostgreSQL + Drizzle ORM',
        'PostgreSQL + Prisma',
        'Supabase (Postgres)',
        'Firebase / Firestore',
        'IndexedDB / LocalStorage',
      ],
      styling: [
        'Tailwind CSS',
        'Tailwind CSS + shadcn/ui',
        'Modern CSS / Custom Variables',
        'CSS Modules',
        'Mantine UI',
      ],
      testing: ['Vitest + Playwright', 'Vitest + Testing Library', 'Playwright E2E'],
    },
  },

  api_service: {
    id: 'api_service',
    icon: '⚡',
    label: 'Backend API / Microservice',
    desc: 'REST/GraphQL/gRPC service, background workers, or distributed data pipeline',
    layerLabels: {
      language: 'Primary Language & Runtime',
      frontend: 'API Documentation / Admin Surface',
      backend: 'Server Framework & Protocol',
      database: 'Database, Queue & Cache',
      styling: 'Serialization & Wire Format',
      testing: 'API & Load Testing Suite',
    },
    defaultArchNotes:
      '- Separate transport/HTTP handlers, domain services, and repository/data access layers.\n- Enforce strict request/response schema validation and structured JSON logging.\n- Provide healthcheck (`/health`) and OpenAPI/Swagger or gRPC reflection endpoints.',
    presets: [
      {
        label: 'TypeScript Fastify + PostgreSQL Microservice',
        summary: 'High-performance Node/Bun REST service with Zod & OpenAPI',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'OpenAPI / Swagger UI (Headless API)',
          backend: 'Fastify + Zod',
          database: 'PostgreSQL + Drizzle ORM + Redis',
          styling: 'JSON REST + Server-Sent Events (SSE)',
          testing: 'Vitest + Supertest',
        },
      },
      {
        label: 'Python FastAPI + Async SQLAlchemy Service',
        summary: 'Modern async Python API service with Pydantic validation',
        stack: {
          language: 'Python',
          frontend: 'OpenAPI / Scalar Docs (Headless API)',
          backend: 'FastAPI + Pydantic + Uvicorn',
          database: 'PostgreSQL + SQLAlchemy + Redis',
          styling: 'JSON REST / WebSockets',
          testing: 'Pytest + httpx',
        },
      },
      {
        label: 'Go High-Throughput API / gRPC Service',
        summary: 'Compiled Go microservice with Chi/Gin or gRPC and sqlc',
        stack: {
          language: 'Go',
          frontend: 'None (Headless API / gRPC)',
          backend: 'Go net/http / Chi + gRPC',
          database: 'PostgreSQL (pgx / sqlc) + Redis',
          styling: 'JSON + Protocol Buffers (Protobuf)',
          testing: 'go test + race detector',
        },
      },
      {
        label: 'Rust Axum + SQLx Service',
        summary: 'Memory-safe, ultra-low-latency Rust backend service',
        stack: {
          language: 'Rust',
          frontend: 'None (Headless API)',
          backend: 'Axum + Tokio + Tower',
          database: 'PostgreSQL / SQLite + SQLx',
          styling: 'Serde JSON / gRPC (Tonic)',
          testing: 'cargo test + integration suites',
        },
      },
    ],
    catalog: {
      language: ['TypeScript (Node.js)', 'Python', 'Go', 'Rust', 'C# (.NET)', 'Java / Kotlin', 'Elixir'],
      frontend: [
        'OpenAPI / Swagger UI (Headless API)',
        'None (Headless Backend)',
        'GraphQL Playground',
        'Lightweight Admin Status Page',
      ],
      backend: [
        'Fastify + Zod',
        'Hono',
        'NestJS',
        'FastAPI + Pydantic',
        'Litestar (Python)',
        'Go (Chi / Gin / Fiber)',
        'Go gRPC / ConnectRPC',
        'Rust (Axum + Tokio)',
        'Rust (Actix Web)',
        'ASP.NET Core Minimal API',
        'Spring Boot',
      ],
      database: [
        'PostgreSQL + Drizzle ORM',
        'PostgreSQL + SQLAlchemy',
        'PostgreSQL + sqlc / pgx',
        'PostgreSQL + SQLx',
        'SQLite (WAL Mode)',
        'Redis + BullMQ / Celery',
        'ClickHouse / TimescaleDB',
        'MongoDB',
        'Kafka / NATS JetStream',
      ],
      styling: [
        'JSON REST + OpenAPI',
        'gRPC / Protocol Buffers',
        'GraphQL',
        'tRPC',
        'WebSockets / SSE Streaming',
      ],
      testing: ['Vitest + Supertest', 'Pytest + httpx', 'go test', 'cargo test', 'k6 Load Testing'],
    },
  },

  ai_agents: {
    id: 'ai_agents',
    icon: '🤖',
    label: 'Multi-Agent AI / Orchestrator',
    desc: 'Autonomous agent pipelines, MCP servers/tools, LLM routers & RAG systems',
    layerLabels: {
      language: 'Language & Runtime',
      frontend: 'Operator Console / Chat UI',
      backend: 'Agent Orchestrator & Tool Protocol',
      database: 'State, Memory & Vector Store',
      styling: 'UI & Streaming Telemetry',
      testing: 'Agent Eval & Integration Tests',
    },
    defaultArchNotes:
      '- Decouple model provider adapters, tool/MCP execution sandboxes, and orchestration state machines.\n- Stream agent events, tool invocations, and token telemetry in real time.\n- Persist all run transcripts, checkpoints, and tool outputs deterministically.',
    presets: [
      {
        label: 'TypeScript + Python Hybrid Multi-Agent Platform',
        summary: 'React telemetry console + Fastify/FastAPI orchestrator + MCP tools',
        stack: {
          language: 'TypeScript + Python',
          frontend: 'React + Vite Streaming Console',
          backend: 'Fastify / FastAPI + MCP Server & Agent Router',
          database: 'SQLite / PostgreSQL + pgvector',
          styling: 'Tailwind CSS Dark Operator UI',
          testing: 'Vitest + Pytest',
        },
      },
      {
        label: 'Python Autonomous Agent & RAG Pipeline',
        summary: 'Python-native multi-agent orchestrator with MCP & vector search',
        stack: {
          language: 'Python',
          frontend: 'React Dashboard or CLI/TUI Stream',
          backend: 'FastAPI + Anthropic/OpenAI/Gemini SDK + MCP',
          database: 'PostgreSQL (pgvector) / Qdrant + SQLite',
          styling: 'Streaming Markdown & Tool Trace UI',
          testing: 'Pytest + Deterministic Mock LLM Suites',
        },
      },
      {
        label: 'Model Context Protocol (MCP) Server & Tool Suite',
        summary: 'Dedicated MCP server exposing structured tools & resources to coding agents',
        stack: {
          language: 'TypeScript (Node.js) or Python',
          frontend: 'MCP Inspector / CLI Status',
          backend: 'MCP SDK (stdio / SSE transport) + Zod',
          database: 'SQLite / Local Knowledge Index',
          styling: 'Structured JSON-RPC / Markdown Prompts',
          testing: 'Vitest / Pytest MCP Tool Harness',
        },
      },
    ],
    catalog: {
      language: ['TypeScript + Python', 'Python', 'TypeScript (Node.js)', 'Rust + Python', 'Go'],
      frontend: [
        'React + Vite Streaming Console',
        'Next.js AI Chat & Workflow Studio',
        'Terminal TUI / CLI Stream',
        'Headless MCP / API Server',
      ],
      backend: [
        'Fastify + Custom Agent State Machine + MCP',
        'FastAPI + Async Agent Orchestrator + MCP',
        'Anthropic Claude SDK + OpenAI / Gemini Router',
        'LangGraph / LlamaIndex Workflows',
        'MCP Server SDK (stdio & HTTP/SSE)',
      ],
      database: [
        'SQLite + Drizzle ORM',
        'PostgreSQL + pgvector',
        'Qdrant / Chroma + PostgreSQL',
        'Redis Streams + PostgreSQL',
      ],
      styling: [
        'Tailwind CSS Dark Operator UI',
        'Custom Design Tokens + Monaco / Xterm',
        'Structured ANSI / Markdown Stream',
      ],
      testing: ['Vitest + Pytest', 'Pytest + Eval Harnesses', 'Vitest + Playwright'],
    },
  },

  mobile_desktop: {
    id: 'mobile_desktop',
    icon: '💻',
    label: 'Desktop / Mobile Application',
    desc: 'Tauri, Electron, Native GUI, Display/Overlay apps, Android APK, Flutter or React Native',
    layerLabels: {
      language: 'Language & Native Runtime',
      frontend: 'UI Layer / Windowing / Mobile View',
      backend: 'Native Shell / IPC / Device Bridge',
      database: 'Local Storage & Sync Engine',
      styling: 'UI Toolkit & Theme Engine',
      testing: 'Device / UI & Unit Testing',
    },
    defaultArchNotes:
      '- Keep native OS/device bridge calls isolated behind typed IPC or bridge modules.\n- Ensure smooth 60fps rendering, offline resilience, and clean package build scripts (e.g. `.apk`, `.deb`, `.AppImage`, `.dmg`, `.exe`).',
    presets: [
      {
        label: 'Tauri Desktop / Overlay App (Rust + React)',
        summary: 'Lightweight native desktop or screen-overlay app with Rust core',
        stack: {
          language: 'Rust + TypeScript',
          frontend: 'React + Vite Window / Overlay UI',
          backend: 'Tauri Core + Native OS / IPC Commands',
          database: 'Local SQLite / JSON Config Store',
          styling: 'Tailwind CSS / Frameless Native CSS',
          testing: 'cargo test + Vitest',
        },
      },
      {
        label: 'Android APK / Hybrid Mobile App (Capacitor / React)',
        summary: 'Web + Android Gradle pipeline producing downloadable .apk packages',
        stack: {
          language: 'TypeScript + Kotlin / Java (Android)',
          frontend: 'React + Vite Mobile Touch UI',
          backend: 'Capacitor / Android Gradle WebView Bridge',
          database: 'SQLite / IndexedDB Local Store',
          styling: 'Mobile-First CSS / Canvas Touch Controls',
          testing: 'Vitest + Android Gradle Assemble Verification',
        },
      },
      {
        label: 'React Native / Expo Mobile App',
        summary: 'Cross-platform iOS & Android application in TypeScript',
        stack: {
          language: 'TypeScript',
          frontend: 'React Native + Expo Router',
          backend: 'Expo Native Modules / REST Sync',
          database: 'expo-sqlite / MMKV',
          styling: 'NativeWind / React Native StyleSheet',
          testing: 'Jest + Maestro / Detox',
        },
      },
      {
        label: 'Flutter Cross-Platform App (Mobile & Desktop)',
        summary: 'Compiled Dart/Flutter native app for Android, iOS, Linux, Windows & macOS',
        stack: {
          language: 'Dart',
          frontend: 'Flutter Material / Cupertino Widgets',
          backend: 'Platform Channels / Local Service Layer',
          database: 'Drift (SQLite) / SharedPreferences',
          styling: 'Flutter ThemeData & Custom Shaders',
          testing: 'flutter test (Widget & Integration)',
        },
      },
      {
        label: 'Electron Desktop Studio (TypeScript + React)',
        summary: 'Full Node.js + Chromium desktop application',
        stack: {
          language: 'TypeScript (Node.js)',
          frontend: 'React + Vite Renderer',
          backend: 'Electron Main Process + Preload IPC',
          database: 'better-sqlite3 / Local File System',
          styling: 'Tailwind CSS',
          testing: 'Vitest + Playwright Electron',
        },
      },
    ],
    catalog: {
      language: [
        'Rust + TypeScript',
        'TypeScript + Kotlin (Android)',
        'TypeScript',
        'Dart',
        'Kotlin',
        'Swift',
        'C# (.NET MAUI / WPF / Avalonia)',
        'Python (PySide / Qt / Tkinter)',
        'C++ (Qt / SDL)',
      ],
      frontend: [
        'React + Vite',
        'React Native + Expo',
        'Flutter Widgets',
        'Jetpack Compose (Android)',
        'SwiftUI',
        'Avalonia UI / WPF',
        'Qt / QML',
      ],
      backend: [
        'Tauri Core + Rust IPC',
        'Capacitor + Android Gradle (.apk)',
        'Electron Main + Preload IPC',
        'Android SDK / Gradle Native',
        'Expo Native Modules',
        'Local Embedded Service',
      ],
      database: [
        'Local SQLite',
        'MMKV / SharedPreferences',
        'IndexedDB / LocalStorage',
        'Drift (SQLite)',
        'Room (Android SQLite)',
        'JSON Config & File Store',
      ],
      styling: [
        'Tailwind CSS',
        'Frameless / Transparent Overlay CSS',
        'NativeWind (React Native)',
        'Material 3 / Dynamic Color',
        'Custom Canvas / Hardware-Accelerated UI',
      ],
      testing: [
        'cargo test + Vitest',
        'Vitest + Gradle APK Build Check',
        'flutter test',
        'Jest + React Native Testing Library',
      ],
    },
  },

  cli_tool: {
    id: 'cli_tool',
    icon: '🛠️',
    label: 'CLI / System & Infra Automation',
    desc: 'Linux/OS system utilities, driver & package updaters, DevOps & shell/Python/Go/Rust CLI tools',
    layerLabels: {
      language: 'Language & Shell Runtime',
      frontend: 'CLI / TUI Interface & Flags',
      backend: 'OS / System / Driver / API Integration',
      database: 'State, Config & Backup Artifacts',
      styling: 'Output Formatting & Logging',
      testing: 'Verification & Dry-Run Test Suite',
    },
    defaultArchNotes:
      '- Support `--dry-run`, `--verbose`, `--json`, and `--help` flags out of the box.\n- Always validate system prerequisites, permissions, and checksums before mutating system state.\n- Create safe backups/rollbacks before modifying drivers, kernel modules, or system configs.',
    presets: [
      {
        label: 'Linux System, Kernel & Driver Automation (Python / Bash)',
        summary: 'Idempotent OS/driver installer & updater with dry-run, checksums, and rollback',
        stack: {
          language: 'Python + Bash',
          frontend: 'CLI Subcommands + Rich / ANSI Progress Output',
          backend: 'Linux Kernel / ZFS / Systemd / Package & Driver Tooling',
          database: 'Stateless + Checksum Manifests & Rollback Archives',
          styling: 'ANSI Color CLI + Structured JSON Log Mode',
          testing: 'Pytest + ShellCheck + Dry-Run Simulation Harness',
        },
      },
      {
        label: 'Go Single-Binary CLI / TUI Tool',
        summary: 'Zero-dependency static binary with Cobra CLI & BubbleTea TUI',
        stack: {
          language: 'Go',
          frontend: 'Cobra CLI + BubbleTea Interactive TUI',
          backend: 'OS Exec / Net / Docker / Kubernetes SDK',
          database: 'TOML / YAML Config + Local BoltDB / SQLite',
          styling: 'Lipgloss TUI + `--json` Machine Output',
          testing: 'go test + Golden CLI Output Snapshots',
        },
      },
      {
        label: 'Rust High-Speed CLI / TUI Utility',
        summary: 'Fast compiled CLI tool using Clap and Ratatui',
        stack: {
          language: 'Rust',
          frontend: 'Clap Derive CLI + Ratatui TUI',
          backend: 'Native POSIX / Async Tokio / Filesystem Tooling',
          database: 'TOML / JSON State Files',
          styling: 'ANSI Terminal UI + Structured Tracing',
          testing: 'cargo test + assert_cmd',
        },
      },
      {
        label: 'TypeScript / Node CLI & DevOps Automation',
        summary: 'Cross-platform developer CLI package',
        stack: {
          language: 'TypeScript (Node.js / Bun)',
          frontend: 'Commander / Clack Prompts CLI',
          backend: 'Node fs / child_process / REST & Git Automation',
          database: 'Local JSON / YAML Config',
          styling: 'Picocolors + Structured JSON Output',
          testing: 'Vitest CLI Execution Suite',
        },
      },
    ],
    catalog: {
      language: ['Python + Bash', 'Python', 'Bash / POSIX Shell', 'Go', 'Rust', 'TypeScript (Node.js / Bun)', 'C / C++'],
      frontend: [
        'CLI Flags + Rich / ANSI Progress',
        'Cobra CLI + BubbleTea TUI',
        'Clap CLI + Ratatui TUI',
        'Typer / Click (Python CLI)',
        'Argparse (Zero-Dependency Python)',
        'Commander / Clack Prompts',
        'Pure POSIX Flags (`getopts`)',
      ],
      backend: [
        'Linux Kernel / ZFS / Systemd / Storage Tooling',
        'Docker / Container / Kubernetes API',
        'Git / CI-CD / Release Automation',
        'Network / SSH / WireGuard / Firewall Tooling',
        'Hardware / PCI / GPU Driver Management',
      ],
      database: [
        'Stateless + Checksum & Backup Archives',
        'TOML / YAML / INI Configuration Files',
        'Local SQLite State DB',
        'JSON Lockfile & Audit Log',
      ],
      styling: [
        'ANSI Color CLI + `--json` Output Mode',
        'Interactive Terminal TUI',
        'Structured JSONL / Syslog Output',
      ],
      testing: [
        'Pytest + ShellCheck',
        'Bats (Bash Automated Testing) + ShellCheck',
        'go test',
        'cargo test + assert_cmd',
        'Vitest',
      ],
    },
  },

  embedded_iot: {
    id: 'embedded_iot',
    icon: '🔌',
    label: 'Embedded / IoT / Hardware Firmware',
    desc: 'ESP32, PlatformIO, Arduino, STM32, C/C++ firmware & I2C/SPI/UART chip tools',
    layerLabels: {
      language: 'Firmware Language & Toolchain',
      frontend: 'Host Console / Web-Serial / Display HUD',
      backend: 'MCU Framework & Hardware Buses',
      database: 'Non-Volatile Memory (EEPROM / NVS / Flash)',
      styling: 'Telemetry Protocol & Diagnostics',
      testing: 'Hardware-in-Loop / Bus & Unit Verification',
    },
    defaultArchNotes:
      '- Document exact pinouts, voltage levels, pull-up requirements, and bus addresses (I2C/SPI/UART/GPIO) in `PROJECT.md`.\n- Guard all EEPROM/NVS/Flash writes with CRC/checksum verification and dump-before-write safety.\n- Keep hardware abstraction (HAL) separate from protocol/packet logic so host unit tests can run without physical hardware.',
    presets: [
      {
        label: 'ESP32 / Arduino / PlatformIO Hardware & Chip Tool',
        summary: 'C/C++ firmware for I2C/SPI/UART chip reset, bus scanning & serial control',
        stack: {
          language: 'C / C++ (PlatformIO / Arduino / ESP-IDF)',
          frontend: 'Serial Command Console / Web-Serial / OLED Status',
          backend: 'ESP32 / MCU + I2C (Wire) / SPI / UART / GPIO HAL',
          database: 'EEPROM / NVS Flash + Hex Dump Snapshots',
          styling: 'Serial Hex/ASCII Telemetry + Embedded WebUI',
          testing: 'PlatformIO Unity + Host Protocol Simulator',
        },
      },
      {
        label: 'ESP-IDF Native IoT Firmware + Wi-Fi / BLE / MQTT',
        summary: 'Production FreeRTOS firmware on ESP32 with OTA and MQTT/HTTP telemetry',
        stack: {
          language: 'C / C++ (ESP-IDF / FreeRTOS)',
          frontend: 'Embedded Captive Portal / Web Dashboard',
          backend: 'ESP-IDF + Wi-Fi / BLE + MQTT / HTTP Server',
          database: 'NVS Partition + LittleFS / SPIFFS',
          styling: 'Compact JSON / CBOR Telemetry',
          testing: 'ESP-IDF Unity + Host CMake Tests',
        },
      },
      {
        label: 'STM32 / RP2040 Embedded C/C++ or Embedded Rust',
        summary: 'Bare-metal or RTOS microcontroller firmware',
        stack: {
          language: 'C / C++ (CMake / ARM GCC) or Embedded Rust (Embassy)',
          frontend: 'UART / RTT Debug Console / USB CDC',
          backend: 'STM32Cube HAL / RP2040 SDK / Embassy HAL',
          database: 'Internal Flash / External SPI NOR Flash',
          styling: 'Defmt / Binary Frame Protocol',
          testing: 'Host C/Rust Unit Suite + Logic Analyzer Traces',
        },
      },
    ],
    catalog: {
      language: [
        'C / C++ (PlatformIO / Arduino)',
        'C / C++ (ESP-IDF)',
        'C / C++ (ARM GCC / CMake)',
        'Embedded Rust (no_std / Embassy)',
        'MicroPython / CircuitPython',
        'C / C++ + Python Host Companion CLI',
      ],
      frontend: [
        'Serial Command Console (115200 baud)',
        'Web-Serial Browser Companion UI',
        'SSD1306 OLED / TFT Display HUD',
        'Embedded Wi-Fi Web Server Portal',
        'Python / Tauri Host Companion GUI',
      ],
      backend: [
        'ESP32 + I2C / SPI / UART / 1-Wire / GPIO',
        'ESP8266 / RP2040 / STM32 HAL',
        'FreeRTOS Tasks + Hardware Timers / Interrupts',
        'MODBUS / CAN Bus / RS-485',
        'Wi-Fi + BLE + MQTT / Matter',
      ],
      database: [
        'EEPROM / NVS Flash + Hex Dump Backups',
        'LittleFS / SPIFFS Flash Filesystem',
        'SD Card (FATFS) Logger',
        'Stateless Register Read/Write',
      ],
      styling: [
        'Serial Hex/ASCII Frame Dump',
        'Embedded Lightweight HTML/CSS Portal',
        'Binary Packet + CRC16/CRC32 Framing',
      ],
      testing: [
        'PlatformIO Unity + Host Protocol Simulator',
        'Host GCC/Clang C Unit Tests',
        'Pytest Serial Hardware-in-Loop Harness',
      ],
    },
  },

  library: {
    id: 'library',
    icon: '📦',
    label: 'SDK / Package Library',
    desc: 'Reusable package, protocol SDK, or shared component library',
    layerLabels: {
      language: 'Language & Target Runtimes',
      frontend: 'Documentation / Playground Surface',
      backend: 'Core API & Module Exports',
      database: 'State / Storage Adapters',
      styling: 'Build & Bundle Formats',
      testing: 'Unit, Type & Benchmark Suite',
    },
    defaultArchNotes:
      '- Maintain zero unnecessary runtime dependencies and strict semantic versioning.\n- Export full static types and clear API documentation for every public symbol.\n- Include comprehensive unit tests and edge-case property tests.',
    presets: [
      {
        label: 'TypeScript Universal SDK (ESM + CJS + d.ts)',
        summary: 'Zero-bloat TypeScript package for Node, Bun, and Browsers',
        stack: {
          language: 'TypeScript',
          frontend: 'Vitepress Docs / Interactive Examples',
          backend: 'Pure TypeScript Core + Zod Contracts',
          database: 'Pluggable Storage / In-Memory Adapter',
          styling: 'Dual ESM + CJS Bundle (tsup / unbuild)',
          testing: 'Vitest + Typecheck (`tsc --noEmit`)',
        },
      },
      {
        label: 'Python SDK / PyPI Package',
        summary: 'Typed Python library with sync & async client support',
        stack: {
          language: 'Python',
          frontend: 'MkDocs / CLI Examples',
          backend: 'Typed Python Core + Pydantic / httpx',
          database: 'In-Memory / Pluggable Backend',
          styling: 'PEP 621 `pyproject.toml` (uv / Hatch)',
          testing: 'Pytest + Mypy / Ruff',
        },
      },
      {
        label: 'Rust Crate / Library (+ Optional WASM / PyO3)',
        summary: 'High-performance Rust library crate',
        stack: {
          language: 'Rust',
          frontend: 'rustdoc + Example Binaries',
          backend: 'Cargo Library Crate + Serde',
          database: 'Zero-Copy / Custom Traits',
          styling: 'Cargo Crate + Optional wasm-bindgen',
          testing: 'cargo test + Criterion Benchmarks',
        },
      },
    ],
    catalog: {
      language: ['TypeScript', 'Python', 'Rust', 'Go', 'C / C++', 'C# (.NET NuGet)'],
      frontend: ['Vitepress / MkDocs Site', 'Storybook Playground', 'Example CLI / Demo App', 'None (Pure Library)'],
      backend: ['Typed SDK Core', 'Protocol & Parser Engine', 'UI Component Library', 'Plugin / Adapter SDK'],
      database: ['Stateless / In-Memory', 'Pluggable Storage Interface'],
      styling: ['ESM + CJS + .d.ts (tsup)', 'PyPI Wheel (`pyproject.toml`)', 'Cargo Crate', 'Go Module'],
      testing: ['Vitest + tsc', 'Pytest + Ruff + Mypy', 'cargo test + clippy', 'go test'],
    },
  },

  game_interactive: {
    id: 'game_interactive',
    icon: '🎮',
    label: 'Interactive Canvas / Simulation / Game',
    desc: '2D/3D WebGL, Canvas, Phaser/Three.js, physics simulation or mobile/web game',
    layerLabels: {
      language: 'Language & Scripting',
      frontend: 'Rendering & Scene Engine',
      backend: 'Physics, Audio & Multiplayer / Build Pipeline',
      database: 'Save State, Leaderboards & Assets',
      styling: 'Shaders, HUD & Visual Style',
      testing: 'Frame-Loop, Physics & Build Verification',
    },
    defaultArchNotes:
      '- Decouple deterministic simulation/physics update ticks from rendering frames.\n- Support responsive viewport scaling, keyboard/mouse/touch controls, and audio mute toggles.\n- Keep asset loading asynchronous with clear progress feedback.',
    presets: [
      {
        label: '2D HTML5 Canvas / WebGL + TypeScript (Vite)',
        summary: 'Fast 60fps 2D engine with Web Audio, particles, and optional mobile APK wrapper',
        stack: {
          language: 'TypeScript',
          frontend: 'HTML5 Canvas 2D / PixiJS / Phaser + Vite',
          backend: 'Custom Deterministic Loop + Web Audio API',
          database: 'LocalStorage / IndexedDB High-Scores & Replays',
          styling: 'Procedural Shaders / Pixel / Vector HUD Overlay',
          testing: 'Vitest Simulation Tests + Playwright',
        },
      },
      {
        label: '3D WebGL / WebGPU Scene (Three.js / R3F)',
        summary: 'Interactive 3D visualization, simulation, or game in the browser',
        stack: {
          language: 'TypeScript',
          frontend: 'Three.js / React Three Fiber + Vite',
          backend: 'Rapier3D Physics + Web Workers',
          database: 'IndexedDB / GLTF Asset Cache',
          styling: 'GLSL Shaders + HTML/CSS Glass HUD',
          testing: 'Vitest + Playwright WebGL Smoke Tests',
        },
      },
    ],
    catalog: {
      language: ['TypeScript', 'TypeScript + Rust (WASM)', 'GDScript / C# (Godot)', 'C++ / C#'],
      frontend: ['HTML5 Canvas + Vite', 'Phaser 3', 'PixiJS', 'Three.js / React Three Fiber', 'Babylon.js', 'Kaboom / Kaplay'],
      backend: ['Deterministic Tick Engine + Web Audio', 'WebSockets Multiplayer Server', 'Capacitor Android APK Wrapper', 'Web Workers Physics'],
      database: ['LocalStorage / IndexedDB', 'SQLite Leaderboard API'],
      styling: ['Canvas HUD + Custom Shaders', 'Tailwind CSS Overlay HUD'],
      testing: ['Vitest + Playwright', 'Deterministic State-Machine Tests'],
    },
  },

  custom: {
    id: 'custom',
    icon: '🧩',
    label: 'Custom Multi-Layer Project',
    desc: 'Tailored polyglot architecture and custom engineering workflow',
    layerLabels: STANDARD_LAYER_LABELS,
    defaultArchNotes:
      '- Document all service boundaries, build commands, and verification steps in `PROJECT.md`.\n- Validate inputs at system boundaries and maintain automated tests.',
    presets: [
      {
        label: 'Polyglot Monorepo (TypeScript + Python + Go/Rust)',
        summary: 'Flexible multi-service workspace tailored to your architecture',
        stack: {
          language: 'TypeScript / Python / Go / Rust',
          frontend: 'React + Vite or CLI/TUI',
          backend: 'Fastify / FastAPI / Custom Daemons',
          database: 'PostgreSQL / SQLite',
          styling: 'Tailwind CSS / Custom',
          testing: 'Vitest / Pytest / Native Test Suites',
        },
      },
    ],
    catalog: {
      language: [
        'TypeScript (Node.js)',
        'Python',
        'Go',
        'Rust',
        'C / C++',
        'C# (.NET)',
        'Java / Kotlin',
        'Bash / Shell',
      ],
      frontend: ['React + Vite', 'Next.js', 'Vue / Nuxt', 'SvelteKit', 'Tauri / Electron', 'CLI / TUI', 'None (Headless)'],
      backend: ['Fastify', 'FastAPI', 'Go net/http', 'Rust Axum', 'Node / Bun Daemon', 'PlatformIO / Embedded HAL'],
      database: ['PostgreSQL', 'SQLite', 'Redis', 'Supabase', 'EEPROM / NVS Flash', 'Stateless / Config Files'],
      styling: ['Tailwind CSS', 'Modern CSS', 'ANSI CLI / JSON', 'N/A'],
      testing: ['Vitest + Playwright', 'Pytest', 'go test', 'cargo test', 'ShellCheck / Bats'],
    },
  },
};

const APP_TYPE_LIST: AppTypeProfile[] = Object.values(APP_TYPE_PROFILES);

function TechStackComboField({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const appendOption = (opt: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      onChange(opt);
      return;
    }
    if (trimmed.toLowerCase().includes(opt.toLowerCase())) return;
    onChange(`${trimmed} + ${opt}`);
  };

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '5px' }}
    >
      <label
        className="drawer-label"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 0,
          lineHeight: 1.25,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <span className="muted" style={{ fontSize: '0.68rem', fontWeight: 400 }}>
          Select or type freely
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
        <input
          className="input"
          style={{ paddingRight: '52px', width: '100%' }}
          value={value}
          placeholder={placeholder ?? 'Choose from list or type custom…'}
          onFocus={() => setOpen(true)}
          onChange={(e) => onChange(e.target.value)}
        />
        <div
          style={{
            position: 'absolute',
            right: '4px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
          }}
        >
          {value && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 5px', fontSize: '0.72rem', opacity: 0.7 }}
              title="Clear field"
              onClick={() => onChange('')}
            >
              ×
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: '2px 6px', fontSize: '0.74rem' }}
            title="Toggle suggested options"
            onClick={() => setOpen((v) => !v)}
          >
            ▾
          </button>
        </div>
      </div>

      {open && options.length > 0 && (
        <div
          className="panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 40,
            maxHeight: '210px',
            overflowY: 'auto',
            padding: '4px',
            background: 'var(--surface, #16181d)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.45)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {options.map((opt) => {
            const isCurrent = value.trim().toLowerCase() === opt.toLowerCase();
            return (
              <div
                key={opt}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '6px',
                  padding: '5px 8px',
                  borderRadius: '4px',
                  fontSize: '0.78rem',
                  background: isCurrent ? 'var(--surface-hover)' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
              >
                <span style={{ flex: 1, fontWeight: isCurrent ? 600 : 400 }}>{opt}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{
                    padding: '1px 6px',
                    fontSize: '0.68rem',
                    border: '1px solid var(--border)',
                  }}
                  title={`Append "+ ${opt}" to current value`}
                  onClick={(e) => {
                    e.stopPropagation();
                    appendOption(opt);
                  }}
                >
                  + Add
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function previewBlueprint(input: {
  name: string;
  appType: ProjectAppType;
  description: string;
  techStack: ProjectTechStack;
  architectureNotes: string;
  referenceDocs: string;
}): string {
  const profile = APP_TYPE_PROFILES[input.appType] ?? APP_TYPE_PROFILES.custom;
  const stackLines = [
    input.techStack.versionPolicy &&
      `- **Release & Version Policy:** ${input.techStack.versionPolicy}`,
    input.techStack.language &&
      `- **${profile.layerLabels.language}:** ${input.techStack.language}`,
    input.techStack.frontend &&
      `- **${profile.layerLabels.frontend}:** ${input.techStack.frontend}`,
    input.techStack.backend &&
      `- **${profile.layerLabels.backend}:** ${input.techStack.backend}`,
    input.techStack.database &&
      `- **${profile.layerLabels.database}:** ${input.techStack.database}`,
    input.techStack.styling &&
      `- **${profile.layerLabels.styling}:** ${input.techStack.styling}`,
    input.techStack.testing &&
      `- **${profile.layerLabels.testing}:** ${input.techStack.testing}`,
  ]
    .filter(Boolean)
    .join('\n');

  return `# ${input.name || 'Untitled Project'} — Project Blueprint (\`PROJECT.md\`)

> **Application Type:** ${profile.label}
> **Managed By:** Emberline AI Coding Factory

## 1. Product Vision & Overview
${input.description.trim() || `${input.name || 'This project'} is a ${profile.label.toLowerCase()} built with the Emberline AI Coding Factory.`}

## 2. Technology Stack
${stackLines || '- Tech stack to be finalized with the System Architect agent.'}

## 3. Architecture & Engineering Standards
${input.architectureNotes.trim() || profile.defaultArchNotes}

## 4. Reference Specifications & Context
${input.referenceDocs.trim() || '- No external reference docs attached yet.'}
`;
}

export function ProjectWizardModal({
  open,
  runnerDown,
  onClose,
  onCreated,
}: {
  open: boolean;
  runnerDown?: boolean;
  onClose: () => void;
  onCreated: (res: CreateProjectResponse) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<'wizard' | 'manual'>('wizard');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [appType, setAppType] = useState<ProjectAppType>('fullstack');
  const [description, setDescription] = useState('');
  const [versionPolicy, setVersionPolicy] = useState<string>('Latest Stable / LTS');
  const [techStack, setTechStack] = useState<ProjectTechStack>(() => ({
    language: 'TypeScript (Node.js)',
    frontend: 'React + Vite',
    backend: 'Fastify + Zod',
    database: 'PostgreSQL / SQLite + Drizzle ORM',
    styling: 'Tailwind CSS / Design Tokens',
    testing: 'Vitest + Playwright',
    ...(APP_TYPE_PROFILES.fullstack.presets[0]?.stack ?? {}),
    versionPolicy: 'Latest Stable / LTS',
  }));
  const [architectureNotes, setArchitectureNotes] = useState(
    APP_TYPE_PROFILES.fullstack.defaultArchNotes,
  );
  const [referenceDocs, setReferenceDocs] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [seedStarterTickets, setSeedStarterTickets] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const activeProfile = APP_TYPE_PROFILES[appType] ?? APP_TYPE_PROFILES.custom;

  const handleSelectAppType = (nextType: ProjectAppType) => {
    setAppType(nextType);
    const nextProfile = APP_TYPE_PROFILES[nextType] ?? APP_TYPE_PROFILES.custom;
    const defaultPreset = nextProfile.presets[0];
    if (defaultPreset) {
      setTechStack({
        ...defaultPreset.stack,
        versionPolicy,
      });
    }
    setArchitectureNotes(nextProfile.defaultArchNotes);
  };

  const handleVersionPolicyChange = (nextPolicy: string) => {
    setVersionPolicy(nextPolicy);
    setTechStack((prev) => ({
      ...prev,
      versionPolicy: nextPolicy,
    }));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const blueprintPreview = useMemo(
    () =>
      previewBlueprint({
        name,
        appType,
        description,
        techStack,
        architectureNotes,
        referenceDocs,
      }),
    [name, appType, description, techStack, architectureNotes, referenceDocs],
  );

  if (!open) return null;

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const snippets: string[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      snippets.push(`### Reference File: ${file.name}\n\n${text.slice(0, 12_000)}`);
    }
    setReferenceDocs((prev) =>
      prev.trim() ? `${prev.trim()}\n\n${snippets.join('\n\n')}` : snippets.join('\n\n'),
    );
    e.target.value = '';
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const payload =
        mode === 'manual'
          ? {
              name: name.trim(),
              mode: 'manual' as const,
              repoUrl: repoUrl.trim() || undefined,
              defaultBranch: defaultBranch.trim() || 'main',
              description: description.trim(),
              initGit,
              seedStarterTickets,
            }
          : {
              name: name.trim(),
              mode: 'wizard' as const,
              defaultBranch: defaultBranch.trim() || 'main',
              appType,
              description: description.trim(),
              techStack: {
                ...techStack,
                versionPolicy: versionPolicy.trim() || undefined,
              },
              architectureNotes: architectureNotes.trim(),
              referenceDocs: referenceDocs.trim(),
              initGit,
              seedStarterTickets,
            };
      const res = await api<CreateProjectResponse>('/api/projects', 'POST', payload);
      await onCreated(res);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">AI Coding Factory · Workspace Setup</p>
            <h2 id="wizard-title" style={{ margin: 0, fontSize: '1.05rem' }}>
              Create New Project
            </h2>
          </div>
          <div className="segmented" role="tablist" aria-label="Creation mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'wizard'}
              className={mode === 'wizard' ? 'active' : ''}
              onClick={() => setMode('wizard')}
            >
              Guided Factory Wizard
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'manual'}
              className={mode === 'manual' ? 'active' : ''}
              onClick={() => setMode('manual')}
            >
              Manual / Git Clone
            </button>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <form
          onSubmit={(e) => void submit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          {mode === 'manual' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p className="muted small">
                Start with an empty workspace directory or clone an existing Git repository directly
                into the runner.
              </p>
              <label className="drawer-label" htmlFor="manual-project-name">
                Project Name
              </label>
              <input
                id="manual-project-name"
                className="input"
                placeholder="e.g. acme-billing-api"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

              <label className="drawer-label" htmlFor="manual-project-repo">
                Git Repository URL (optional — leave empty for a blank local project)
              </label>
              <input
                id="manual-project-repo"
                className="input"
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />

              <div className="drawer-row">
                <div style={{ flex: 1 }}>
                  <label className="drawer-label" htmlFor="manual-default-branch">
                    Default Branch
                  </label>
                  <input
                    id="manual-default-branch"
                    className="input"
                    value={defaultBranch}
                    onChange={(e) => setDefaultBranch(e.target.value)}
                  />
                </div>
              </div>

              {!repoUrl.trim() && (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}
                >
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={initGit}
                      onChange={(e) => setInitGit(e.target.checked)}
                    />
                    <span className="small">
                      Initialize local Git repository (<code className="mono">git init</code>) so
                      agent worktrees work immediately
                    </span>
                  </label>
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={seedStarterTickets}
                      onChange={(e) => setSeedStarterTickets(e.target.checked)}
                    />
                    <span className="small">
                      Seed 4 AI Factory starter tickets (PO → Architect → Coder → QA)
                    </span>
                  </label>
                </div>
              )}

              <footer className="drawer-foot" style={{ marginTop: '8px' }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  id="wizard-submit-manual"
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !name.trim() || Boolean(runnerDown && repoUrl.trim())}
                >
                  {busy
                    ? 'Creating…'
                    : repoUrl.trim()
                      ? 'Clone & Create Project'
                      : 'Create Blank Project'}
                </button>
              </footer>
            </div>
          ) : (
            <>
              <div className="segmented" aria-label="Wizard steps">
                <button
                  type="button"
                  className={step === 1 ? 'active' : ''}
                  onClick={() => setStep(1)}
                >
                  1. Vision & App Type
                </button>
                <button
                  type="button"
                  className={step === 2 ? 'active' : ''}
                  onClick={() => setStep(2)}
                >
                  2. Tech Stack ({activeProfile.icon})
                </button>
                <button
                  type="button"
                  className={step === 3 ? 'active' : ''}
                  onClick={() => setStep(3)}
                >
                  3. Structure & Docs
                </button>
                <button
                  type="button"
                  className={step === 4 ? 'active' : ''}
                  onClick={() => setStep(4)}
                >
                  4. PROJECT.md & Launch
                </button>
              </div>

              {step === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <label className="drawer-label" htmlFor="wizard-project-name">
                    Project Name
                  </label>
                  <input
                    id="wizard-project-name"
                    className="input"
                    placeholder="e.g. acme-cloud-portal, order-orchestrator, infra-sync-cli"
                    required
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <label className="drawer-label" style={{ margin: 0 }}>
                      Application Architecture Type
                    </label>
                    <span className="muted small">
                      Selecting an architecture tailors Step 2 tech stack presets & dropdowns
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: '8px',
                    }}
                  >
                    {APP_TYPE_LIST.map((t) => {
                      const selected = appType === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`card${selected ? ' card-live prio-2' : ''}`}
                          style={{
                            textAlign: 'left',
                            cursor: 'pointer',
                            borderColor: selected ? 'var(--ember-1)' : undefined,
                            background: selected
                              ? 'color-mix(in hsl, var(--ember-1) 8%, var(--surface))'
                              : undefined,
                            padding: '10px 12px',
                          }}
                          onClick={() => handleSelectAppType(t.id)}
                        >
                          <strong
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '0.85rem',
                            }}
                          >
                            <span>{t.icon}</span>
                            <span>{t.label}</span>
                          </strong>
                          <span
                            className="muted small"
                            style={{ display: 'block', marginTop: '4px' }}
                          >
                            {t.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <label className="drawer-label" htmlFor="wizard-description">
                    Product Vision, Core Features & Target Users
                  </label>
                  <textarea
                    id="wizard-description"
                    className="input"
                    rows={4}
                    placeholder="Describe what you want the AI Coding Factory to build, key user workflows, hardware/OS targets, or business goals…"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              )}

              {step === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Context banner showing active App Type */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '8px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '1.1rem' }}>{activeProfile.icon}</span>
                      <div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                          Tailored Stack for: {activeProfile.label}
                        </div>
                        <div className="muted" style={{ fontSize: '0.72rem' }}>
                          Pick a 1-click preset below, choose from any layer dropdown, or type any
                          custom technology freely.
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setStep(1)}
                    >
                      Change App Type
                    </button>
                  </div>

                  {/* Release & Version Track Policy (No Hardcoded Stale Versions) */}
                  <div>
                    <label
                      className="drawer-label"
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontWeight: 600,
                        color: 'var(--text)',
                      }}
                    >
                      Release & Runtime Version Policy (Version-Agnostic)
                    </label>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                        gap: '8px',
                      }}
                    >
                      {VERSION_POLICIES.map((vp) => {
                        const selected = versionPolicy === vp.id;
                        return (
                          <button
                            key={vp.id}
                            type="button"
                            className={`card${selected ? ' card-live prio-2' : ''}`}
                            style={{
                              padding: '8px 12px',
                              textAlign: 'left',
                              cursor: 'pointer',
                              borderColor: selected ? 'var(--ember-1)' : undefined,
                              background: selected
                                ? 'color-mix(in hsl, var(--ember-1) 8%, var(--surface))'
                                : undefined,
                            }}
                            onClick={() => handleVersionPolicyChange(vp.id)}
                          >
                            <div style={{ fontSize: '0.79rem', fontWeight: 600 }}>{vp.label}</div>
                            <div
                              className="muted"
                              style={{ fontSize: '0.69rem', marginTop: '2px', lineHeight: 1.3 }}
                            >
                              {vp.hint}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Filtered Presets for Selected App Type */}
                  <div>
                    <span
                      className="drawer-label"
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontWeight: 600,
                        color: 'var(--text)',
                      }}
                    >
                      Recommended Presets for {activeProfile.label}
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {activeProfile.presets.map((preset) => {
                        const isActivePreset =
                          techStack.language === preset.stack.language &&
                          techStack.frontend === preset.stack.frontend &&
                          techStack.backend === preset.stack.backend;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            className="chip-btn"
                            style={
                              isActivePreset
                                ? {
                                    borderColor: 'var(--ember-1)',
                                    background:
                                      'color-mix(in hsl, var(--ember-1) 12%, var(--surface))',
                                    color: 'var(--text)',
                                    fontWeight: 600,
                                  }
                                : undefined
                            }
                            title={preset.summary}
                            onClick={() =>
                              setTechStack({
                                ...preset.stack,
                                versionPolicy,
                              })
                            }
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Interactive Combo Box Fields (Dropdown + Free Text + Multi-Add) */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: '14px 12px',
                    }}
                  >
                    <TechStackComboField
                      label={activeProfile.layerLabels.language}
                      value={techStack.language}
                      options={activeProfile.catalog.language}
                      placeholder="Select or type language/runtime…"
                      onChange={(val) => setTechStack({ ...techStack, language: val })}
                    />
                    <TechStackComboField
                      label={activeProfile.layerLabels.frontend}
                      value={techStack.frontend}
                      options={activeProfile.catalog.frontend}
                      placeholder="Select or type frontend/surface…"
                      onChange={(val) => setTechStack({ ...techStack, frontend: val })}
                    />
                    <TechStackComboField
                      label={activeProfile.layerLabels.backend}
                      value={techStack.backend}
                      options={activeProfile.catalog.backend}
                      placeholder="Select or type backend/runtime…"
                      onChange={(val) => setTechStack({ ...techStack, backend: val })}
                    />
                    <TechStackComboField
                      label={activeProfile.layerLabels.database}
                      value={techStack.database}
                      options={activeProfile.catalog.database}
                      placeholder="Select or type database/storage…"
                      onChange={(val) => setTechStack({ ...techStack, database: val })}
                    />
                    <TechStackComboField
                      label={activeProfile.layerLabels.styling}
                      value={techStack.styling}
                      options={activeProfile.catalog.styling}
                      placeholder="Select or type UI/output format…"
                      onChange={(val) => setTechStack({ ...techStack, styling: val })}
                    />
                    <TechStackComboField
                      label={activeProfile.layerLabels.testing}
                      value={techStack.testing}
                      options={activeProfile.catalog.testing}
                      placeholder="Select or type test suite…"
                      onChange={(val) => setTechStack({ ...techStack, testing: val })}
                    />
                  </div>
                </div>
              )}

              {step === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '6px',
                    }}
                  >
                    <label className="drawer-label" htmlFor="wizard-arch-notes" style={{ margin: 0 }}>
                      Project Structure, Architecture Conventions & Coding Rules
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setArchitectureNotes(activeProfile.defaultArchNotes)}
                    >
                      Reset to {activeProfile.label} Defaults
                    </button>
                  </div>
                  <textarea
                    id="wizard-arch-notes"
                    className="input"
                    rows={4}
                    placeholder="Folder layout, monorepo structure, API conventions, coding standards…"
                    value={architectureNotes}
                    onChange={(e) => setArchitectureNotes(e.target.value)}
                  />

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <label className="drawer-label" htmlFor="wizard-ref-docs" style={{ margin: 0 }}>
                      Reference Docs, Example Projects or Specs
                    </label>
                    <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                      Attach .md / .txt / .json file
                      <input
                        type="file"
                        accept=".md,.txt,.json,.yaml,.yml"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => void handleFileUpload(e)}
                      />
                    </label>
                  </div>
                  <textarea
                    id="wizard-ref-docs"
                    className="input"
                    rows={5}
                    placeholder="Paste reference documentation, sample API schemas, example repos, hardware pinouts, or domain requirements…"
                    value={referenceDocs}
                    onChange={(e) => setReferenceDocs(e.target.value)}
                  />
                </div>
              )}

              {step === 4 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <p className="muted small">
                    Emberline will generate <code className="mono">PROJECT.md</code> and{' '}
                    <code className="mono">CLAUDE.md</code> in your new workspace so every agent
                    persona starts with full architectural context.
                  </p>
                  <pre
                    className="mono"
                    style={{
                      maxHeight: '220px',
                      overflow: 'auto',
                      padding: '12px',
                      borderRadius: '8px',
                      background: 'var(--bg-elevated, rgba(0,0,0,0.25))',
                      border: '1px solid var(--border)',
                      fontSize: '0.78rem',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {blueprintPreview}
                  </pre>

                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={initGit}
                      onChange={(e) => setInitGit(e.target.checked)}
                    />
                    <span className="small">
                      Initialize Git repository (<code className="mono">git init</code>) and commit{' '}
                      <code className="mono">PROJECT.md</code> so isolated agent worktrees work
                      immediately
                    </span>
                  </label>

                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={seedStarterTickets}
                      onChange={(e) => setSeedStarterTickets(e.target.checked)}
                    />
                    <span className="small">
                      Auto-seed 4 AI Factory starter tickets (<strong>Product Owner</strong> →{' '}
                      <strong>Architect</strong> → <strong>Coder</strong> → <strong>QA</strong>)
                    </span>
                  </label>
                </div>
              )}

              <footer className="drawer-foot">
                <div className="actions">
                  {step > 1 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : s))}
                    >
                      ← Back
                    </button>
                  )}
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                    Cancel
                  </button>
                  {step < 4 ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={step === 1 && !name.trim()}
                      onClick={() => setStep((s) => (s < 4 ? ((s + 1) as 1 | 2 | 3 | 4) : s))}
                    >
                      Next step →
                    </button>
                  ) : (
                    <button
                      id="wizard-submit"
                      type="submit"
                      className="btn btn-sm btn-primary"
                      disabled={busy || !name.trim()}
                    >
                      {busy ? 'Generating Factory…' : 'Create Project & Generate PROJECT.md'}
                    </button>
                  )}
                </div>
              </footer>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
        </form>
      </aside>
    </div>
  );
}

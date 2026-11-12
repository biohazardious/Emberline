# Emberline — Project Blueprint (`PROJECT.md`)

> **Application Type:** Multi-Agent Platform (self-hosted web app + PTY daemon)
> **Managed By:** Emberline AI Coding Factory

---

## 1. Product Vision & Overview

Emberline is a self-hosted platform that runs the official AI coding CLIs (Claude Code, Codex, Gemini CLI,
Antigravity, GitHub Copilot CLI, Aider) against a ticket board. It tracks work as tickets, gives each run its
own git worktree, waits out subscription usage limits and resumes after the reset, and puts every change
through per-file, per-line review before it merges. It is managed from any browser, including a phone.
One installation is one user with that user's own subscriptions.

The design rationale (principles, topology, scheduler, review, data model, auth, risks) is in
[`docs/DESIGN.md`](docs/DESIGN.md). Installation and use are in the [README](README.md).

---

## 2. Technology Stack

- **Language & runtime:** TypeScript 5 (strict, `NodeNext` modules) on Node.js ≥ 22.12, a pnpm 10 workspace.
- **Frontend:** React 19 + Vite, with TanStack Query, wouter, xterm.js and Monaco. A single-page app that covers the board, the terminals and the diff review, with route- and pane-scoped `ErrorBoundary` isolation (`components/ErrorBoundary.tsx`), async loading/retry banners, and client-side search/filter domain modules (`boardFilter.ts`, `runFilter.ts`, `roadmapFilter.ts`).
- **Backend:** Fastify (REST + `@fastify/websocket`) in `apps/core`, plus `apps/ptyd`, a node-pty host behind a Unix-socket RPC, so agents outlive core restarts.
- **Database:** SQLite through better-sqlite3 and Drizzle ORM (WAL mode, SQL migrations in `apps/core/drizzle`). It is one embedded file for a single-user install and needs no server.
- **Styling:** Plain CSS with design tokens as custom properties in `apps/web/src/index.css`, error/filter UI primitives in `apps/web/src/error-filter.css`, and responsive workbench breakpoints in `apps/web/src/responsive.css`. No CSS framework.
- **Testing:** Vitest for unit and integration tests across all packages. `e2e/smoke.mjs` is an end-to-end smoke test against an isolated core + runner + ops stack.
- **Authentication:** A single admin account with an argon2id password set through a one-time setup token. HTTP-only session cookies, plus a per-login key sent as the CSRF header and the WebSocket subprotocol (DESIGN §3.8).
- **Wire contracts:** zod schemas in `packages/protocol` validate every boundary: REST bodies, WebSocket events, hook payloads, ptyd RPC and `.emberline/worktree.yml`.
- **Deploy target:** Docker Compose (`compose.yaml`). One multi-stage `Dockerfile` builds the `core` and `runner` images and a `check` stage that serves as the CI gate.

---

## 3. Architecture & Engineering Standards

### 3.1 Components and how they communicate

| Component                  | Container       | Talks to                                                                                           |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `apps/web` (browser UI)    | served by core  | core over HTTP (`/api/*`) and one WebSocket, both typed by `@emberline/protocol`                   |
| `apps/core` (API + engine) | `core`          | SQLite (sole owner), ptyd and ops over Unix-socket RPC (`ptyd-bridge.ts`), forges over HTTPS       |
| `apps/ptyd` (PTY host)     | `runner`, `ops` | serves length-prefixed JSON RPC (`spawn`, `list`, `attach`, `write`, `resize`, `snapshot`, `kill`) |
| agent CLIs                 | `runner`        | run inside ptyd sessions; report through `emberline-hook`                                          |
| `packages/hook`            | `runner`        | core over HTTP (`/api/internal/hooks`, per-run token), plus the Emberline MCP server for agents    |
| `docker` (rootless dind)   | `docker`        | agents and previews reach it over mutual-TLS tcp 2376; the host socket is never mounted            |

Invariants (DESIGN §2):

- Core never runs workspace code. Git, builds, tests and installs run in the runner or ops through ptyd.
- Agents outlive core. On start, core reconnects to ptyd and reconciles live sessions with the database.
- Forge tokens never leave core. Runner git goes through core's one-time git gateway URL.

### 3.2 Package layering

```
packages/protocol        zod schemas + types (ptyd RPC, hooks, REST/WS API, worktree.yml)  → zod only
packages/adapter-sdk     agent adapter interface (AgentState, AgentEvent, launch specs)   → nothing
packages/adapter-claude  launch specs, hook state machine, usage-limit parsing            → protocol, adapter-sdk
packages/hook            emberline-hook + CLI wrappers + MCP server                       → protocol
apps/ptyd                PTY host daemon                                                  → protocol
apps/web                 React UI (browser: no Node built-ins)                            → protocol
apps/core                Fastify API, scheduler, runs, review, factory, SQLite            → all packages, ptyd/client
```

`eslint.config.js` (`LAYERS`) enforces these edges, so `pnpm lint` fails on any import that crosses a layer.
Tests and `test-*.ts` helpers are exempt, for example core's agent harness starts a real `ptyd/server`.
`protocol` and `adapter-sdk` are Apache-2.0 so third-party adapters can use any license. Everything else is AGPL-3.0-or-later.

### 3.3 Domain contracts

- **Board:** `Project` → `Ticket` (columns `backlog | ready | in_progress | review | done`, priority, `dependsOn`) → `Run`
  (`queued | starting | working | waiting_input | rate_limited | done | failed`) → `RunEvent`
  (source `hook | transcript | screen | user | system`). Types: `packages/protocol/src/api/{projects,tickets,runs}.ts`
  and `packages/adapter-sdk/src/index.ts`. Tables: `apps/core/src/db/schema.ts`.
- **Scheduling:** `QuotaWindow` and scheduled jobs live in SQLite, so restarts keep every timer (`api/scheduler.ts`, `api/usage.ts`).
- **Review:** per-run diffs, line comments and review rounds (`api/review.ts`).
- **Worktree config:** `.emberline/worktree.yml` with `setup`, `services` and `checks` (`api/worktree-config.ts`).
- **Factory tickets:** `.emberline/new-tickets.json`, ingested by core when a run finishes (`apps/core/src/tickets/`).
- **Agent-written factory files:** `.emberline/new-tickets.json` / `tickets.json`, `roadmap-generated.json` and
  `brainstorm-suggestions.json` are contracts in `packages/protocol/src/api/agent-files.ts` (`NewTicketsFile`,
  `GeneratedRoadmapFile`, `BrainstormSuggestionsFile`). Core reads them with `parseAgentFile`
  (`apps/core/src/factory/agent-files.ts`, `safeParse`, no casts). A file that fails is renamed to `*.rejected.json`
  and `TicketService` emits a `notice` (`ProjectNotice`, the `project_notice` event on `/api/events`) naming the
  first zod issue, which the web shows as a toast.
- **Board export:** `GET /api/projects/:projectId/tickets/export?format=csv|json&status=<columns>` (`api/ticket-export.ts`).
  The strict query schema rejects unknown formats, statuses and keys. JSON carries whole-board status counts and the done ratio;
  CSV is RFC 4180 with a UTF-8 BOM and neutralises formula-leading cells (`apps/core/src/tickets/export.ts`). The board's Export menu downloads it.

Every value that crosses a process boundary is parsed with its zod schema on arrival. New contracts go into
`packages/protocol` first, then core and web consume them.

### 3.4 Engineering standards

- Strict TypeScript (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). No `any`, no `@ts-ignore`.
- Type-aware ESLint rules ban floating and misused promises. Prettier formats everything.
- Schema changes go in `apps/core/src/db/schema.ts`, then `make db-generate` writes a Drizzle migration. Migrations are append-only,
  and `apps/core/src/db-schema.test.ts` fails the test gate when the schema and the migrations drift apart.
- Tests are hermetic. `apps/core/src/test-setup.ts` strips the host runner's Docker, run and provider variables
  and points the runner home and tools at absent paths, so the suite gives the same result inside an Emberline runner and in CI.

### 3.5 Commands (from the repo root)

| Command                          | What it does                                                     |
| -------------------------------- | ---------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install the workspace                                            |
| `pnpm dev`                       | Run the dev servers for all packages in parallel                 |
| `pnpm build`                     | Build every package (`tsc`; Vite for web)                        |
| `pnpm lint` / `pnpm typecheck`   | ESLint (including layer boundaries) / `tsc --noEmit` per package |
| `pnpm test`                      | Vitest across `{apps,packages}/*/src/**/*.test.ts`               |
| `pnpm format:check`              | Prettier check                                                   |
| `make check`                     | All of the above inside the dev toolbox container                |
| `make ci`                        | The Dockerfile `check` stage: the CI gate                        |
| `make e2e`                       | End-to-end smoke test on an isolated stack                       |
| `make up` / `make down`          | Production stack (core, runner, ops, docker)                     |

The factory build gate (`.emberline/worktree.yml`) runs `pnpm run build`, `pnpm run lint` and `pnpm run test`.

---

## 4. Reference Specifications & Domain Context

- [`docs/DESIGN.md`](docs/DESIGN.md): architecture and design decisions.
- [`SECURITY.md`](SECURITY.md): threat model, container privileges, secrets, SSH keys and host key checks.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): workflow and conventions.
- [`CHANGELOG.md`](CHANGELOG.md): release history (current: 0.7.0).

---

## 5. AI Coding Factory Personas & Responsibilities

- **Product Owner (`product_owner`):** Maintains this `PROJECT.md`, refines user stories, and defines clear acceptance criteria.
- **System Architect (`architect`):** Owns directory structure, module interfaces, API contracts, and architectural coherence.
- **UI/UX Engineer (`ui_ux`):** Owns design tokens, component ergonomics, accessibility, and responsive behavior.
- **Software Engineer (`coder`):** Implements features and bug fixes cleanly with accompanying tests.
- **Database Architect (`dba`):** Owns schema design, migrations, indexes, and query performance.
- **QA & Test Engineer (`qa`):** Owns unit, integration, and E2E test suites and regression verification.
- **Security Engineer (`security`):** Audits authentication, input validation, permissions, and dependency safety.

---

## 6. Milestones & Delivery Checklist

- [x] **M1 — Foundation & Architecture:** Core repository skeleton, build pipeline, and domain contracts.
      The pnpm workspace and the layering in §3.2 are enforced by lint. The gate (format, lint, typecheck, build, test) passes, and the test suite is hermetic. The contracts are in `packages/protocol` and `packages/adapter-sdk`.
- [x] **M2 — Core Domain & Data Layer:** Primary models, persistence, and core service logic.
      Every table is declared in `apps/core/src/db/schema.ts` (DESIGN §3.7) and opened through `openDb` (WAL, foreign keys,
      a backup before pending migrations). Services in `apps/core/src/{tickets,runs,scheduler,review,repository}` own the domain
      logic. `apps/core/src/db-schema.test.ts` guards the schema against drift from the append-only migrations.
- [ ] **M3 — User Interface / API Surface:** Primary user workflows, endpoints, and interactive views.
- [ ] **M4 — QA, Security & Polish:** End-to-end test suite, security hardening, and UX polish.

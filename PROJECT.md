# Emberline — Project Blueprint (`PROJECT.md`)

> **Application Type:** Multi-Agent Platform (self-hosted web app + PTY daemon)
> **Managed By:** Emberline AI Coding Factory

---

## 1. Product Vision & Overview

Emberline is a self-hosted platform that runs the official AI coding CLIs (Claude Code, Codex, Gemini CLI,
Antigravity, GitHub Copilot CLI, Aider) against a ticket board. It tracks work as tickets, gives each run its
own git worktree, waits out subscription usage limits and resumes after the reset, and puts every change
through per-file, per-line review before it merges. It is managed from any browser, including a phone.

Three principles shape every decision (DESIGN §2):

- **One installation = one user.** Self-hosted, with that user's own subscriptions. Account sharing, rotation
  and quota pooling are non-goals.
- **Real CLIs, your own logins.** Agents are the official CLIs running in a PTY. Emberline does not reimplement
  an agent or call model APIs for the user. Each CLI is logged in once inside the runner, and its credentials
  stay in the runner's home volume.
- **Agents outlive the app.** The PTY daemon runs in its own container. Restarting or upgrading core never
  kills an agent: core reconnects to ptyd and reconciles the live sessions with the database.

The design rationale (principles, topology, scheduler, review, data model, auth, risks) is in
[`docs/DESIGN.md`](docs/DESIGN.md). Installation and use are in the [README](README.md).

---

## 2. Technology Stack

- **Language & runtime:** TypeScript 5 (strict, `NodeNext` modules) on Node.js ≥ 22.12, a pnpm 10 workspace.
- **Frontend:** React 19 + Vite, with TanStack Query, wouter, xterm.js and Monaco. A single-page app that covers the board, the terminals and the diff review, with route- and pane-scoped `ErrorBoundary` isolation (`components/ErrorBoundary.tsx`), async loading/retry banners, and client-side search/filter domain modules (`boardFilter.ts`, `runFilter.ts`, `roadmapFilter.ts`).
- **Backend:** Fastify (REST + `@fastify/websocket`) in `apps/core`, plus `apps/ptyd`, a node-pty host behind a Unix-socket RPC, so agents outlive core restarts.
- **Database:** SQLite through better-sqlite3 and Drizzle ORM (WAL mode, SQL migrations in `apps/core/drizzle`). It is one embedded file for a single-user install and needs no server.
- **Styling:** Plain CSS with design tokens as custom properties in `apps/web/src/index.css`, error/filter UI primitives in `apps/web/src/error-filter.css`, and responsive workbench breakpoints in `apps/web/src/responsive.css`. No CSS framework.
- **Testing:** Vitest for unit and integration tests across all packages (how to run them and what covers which workflow: [`docs/TESTING.md`](docs/TESTING.md)). `e2e/smoke.mjs` is an end-to-end smoke test against an isolated core + runner + ops stack.
- **Authentication:** A single admin account with an argon2id password set through a one-time setup token. HTTP-only session cookies, plus a per-login key sent as the CSRF header and the WebSocket subprotocol (DESIGN §3.8).
- **Wire contracts:** zod schemas in `packages/protocol` validate every boundary: REST bodies, WebSocket events, hook payloads, ptyd RPC and `.emberline/worktree.yml`.
- **Deploy target:** Docker Compose (`compose.yaml`). One multi-stage `Dockerfile` builds the `core` and `runner` images and a `check` stage that serves as the CI gate.

---

## 3. Architecture & Engineering Standards

### 3.1 Components and how they communicate

| Component                  | Container       | Talks to                                                                                                |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/web` (browser UI)    | served by core  | core over HTTP (`/api/*`) and WebSockets (`/api/events`, `/api/terminals/:id/ws`), typed by protocol    |
| `apps/core` (API + engine) | `core`          | SQLite (sole owner); runner and ops ptyd over Unix-socket RPC (`ptyd-bridge.ts`); forges over HTTPS     |
| `apps/ptyd` (PTY host)     | `runner`, `ops` | serves length-prefixed JSON RPC (`spawn`, `list`, `attach`, `write`, `resize`, `snapshot`, `kill`)      |
| agent CLIs                 | `runner`        | run inside runner ptyd sessions; report through `emberline-hook`                                        |
| `packages/hook`            | `runner`        | core over HTTP (`/api/internal/hooks`, per-run token), plus the Emberline MCP server for agents         |
| runner git                 | `runner`        | core's git gateway (`/api/internal/git/<capability>/…`, `apps/core/src/git-gateway/`) over smart HTTP   |
| ops (runner image)         | `ops`           | core's own commands (git for imports/merges/pushes, the Docker CLI for previews) on its own ptyd socket |
| `docker` (rootless dind)   | `docker`        | agents and previews reach it over mutual-TLS tcp 2376; the host socket is never mounted                 |

Data flow:

- **Browser ↔ core:** REST for commands and reads. `/api/events` streams board, run and notice events, and
  `/api/terminals/:id/ws` carries one terminal's I/O. Mutating calls send the per-login key as the CSRF header, and WebSockets send it as a subprotocol.
- **Core ↔ ptyd:** each container's ptyd listens on a Unix socket in a shared volume. The runner's socket is `ptyd-socket`, and
  `ops-socket` is mounted only in core and ops. Frames are length-prefixed JSON parsed with the ptyd schemas in
  `packages/protocol`. `snapshot` returns the `@xterm/headless` screen, so a reconnecting client redraws at once.
- **Agent → core:** the CLI's hooks call `emberline-hook`, which POSTs a zod-validated event to `/api/internal/hooks` with the run's
  token. Core drives the run state machine from hooks first, then transcripts, then the screen.
- **Runner git → forge:** the runner holds no forge credentials. For each git command core issues a one-time capability URL,
  bound to one repository, service and (for a push) ref, and accepted only from the runner's address. Core adds the
  credentials (an HTTPS token or Emberline's SSH key) and streams the traffic to the upstream server.

Invariants (DESIGN §2):

- Core never runs workspace code. Git, builds, tests and installs run in the runner or ops through ptyd.
- Agents outlive core. On start, core reconnects to ptyd and reconciles live sessions with the database.
- Forge tokens never leave core. Runner git goes through core's one-time git gateway URL.

### 3.2 Package layering

```
packages/protocol        zod schemas + types (ptyd RPC, hooks, REST/WS API, worktree.yml)  → zod only
packages/adapter-sdk     ProviderAdapter contract, shared limit/reset helpers, CLI wrapper → nothing
packages/adapter-claude  Claude Code (+ Antigravity, Copilot, Aider wrappers), personas   → protocol, adapter-sdk
packages/adapter-codex   Codex CLI launch, limits from hook, rollout transcript, screen   → adapter-sdk
packages/adapter-gemini  Gemini CLI launch, limits from hook and screen (per-model pools) → adapter-sdk
packages/hook            emberline-hook + CLI wrappers + MCP server                       → protocol
apps/ptyd                PTY host daemon                                                  → protocol
apps/web                 React UI (browser: no Node built-ins)                            → protocol
apps/core                Fastify API, scheduler, runs, review, factory, SQLite            → all packages, ptyd/client
```

`eslint.config.js` (`LAYERS`) enforces these edges, so `pnpm lint` fails on any import that crosses a layer.
Core reaches every CLI through one typed registry, `Record<AgentId, ProviderAdapter>` in `apps/core/src/runs/providers.ts`
(launch spec, persona framing, headless-mode check, hook state, rate-limit and transient-error detection); core itself
parses no CLI's wording. Each adapter's `ratelimit.test.ts` runs fixtures of real CLI output (`src/fixtures/`), checked
in signal order: hooks first, transcripts second, the screen last (DESIGN §5).
Tests and `test-*.ts` helpers are exempt, for example core's agent harness starts a real `ptyd/server`.
`protocol` and `adapter-sdk` are Apache-2.0 so third-party adapters can use any license. Everything else is AGPL-3.0-or-later.

### 3.3 Domain contracts

- **Board:** `Project` → `Ticket` (columns `backlog | ready | in_progress | review | done`, priority, `dependsOn`) → `Run`
  (`queued | starting | working | waiting_input | rate_limited | done | failed`) → `RunEvent`
  (source `hook | transcript | screen | user | system`). Types: `packages/protocol/src/api/{projects,tickets,runs}.ts`
  and `packages/adapter-sdk/src/index.ts`. Tables: `apps/core/src/db/schema.ts`.
- **Scheduling:** `QuotaWindow` and scheduled jobs live in SQLite, so restarts keep every timer (`api/scheduler.ts`, `api/usage.ts`).
  `quota_windows` is the pause table: lane (provider), `resets_at`, `resume_at`, reason and the run that hit the limit; open pauses
  are served by `quota_windows_open_idx` (migration 0029). The scheduler keeps no queue, slot or pause state in memory: after every
  pass it re-arms one timer for the next stored resume or retry time (`scheduler/next-wake.ts`), and on each ptyd connect
  `Scheduler.recover()` first ends runs whose sessions ptyd no longer reports (freeing their slots), then resumes due pauses.
- **Review:** per-run diffs, line comments and review rounds (`api/review.ts`).
- **Worktree config:** `.emberline/worktree.yml` with `setup`, `services` and `checks` (`api/worktree-config.ts`).
- **Compose preview environments:** one stack per worktree (`apps/core/src/docker/compose-preview.ts`): its own project name,
  a host port from `EMBERLINE_PREVIEW_PORTS_DOCKER`, cpu/memory caps from `EMBERLINE_PREVIEW_CPUS` / `EMBERLINE_PREVIEW_MEMORY_MB`
  (default 1 cpu, 1024 MB per container), and a refusal of fixed `container_name`/volume/network names (`docker/compose-isolation.ts`).
  Torn down on prune and on ticket Done. `GET /api/projects/:id/container-preview/environments` returns
  `ComposePreviewEnvironmentsResponse` (`api/previews.ts`: `starting | healthy | failed | stopped`).
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

- **Bulk board actions:** `POST /api/projects/:projectId/tickets/bulk` takes a `BulkTicketBody` (`packages/protocol/src/api/ticket-bulk.ts`,
  a discriminated union over `move | priority | persona | delete`, 1–`BULK_TICKET_LIMIT` (100) ids or keys, strict keys) and
  returns a `BulkTicketResult` (`updated`, `removed`, `unchanged`, `failed`). `apps/core/src/tickets/bulk.ts` applies each ticket
  through `TicketService.update`/`remove` in board order, so dependents and auto-dispatch behave as for a single edit. It refuses,
  per ticket, a move or delete of a ticket with a live run (`run_active`) and a bulk close of a ticket with a run branch
  (`merge_required`: closing it from the drawer merges it). The board's **Select** mode (`hooks/useBoardSelection.ts`,
  `boardSelection.ts`, `components/BoardBulkBar.tsx`, `board-bulk.css`) keeps refused tickets selected and lists why.

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

- [x] **M1 — Workspace, layering and wire contracts:**
      The pnpm workspace and the layering in §3.2 are enforced by lint. The gate (format, lint, typecheck, build, test) passes, and the test suite is hermetic. The contracts are in `packages/protocol` and `packages/adapter-sdk`.
- [x] **M2 — Domain model, persistence and the run engine:**
      Every table is declared in `apps/core/src/db/schema.ts` (DESIGN §3.7) and opened through `openDb` (WAL, foreign keys,
      a backup before pending migrations). Services in `apps/core/src/{tickets,runs,scheduler,review,repository}` own the domain
      logic, and the scheduler keeps its queue and quota pauses in SQLite (§3.3). `apps/core/src/db-schema.test.ts` guards the schema against drift from the append-only migrations.
      Event retention (`runs/event-retention.ts`, `EMBERLINE_EVENT_RETENTION_DAYS`, default 90, `0` off) compacts old `done`
      runs to their state changes, summary, handoff note and usage totals (`run_event_compactions`); `event-indexes.test.ts`
      holds the inbox and board under 50 ms on a seeded 100k-event database and pins the hot query plans.
- [x] **M3 — Board, runs and review in the browser:**
      The board (create, drag between columns, dependencies, start/prompt runs, review, accept/merge, export) and its bulk actions
      (`ticket-bulk-route.test.ts`, `boardBulkBar.test.ts`, `boardSelection.test.ts`) are covered end to end through the REST API
      and the React views.
- [x] **M4 — Hardening: auth coverage, isolation and the end-to-end gate:**
      Gate verified (lint, typecheck, build, 3400+ tests). `apps/core/src/auth-coverage.test.ts` sweeps every registered `/api` route:
      anonymous callers get 401 outside the public, internal and demo-token routes, writes without the CSRF header get 403, and
      internal hook routes stay closed without a run token. A new route that forgets authentication fails that test.
      `make e2e` runs `e2e/smoke.mjs` against an isolated core + runner + ops stack seeded with 0.6.x volumes.

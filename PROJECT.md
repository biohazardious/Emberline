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

### 1.1 Who it is for

| Persona                     | Who                                                                   | Wants                                                                               |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Operator** (the one user) | A developer who self-hosts Emberline with their own CLI subscriptions | Hand tickets to agents, survive usage limits, review every line before it merges    |
| **Contributor**             | Someone changing Emberline itself (often an Emberline factory run)    | A gate that catches layer violations, contract drift and environment leaks for them |
| **Adapter author**          | Someone adding an agent CLI, possibly under another license           | Depend only on the Apache-2.0 `protocol` and `adapter-sdk` packages, never on core  |

### 1.2 Product user stories

Each story names where it is verified today (tests listed in [`docs/TESTING.md`](docs/TESTING.md)).

- **US-1 Board.** As the operator, I create tickets with a priority and `dependsOn`, move them across
  `backlog → ready → in_progress → review → done`, and a ticket only starts once all its dependencies are merged.
  _Edge cases:_ a dependency cycle is refused; deleting a ticket with a live run is refused (`run_active`).
- **US-2 One worktree per run.** As the operator, every run works in its own git worktree and branch, so two
  agents never edit the same checkout. _Edge cases:_ a pruned worktree also tears down its compose preview.
- **US-3 Usage limits.** As the operator, when a CLI hits its subscription limit the run goes `rate_limited`, the
  lane pauses until `resets_at`, and work resumes on its own after the reset — also across a core restart.
  _Edge cases:_ a pause whose resume time passed while core was down resumes on the next ptyd connect.
- **US-4 Review before merge.** As the operator, I review each run's diff per file and per line, comment, request
  another round, and only an accepted change merges. _Edge cases:_ closing a ticket with a run branch requires
  a merge (`merge_required`); the worktree gate (`build`, `lint`, `test`) must pass first.
- **US-5 Agents outlive the app.** As the operator, I upgrade or restart core without killing an agent; the
  terminal redraws at once from the ptyd snapshot. _Edge cases:_ runs whose ptyd session vanished are ended and
  their slots freed; a runner below `PTYD_MIN_PROTOCOL_VERSION` is refused, fail closed.
- **US-6 Any browser, including a phone.** As the operator, I sign in with the single admin account and use the
  board, terminals and review at phone width. _Edge cases:_ an anonymous call gets 401, a write without the CSRF
  header gets 403.
- **US-7 Factory planning.** As the operator, a planning run writes `.emberline/new-tickets.json` and the tickets
  appear on the board with their dependencies. _Edge cases:_ a malformed file is renamed `*.rejected.json` and a
  toast names the first zod issue; nothing is half-imported.
- **US-8 Stays mine.** As the operator, forge tokens and CLI logins never leave core and the runner home volume;
  there is no account sharing or quota pooling (non-goals, DESIGN §1).

### 1.3 Milestone 1 user stories (workspace, layering, wire contracts)

Milestone 1 serves the contributor and the adapter author. Its acceptance criteria are in §6 (AC-1.x).

- **US-M1.1 One-command gate.** As a contributor, I run `make check` (or the factory gate in
  `.emberline/worktree.yml`) and one exit code tells me whether format, lint, typecheck, build and tests pass.
- **US-M1.2 Layers are enforced, not documented.** As a contributor, an import that crosses §3.2 fails
  `pnpm lint` with a message pointing at PROJECT.md §3, so review never has to catch it.
- **US-M1.3 Contracts live in one place.** As a contributor, every value that crosses a process boundary has a
  zod schema in `packages/protocol`; core, web, hook and ptyd import it instead of redeclaring the shape.
- **US-M1.4 Hermetic tests.** As a contributor running the suite inside an Emberline runner, the runner's own
  Docker engine, run token and provider keys never reach a test, so the result matches CI.
- **US-M1.5 Third-party adapters.** As an adapter author, I implement an agent against `adapter-sdk` and
  `protocol` alone (Apache-2.0, no other workspace dependency) without pulling AGPL code.

---

## 2. Technology Stack

- **Language & runtime:** TypeScript 5 (strict, `NodeNext` modules) on Node.js ≥ 22.12, a pnpm 10 workspace.
- **Frontend:** React 19 + Vite, with TanStack Query, wouter, xterm.js and Monaco. A single-page app that covers the board, the terminals and the diff review, with route- and pane-scoped `ErrorBoundary` isolation (`components/ErrorBoundary.tsx`), async loading/retry banners, and client-side search/filter domain modules (`boardFilter.ts`, `runFilter.ts`, `roadmapFilter.ts`).
- **Backend:** Fastify (REST + `@fastify/websocket`) in `apps/core`, plus `apps/ptyd`, a node-pty host behind a Unix-socket RPC, so agents outlive core restarts.
- **Database:** SQLite through better-sqlite3 and Drizzle ORM (WAL mode, SQL migrations in `apps/core/drizzle`). It is one embedded file for a single-user install and needs no server.
- **Styling:** Plain CSS with design tokens as custom properties in `apps/web/src/index.css`, error/filter UI primitives in `apps/web/src/error-filter.css`, and responsive workbench breakpoints in `apps/web/src/responsive.css`. No CSS framework.
- **Testing:** Vitest for unit and integration tests across all packages (how to run them and what covers which workflow: [`docs/TESTING.md`](docs/TESTING.md)). `e2e/smoke.mjs` is an end-to-end smoke test against an isolated core + runner + ops stack, and `e2e/ui/run.mjs` is a Playwright ticket-to-merge regression suite on the same stack (wizard import from a git URL, a card following the agent, an Inbox question, a blocking review comment closing the merge gate, a usage-limit pause that auto-resumes). It uses the fake forge (`e2e/fake-forge.mjs`) and a scripted Claude stand-in (`e2e/fake-claude.mjs`, set as `EMBERLINE_CLAUDE_COMMAND`); a failed scenario leaves a trace zip and screenshot in `e2e-results/`, which CI uploads. `e2e/isolation.sh` (with `e2e/isolation/run.mjs`), run by `make e2e` after the smoke test, is the isolation regression suite: SECURITY.md's "The shared runner" guarantees as named tests SR-01–SR-20 (table in `docs/TESTING.md`), checked from an agent terminal (ptyd, inherited terminals, ops and core processes, SSH keys, the browser daemon) and from ops, a container named `docker` and the host (cookie replays, the git gateway, volume scan, mounts); reverting the 0.7.0 terminal-inheritance fix fails SR-05/SR-06. `make e2e-upgrade` (`e2e/upgrade-paths.sh`, CI step) seeds 0.5/0.6/0.7 data volumes, upgrades them to the current images and checks the pre-migration snapshot, seeded rows, secrets, the ops-missing banner and a snapshot rollback; it fails if any migration lacks a snapshot or breaks a seeded row.
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
- **Run & ticket engine modules:** `RunService` (`runs/service.ts`) and `TicketService` (`tickets/service.ts`) keep their public
  signatures and delegate to focused modules. `runs/lifecycle.ts` holds the run state machine as discriminated unions
  (`hookTransition`, `stopTransition`, `exitTransition`, reconcile's `openRunStep`) and `applyRunEvent`, the one atomic event+state write.
  `runs/worktree.ts` creates run workspaces, merges a run's branch into main (`mergeRunBranch`), answers garbage collection's
  keep verdicts (`KeptWorktrees`) and runs teardown-then-prune jobs under the prune lock (`WorktreeTeardowns`).
  `runs/gates.ts` holds the pipeline gates over a `GatePass` (worktree.yml, worktree commands, build/lint/test, secret and
  anti-slop guard, cross-provider critic, blocking review) returning a `GateOutcome` (`pass | merge_blocked | halt`), plus the
  pre-commit secret guard. `tickets/dependencies.ts` resolves `dependsOn` and finds unblocked tickets; `tickets/columns.ts`
  maps run states to board columns and positions.
- **Scheduling:** `QuotaWindow` and scheduled jobs live in SQLite, so restarts keep every timer (`api/scheduler.ts`, `api/usage.ts`).
  `quota_windows` is the pause table: lane (provider), `resets_at`, `resume_at`, reason and the run that hit the limit; open pauses
  are served by `quota_windows_open_idx` (migration 0029). The scheduler keeps no queue, slot or pause state in memory: after every
  pass it re-arms one timer for the next stored resume or retry time (`scheduler/next-wake.ts`), and on each ptyd connect
  `Scheduler.recover()` first ends runs whose sessions ptyd no longer reports (freeing their slots), then resumes due pauses.
- **Review:** per-run diffs, line comments and review rounds (`api/review.ts`). `ReviewPage.tsx` and `ReviewView.tsx`
  render an inline merge-gate blocking banner with comment anchor links (`reviewGate.ts`, `components/review/MergeGateBanner.tsx`),
  a virtualised hierarchical file tree with rolled-up comment/blocking tabular counts (`reviewTree.ts`, `components/review/ReviewFileTree.tsx`),
  keyboard navigation (`j`/`k` file, `n`/`p` comment, `c` add comment, `b` toggle blocking, `?` shortcut sheet via `reviewShortcuts.ts`),
  and lazy LRU-bounded Monaco diff models (`components/review/monacoModelPool.ts`, `review-keyboard.css`).
- **Worktree config:** `.emberline/worktree.yml` with `setup`, `services` and `checks` (`api/worktree-config.ts`).
  Before `setup` runs (a run's worktree and the build gate), core provisions the package manager package.json's
  `packageManager` pins when a setup command names it and the runner's PATH lacks it: today pnpm, installed at exactly that
  version with `npm install -g` into the runner-tools volume (`apps/core/src/toolchain/package-manager.ts`). The run records
  `worktree_toolchain_installed` ("Installed pnpm 10.15.0 for setup") or `worktree_toolchain_failed`; npm and yarn projects are untouched.
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

| Command                                   | What it does                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`          | Install the workspace                                                                                      |
| `pnpm dev`                                | Run the dev servers for all packages in parallel                                                           |
| `pnpm build`                              | Build every package (`tsc`; Vite for web)                                                                  |
| `pnpm lint` / `pnpm typecheck`            | ESLint (including layer boundaries) / `tsc --noEmit` per package                                           |
| `pnpm test`                               | Vitest across `{apps,packages}/*/src/**/*.test.ts`                                                         |
| `pnpm format:check`                       | Prettier check                                                                                             |
| `make check`                              | All of the above inside the dev toolbox container                                                          |
| `make ci`                                 | The Dockerfile `check` stage: the CI gate                                                                  |
| `make e2e`                                | Smoke test, isolation suite and Playwright suite on an isolated stack (`E2E_TAG` picks the image tag)      |
| `make e2e-upgrade`                        | Upgrade paths from 0.5/0.6/0.7 volumes and the rollback drill                                              |
| `pnpm supply-chain` / `make supply-chain` | Release gate: install scripts + `pnpm audit --prod`/`--dev` vs `scripts/supply-chain/audit-allowlist.json` |

| `make up` / `make down` | Production stack (core, runner, ops, docker) |

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
      Acceptance criteria below; each is testable, and **Guard** names what fails when it regresses.

      | AC     | Given / when / then                                                                                                                                                                                                         | Guard                                                                     |
      | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
      | AC-1.1 | On a clean checkout, `pnpm install --frozen-lockfile` succeeds on Node ≥ 22.12 / pnpm 10, and an out-of-date lockfile fails it instead of rewriting it.                                                                     | `make ci` (Dockerfile `check` stage)                                      |
      | AC-1.2 | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test` exits 0; any one failing step makes `make check` exit non-zero.                                                                                | `make check`, `.emberline/worktree.yml` checks                            |
      | AC-1.3 | An import of `@emberline/core`, `web`, `hook` or `ptyd/server` from a lower layer (and of anything but `protocol`/`adapter-sdk` from `adapter-claude`, anything but `protocol` from `hook`/`ptyd`/`web`) fails `pnpm lint` with "Crosses a package layer boundary". Sub-path imports (`@emberline/x/y`) are caught too. | `eslint.config.js` `LAYERS`; `apps/core/src/workspace-layers.test.ts` |
      | AC-1.4 | A `node:*` import in `apps/web/src` fails `pnpm lint`. `*.test.ts`, `test-*.ts` and `test-setup.ts` are exempt from AC-1.3/1.4.                                                                                              | `eslint.config.js`; `apps/core/src/workspace-layers.test.ts` |
      | AC-1.5 | `packages/protocol` depends on `zod` only and `packages/adapter-sdk` on nothing; both are `Apache-2.0`, every other package `AGPL-3.0-or-later`.                                                                           | package manifests; `apps/core/src/workspace-manifests.test.ts` |
      | AC-1.6 | Strict TypeScript everywhere (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `NodeNext`); no `any`, `@ts-ignore` or `@ts-expect-error` in `src`.                                                          | `tsconfig.base.json`, `pnpm typecheck`, type-aware ESLint                 |
      | AC-1.7 | Every boundary schema rejects malformed input with a zod issue, not a throw or a cast: ptyd request/response/event frames, hook envelopes, REST bodies, `/api/events` messages, `.emberline/worktree.yml` and the agent files. | `packages/protocol/src/**/*.test.ts`, `apps/ptyd/src/server.test.ts`; `packages/protocol/src/{ptyd,hooks}.test.ts` |
      | AC-1.8 | A ptyd that reports a protocol below `PTYD_MIN_PROTOCOL_VERSION` gets no spawn or exec from core (fail closed); the status page says which version core needs.                                                             | `apps/core/src/ops.test.ts`                                               |
      | AC-1.9 | With `DOCKER_HOST`, `EMBERLINE_RUN_ID`, `EMBERLINE_HOOK_TOKEN`, `EMBERLINE_CORE_URL` and provider API keys set in the shell, no test sees them, and `EMBERLINE_RUNNER_HOME` / `EMBERLINE_TOOLS_DIR` point at absent paths. | `apps/core/src/test-setup.ts`; `apps/core/src/workspace-manifests.test.ts` |
      | AC-1.10 | Tests import workspace packages from source (vitest aliases), so `pnpm test` passes on a checkout where nothing was built.                                                                                                 | `vitest.config.ts`                                                        |
      | AC-1.11 | No `.skip(`, `xit(` or `test.todo(` in any test file; capability-dependent tests skip only when the host capability (e.g. a Docker engine) is absent and run in `make ci`.                                             | `docs/TESTING.md` rule; `apps/core/src/workspace-manifests.test.ts` (also bans `.only(`) |

      Edge cases M1 must hold: a type-only import across a layer is still a crossing (lint does not exempt `import type`);
      a new workspace package must be added to `WORKSPACE` and given a `LAYERS` entry in `eslint.config.js` (and a row in the `ALLOWED` matrix of `workspace-layers.test.ts`, which fails until it has one); a schema widened with
      `z.looseObject` (hook payloads) still type-checks its known fields (a non-string `session_id` is rejected) while passing unknown ones through.

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
      and the React views. Acceptance criteria below; `apps/core/src/m3-workflows.test.ts` drives AC-3.1–3.6 through the REST
      routes the web calls and parses every response with its protocol schema.

      | AC     | Given / when / then                                                                                                                                                                  | Guard                                                                                   |
      | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
      | AC-3.1 | A ticket created with a priority and persona lands in `backlog` with a project key and moves through `ready → in_progress → review → done`; a malformed body is 400 and an unknown project or ticket 404, writing nothing. | `m3-workflows.test.ts`, `tickets.test.ts`                                               |
      | AC-3.2 | `dependsOn` by key or id fills `blockedBy`; a cycle (self included) is 409 `dependency_cycle` and leaves the stored set alone; moving the dependency to `done` empties `blockedBy`.   | `m3-workflows.test.ts`, `ticket-dependencies.test.ts`                                   |
      | AC-3.3 | Deleting a ticket while an agent still works on it (a turn under way, or a usage-limit pause that will resume; `isLiveRun` in `tickets/bulk.ts`) is refused, 409 `run_active` from `DELETE /api/tickets/:id` and a `run_active` failure in bulk; the drawer disables Delete meanwhile. A finished turn held open for review does not block it; a deleted ticket's runs are kept (`ticketId` null). | `m3-workflows.test.ts`, `tickets.test.ts`, `ticket-bulk-route.test.ts`                  |
      | AC-3.4 | A bulk close of a ticket with a run branch is refused (`merge_required`); the drawer's accept merges it, or "Move to Done without merging" closes it on purpose.                      | `m3-workflows.test.ts`, `ticket-bulk-route.test.ts`, `worktree-merge.test.ts`           |
      | AC-3.5 | The board export is valid `TicketExport` JSON (or RFC 4180 CSV) with whole-board counts; an unknown format, status or query key is 400.                                              | `m3-workflows.test.ts`, `ticket-export-route.test.ts`, `boardExport.test.ts`            |
      | AC-3.6 | Every board write is 401 without a session and 403 without the CSRF header, and changes nothing.                                                                                     | `m3-workflows.test.ts`, `auth-coverage.test.ts`                                         |
      | AC-3.7 | Review shows a run's diff per file, takes line comments and rounds, and a blocking comment closes the merge gate until it is resolved.                                               | `review*.test.ts`, `reviewGate.test.ts`, `reviewTree.test.ts`, `e2e/ui/run.mjs`         |

- [x] **M4 — Hardening: auth coverage, isolation and the end-to-end gate:**
      Gate verified (lint, typecheck, build, 3400+ tests). `apps/core/src/auth-coverage.test.ts` sweeps every registered `/api` route:
      anonymous callers get 401 outside the public, internal and demo-token routes, writes without the CSRF header get 403, and
      internal hook routes stay closed without a run token. A new route that forgets authentication fails that test.
      `make e2e` runs `e2e/smoke.mjs` and the isolation suite (`e2e/isolation.sh`, SR-01–SR-20) against an isolated core + runner + ops stack seeded with 0.6.x volumes.
      Supply chain: the CI `supply-chain` job gates every image push. It blocks unallowlisted high or critical `pnpm audit --prod`
      advisories, critical `pnpm audit --dev` advisories and any install script outside `better-sqlite3`, `esbuild` and `node-pty` (`scripts/supply-chain/`, tests in
      `gate.test.ts`; `strictDepBuilds` in `pnpm-workspace.yaml`). Pushed images get an SPDX SBOM and a cosign keyless signature
      and attestation (verification: SECURITY.md).

- [x] **M5 — Conflict-aware merging and self-healing merges (EMB-31):**
      Parallel tickets that edit the same files (`PROJECT.md`, `Makefile`, `.github/workflows/ci.yml`) used to end in
      "Could not merge EMB-24 into the main workspace (conflicts in …); it was left unchanged." and a person had to fix it.
      Conflicts are now handled in three layers, cheapest first; each layer is its own module so `tickets/service.ts` only gains call sites:

      1. **Prevent** (`tickets/overlap.ts`): a ticket's _claimed paths_ are the repo paths in its body's `## Target Files`
      section. Dispatch defers a ready ticket whose claims overlap a busy run's claims or the files that run's branch already
      changed (`git diff --name-only <main>...<branch>`), until that run is merged or held. _Shared hot files_
      (`PROJECT.md`, `CHANGELOG.md`, `README.md`, `docs/**`, lockfiles) never defer: layer 2 handles them. Factory setting
      `serializeOverlappingTickets` (default on). The planner prompt asks for `## Target Files` and for `dependsOn` between tickets that edit the same code file.

      2. **Self-heal deterministically** (`factory/conflict-heal.ts`): when the merge into main conflicts, core merges main into the
      run's branch in its worktree with `merge.conflictStyle=diff3` and resolves every hunk whose base side is empty (both sides
      only _added_ lines at the same spot) as ours-then-theirs; lockfile conflicts are left for the agent. If every conflicted
      file is resolved, it commits `Merge <main> into <branch> (auto-resolved: …)`, runs the worktree gate (build/lint/test) again and merges into main; a
      failing gate or any hunk that is a real edit/edit conflict aborts the heal (worktree back to its tip) and goes to layer 3.
      Factory setting `autoResolveAdditiveConflicts` (default on). Event `conflict_auto_resolved` with the files.

      3. **Escalate to an agent**: the run's own session gets the resolution prompt (as before, `CONFLICT_ATTEMPT_CAP`); when it
      cannot take a prompt (ended and not resumable) or the cap is spent with main still moving, core starts a _resolver run_ on
      the same ticket, worktree and branch (`conflict_resolver_started`), whose completion goes through the normal pipeline. A
      person's close (drawer accept, drag to Done → `POST /api/projects/:id/sync-worktree`) takes the same ladder instead of
      returning a bare failure: `SyncWorktreeResponse.resolution` is `auto_resolved | agent_resolving | resolver_started | manual`.

      Only when all three fail does the ticket stay in Review with the existing Hold Recovery suggestions.

      | AC     | Given / when / then                                                                                                                                                                  | Guard                                         |
      | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
      | AC-5.1 | Two tickets that both append a different target to `Makefile`, a job to `ci.yml` and a section to `PROJECT.md` both land in main with no person involved; each file keeps both additions. | `factory/conflict-heal.test.ts`, `m5-conflicts.test.ts`, `e2e/ui/run.mjs` (conflicts) |
      | AC-5.2 | An edit/edit conflict (both change the same line) is never auto-resolved: the heal aborts, the run's worktree, branch tip and index are as before, and the agent is asked. | `factory/conflict-heal.test.ts`, `m5-conflicts.test.ts` |
      | AC-5.3 | A heal whose re-run gate fails is undone and escalated with the gate's failure in the prompt; nothing reaches main.                                                                  | `m5-conflicts.test.ts`                        |
      | AC-5.4 | A conflicting run whose session ended and is not resumable gets a resolver run on the same branch; its successful completion merges and moves the ticket to Done.                 | `m5-conflicts.test.ts`                        |
      | AC-5.5 | `sync-worktree` on a conflicting run returns `ok: false` with a `resolution` other than `manual` whenever a layer took over, and the drawer says what happens next.                 | `m3-workflows.test.ts`, web tests             |
      | AC-5.6 | With 2 parallel slots, a ready ticket claiming `apps/x/a.ts` waits while a run that changed `apps/x/a.ts` is busy, and its card names the ticket it waits for; a claim on `PROJECT.md` alone never waits. | `ticket-overlap.test.ts`, web tests           |
      | AC-5.7 | The heal runs git in the ops container on the agent-writable worktree with the same refusals as the merge (no planted links in the git dir, no hooks run: `core.hooksPath=/dev/null`). | `factory/conflict-heal.test.ts`               |

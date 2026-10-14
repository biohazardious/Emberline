# Emberline

Self-hosted orchestrator for AI coding agents: a ticket board drives the **real Claude Code CLI** running in persistent terminals on your own server, with automatic resume when your subscription's usage window resets.

> [!IMPORTANT]
> **One installation = one user = that user's own Claude subscription.**
> Emberline is not a SaaS and has no account sharing or rotation features.
> Emberline is an independent project and is **not affiliated with or endorsed by Anthropic**.

Status: **MVP complete (M0–M6)**: PTY host, web terminal, Claude runs with hook-driven state, Kanban ticket board, quota-aware scheduler, Fleet Multiplexer (`/fleet`), and Monaco diff review with inline review annotations, commit/push, and worktree artifacts. See [PROJECT.md](PROJECT.md) for the design.

## Layout

| Path | What |
|---|---|
| `apps/core` | API, board, scheduler, git diff/commit/push & artifact layer (Fastify) |
| `apps/web` | ADE Workbench UI (React + Vite + xterm.js + Monaco Editor) |
| `apps/ptyd` | PTY holder daemon — keeps agent sessions alive across core restarts |
| `packages/protocol` | zod schemas for every wire contract |
| `packages/adapter-sdk` | Agent adapter interface |
| `packages/adapter-claude` | Claude Code adapter |
| `packages/hook` | `emberline-hook`, forwards Claude Code hooks to core |
| `deploy/truenas-compose.yaml` | TrueNAS SCALE dataset-backed Compose stack |

## Running (self-host)

Requirements: **Docker** with Compose v2 and `make`. Nothing else is installed on the host.

```bash
cp .env.example .env     # optional: bind address, port, pinned Claude Code version
make up                  # build + start core and runner → http://127.0.0.1:7420
make claude-login        # one time: log in with YOUR Claude subscription inside the runner
make upgrade-core        # rebuild/restart core only; running agents keep running
make logs / make down
```

Two containers: `core` (API + web UI, restart freely) and `runner` (ptyd + pinned Claude Code CLI, hosts the agents). They share only the ptyd socket and the workspaces volume (`runner-home` is mounted read-only into `core` so `git push` can use your runner's SSH/git credentials).

### TrueNAS SCALE Deployment

On TrueNAS SCALE 24.10+ (Electric Eel / Fangtooth), use [`deploy/truenas-compose.yaml`](deploy/truenas-compose.yaml) with dataset bind mounts:

```bash
# 1. Create datasets / directories on your pool and set ownership to node (1000:1000)
mkdir -p /mnt/tank/apps/emberline/{data,runner-home,workspaces}
chown -R 1000:1000 /mnt/tank/apps/emberline/{data,runner-home,workspaces}

# 2. Build and launch the stack
docker compose -f deploy/truenas-compose.yaml up -d --build

# 3. Log in once with your personal Claude subscription inside the runner
docker compose -f deploy/truenas-compose.yaml exec -it runner claude login
```

Set `EMBERLINE_BIND=0.0.0.0` (behind Tailscale or a TLS reverse proxy) and `TZ=Europe/Istanbul` (or your local IANA timezone) in your environment.

### Runs & Fleet Multiplexer

**Start run** on a project launches Claude Code in the runner:

- Git projects get an isolated worktree at `/workspaces/.worktrees/<project>/<id>` on a new branch `emberline/run-<id>`; plain directories run in place.
- Claude Code hooks are wired per run via `--settings`. `emberline-hook` posts them to core (`EMBERLINE_HOOK_URL`, default `http://core:7420` in compose) with a per-run token, and the UI shows live state: `starting` → `working` / `needs you` → `done` (or `failed` if the process exits non-zero).
- **Fleet Multiplexer (`/fleet`)** renders a `2×2`, `2×1`, or `1×1` grid of live agent terminals with an attention filter (`Waiting on you`) and inline steering prompts.
- Removing a run keeps its worktree and branch.

### Board

Each project has a Kanban board (**Board** on the dashboard): Backlog → Ready → In progress → Review → Done.

- Tickets get a key from the project name (`Demo Project` → `DP-1`). Drag cards to reorder or move them; dropping a `backlog`/`ready` card without an active run onto **In progress** automatically launches Claude.
- **Start with Claude** launches a run on branch `emberline/<key>-<title-slug>` with the title + description as the prompt. The card then follows the run live: working / needs you → *In progress*, turn finished → *Review*.
- From *Review*, a follow-up prompt is typed into the same live Claude session and the card moves back to *In progress*. Permission prompts are answered in the run's terminal.
- Runs never move a ticket out of *Done*. Deleting a ticket keeps its runs, branches and worktrees.

### Diff Review, Inline Annotations, Commit/Push & Artifacts (M6)

Every git-backed run has a **Review & Diff** workspace (available as a tab inside the Ticket Drawer and at `/runs/:id/review`):

- **Monaco Diff Editor:** Inspect side-by-side or inline diffs across `Branch vs base`, `Unstaged`, or `Staged` scopes with per-file `+additions / -deletions` and stage/unstage toggles.
- **Inline Diff Annotations:** Click any line in the Monaco diff to queue line-specific review notes (`path:line`) and click **Request Changes** to dispatch structured revision instructions directly to the live or resumable Claude session.
- **Commit & Push:** Stage and commit working-tree changes and push the run branch (`emberline/...`) to `origin` directly from the UI. Pushing to `main`, `master`, or the project's `defaultBranch` is blocked.
- **Worktree Artifacts & Pruning:** Browse and preview screenshots, Playwright traces, logs, and newly created files from the run's worktree. When `EMBERLINE_PLAYWRIGHT_MCP=1` is set on `core`, runs launch with headless `@playwright/mcp` (`playwright-mcp --headless --no-sandbox --output-dir ./artifacts`) wired via `--mcp-config`. Ended runs can prune their linked `.worktrees/` directory from the dashboard (`Prune worktree`) while preserving the git branch.

### Quota scheduler & Notifications

Every new run (from the dashboard or a ticket) is **queued** and dispatched by the scheduler:

- At most *N* agents run at once (default 2; picker on the dashboard, 1–4 there, API allows up to 8). Waiting for a prompt doesn't hold a slot.
- When any run hits the usage limit (Claude Code's `StopFailure` hook with `rate_limit`, or a "limit reached" banner on `Stop`), the run turns **rate limited**, a quota window opens and dispatch pauses.
- The reset time comes from the hook message or the terminal banner (`resets 2pm (Europe/Istanbul)`, `resets in 2h 5m`, …), read in `TZ` / `EMBERLINE_TIMEZONE`. If none can be read, it probes again every 15 minutes.
- At reset plus 30–120 s jitter, rate-limited runs get *"Continue where you left off."* (ended sessions are resumed with `claude --resume`), then the queue continues, in ticket priority order. If the limit hits again within 5 minutes, the same window reopens.
- **Resume now** (dashboard or ticket drawer) ends the pause early. Windows are stored in SQLite, so a core restart keeps the timer.
- **Notifications (`ntfy` / Webhook):** Configure an `ntfy.sh` topic or generic/Discord/Slack webhook URL on the Overview dashboard (or via `EMBERLINE_NOTIFY_URL`) to receive push notifications on quota limit reached, quota reset & auto-resume, agent waiting for input, or run completion.

## Development

All tooling runs in the `dev` image. Source is bind-mounted; `node_modules` and the pnpm store live in Docker volumes.

```bash
make dev                 # ptyd + core + web dev servers → http://localhost:5173
make check               # lint + typecheck + test + build
make test | lint | typecheck | build | format
make shell               # bash inside the toolbox
make attach              # interactive shell inside the dev ptyd (Ctrl-] detaches)
make lock                # after editing a package.json: update pnpm-lock.yaml
make ci                  # same gate CI runs (Dockerfile `check` target)
make clean               # drop dev volumes
```

> [!NOTE]
> Docker creates empty, root-owned `node_modules/` mount points in the repo. They are git-ignored and harmless.
> Editor IntelliSense has no host `node_modules`; use a Dev Container / remote container attach if you need it.

## License

Emberline is licensed under the **GNU Affero General Public License v3.0 or later** ([LICENSE](LICENSE)).
If you run a modified Emberline as a network service, you must offer its source to the users of that service.

The plugin/adapter contract packages are **Apache-2.0** so third-party adapters and plugins can use any license:

- [`packages/protocol`](packages/protocol/LICENSE)
- [`packages/adapter-sdk`](packages/adapter-sdk/LICENSE)

Claude Code is proprietary software by Anthropic. It is **not** covered by these licenses. The `runner` image installs it at build time
from npm under Anthropic's own terms. Emberline is not affiliated with or endorsed by Anthropic.

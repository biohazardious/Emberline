# Emberline

Self-hosted orchestrator for AI coding agents: a ticket board drives the **real Claude Code CLI** running in persistent terminals on your own server, with automatic resume when your subscription's usage window resets.

> [!IMPORTANT]
> **One installation = one user = that user's own Claude subscription.**
> Emberline is not a SaaS and has no account sharing or rotation features.
> Emberline is an independent project and is **not affiliated with or endorsed by Anthropic**.

Status: early development (MVP milestones M0–M3 done: PTY host, web terminal, Claude runs with hook-driven state). See [PROJECT.md](PROJECT.md) for the design.

## Layout

| Path | What |
|---|---|
| `apps/core` | API, board, scheduler, git layer (Fastify) |
| `apps/web` | Web UI (React + Vite) |
| `apps/ptyd` | PTY holder daemon — keeps agent sessions alive across core restarts |
| `packages/protocol` | zod schemas for every wire contract |
| `packages/adapter-sdk` | Agent adapter interface |
| `packages/adapter-claude` | Claude Code adapter |
| `packages/hook` | `emberline-hook`, forwards Claude Code hooks to core |

## Running (self-host)

Requirements: **Docker** with Compose v2 and `make`. Nothing else is installed on the host.

```bash
cp .env.example .env     # optional: bind address, port, pinned Claude Code version
make up                  # build + start core and runner → http://127.0.0.1:7420
make claude-login        # one time: log in with YOUR Claude subscription inside the runner
make upgrade-core        # rebuild/restart core only; running agents keep running
make logs / make down
```

Two containers: `core` (API + web UI, restart freely) and `runner` (ptyd + pinned Claude Code CLI, hosts the agents). They share only the ptyd socket and the workspaces volume.

### Runs

**Start run** on a project launches Claude Code in the runner:

- Git projects get an isolated worktree at `/workspaces/.worktrees/<project>/<id>` on a new branch `emberline/run-<id>`; plain directories run in place.
- Claude Code hooks are wired per run via `--settings`. `emberline-hook` posts them to core (`EMBERLINE_HOOK_URL`, default `http://core:7420` in compose) with a per-run token, and the UI shows live state: `starting` → `working` / `needs you` → `done` (or `failed` if the process exits non-zero).
- Removing a run keeps its worktree and branch.

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

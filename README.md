# Emberline

**A self-hosted workbench for AI coding agents.** Emberline runs the real agent CLIs (Claude Code, Codex, Gemini CLI, Antigravity, GitHub Copilot CLI, Aider) in persistent terminals on your own server, and puts a ticket board, a review workflow and a usage-aware scheduler around them.

Think of it as an issue tracker, an editor and a git client in one browser tab, with agents doing the work and you reviewing it.

> [!NOTE]
> **Early preview (0.x).** Emberline is used daily by its author, but it is young: expect rough edges, and back up before upgrading. Claude Code is the agent tested most; Codex, Gemini CLI, Antigravity, GitHub Copilot CLI and Aider support is **experimental**.

> [!IMPORTANT]
> **One installation = one user = that user's own subscriptions.**
> Emberline drives the official CLIs with your own logins. It is not a SaaS and has no account sharing, pooling or rotation features.
> Emberline is an independent project and is **not affiliated with or endorsed by** Anthropic, OpenAI, Google or GitHub.

## Features

- **Real CLIs in persistent terminals.** Agents run in a PTY daemon inside a separate `runner` container. Rebuilding or restarting the web app does not interrupt a running agent; you can attach to any session from the browser.
- **Ticket board.** A Kanban board per project (Backlog → Ready → In progress → Review → Done). Starting a ticket launches an agent on its own git worktree and branch. The card then follows the agent: working, needs you, ready for review.
- **Usage-aware scheduler.** Runs are queued with a concurrency limit. When a provider's usage limit is hit, Emberline reads the reset time, pauses dispatch and resumes the session automatically after the reset. **Settings → Quota & Concurrency** shows each provider's remaining limits.
- **Review.** A Monaco diff of each run (branch vs. base, staged, unstaged), inline line comments that go back to the agent as a revision request, commit, push and pull requests to your forge. Finished runs are merged into the project's main workspace from the UI.
- **Cross-provider review.** Optionally, a different CLI reviews a run's diff read-only before it is merged (for example, Codex reviewing Claude's work).
- **Quality gates.** A build/lint/test gate, and a pre-merge check for leftover secrets and debug code.
- **Fleet view.** Watch up to four agent terminals side by side, filter to the ones waiting for you and steer them inline.
- **Project tooling.** A new-project wizard that writes a `PROJECT.md` blueprint and starter tickets, a roadmap and brainstorming page, a code explorer and editor, a live view of the agent's headless browser, checkpoints with rollback, scheduled jobs and project export.
- **Personas.** Route roles (architect, coder, DBA, QA, security) to the agent and model you prefer.
- **Notifications.** ntfy or a webhook (generic, Discord, Slack) for usage limits, resumes, agents waiting for input and finished runs.
- **Operations.** Health checks, Prometheus metrics, online SQLite backups and automatic pre-migration snapshots.

## Quick start

Requirements: **Docker** with Compose v2 on a Linux host. The images are `linux/amd64`.

### From the published images

[`deploy/compose.yaml`](deploy/compose.yaml) is a single file that runs the images from the GitHub Container Registry. It also works as a "custom app" on TrueNAS, Portainer or Dockge.

```bash
curl -fsSLO https://raw.githubusercontent.com/biohazardious/emberline/main/deploy/compose.yaml
EMBERLINE_VERSION=0.1.0 docker compose up -d
docker compose logs core     # the first start prints a one-time setup token
```

### From source

Building from source additionally needs `make` and `git`; nothing else is installed on the host.

```bash
git clone https://github.com/biohazardious/emberline.git
cd emberline
cp .env.example .env     # optional: bind address, port, time zone
make up                  # build and start core + runner -> http://127.0.0.1:7420
make logs                # the first start prints a one-time setup token
```

### First steps

Open `http://127.0.0.1:7420`, enter the setup token and choose the admin password. Then:

1. **Install the CLIs** you want from **Settings → Multi-Agent & Model Matrix**. They are installed into a persistent volume in the runner, so they survive image updates and can be updated from the same page.
2. **Log in** to each provider once, with your own account: use the provider's **CLI OAuth Login (Terminal)** button on the same page, which opens a terminal in the runner, or run the CLI's login from a shell (`make claude-login`, `make codex-login`, `make gemini-login`, `make agy-login`, `make copilot-login` when built from source). Credentials stay in the runner's home volume. API keys, if you prefer them, can be set on the same page instead.
3. **Create a project** (wizard, empty directory or `git clone`) and start a ticket.

The running version is shown next to the logo.

Day-to-day commands (from source):

```bash
make upgrade-core        # rebuild and restart core only; running agents keep running
make backup              # consistent database snapshot, copied to ./backups/
make reset-password      # forgot the admin password: clears it, then use the new setup token
make down
```

## Configuration

Set these in `.env` (read by `compose.yaml`):

| Variable                        | Default        | Purpose                                                                                                                                                  |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBERLINE_BIND`                | `127.0.0.1`    | Host interface the web UI binds to. `0.0.0.0` exposes it to your network; see [Security](#security).                                                     |
| `EMBERLINE_PORT`                | `7420`         | Host port.                                                                                                                                               |
| `TZ`                            | `UTC`          | Your IANA time zone (for example `Europe/Berlin`). CLIs print reset times as wall-clock times ("resets 2pm"), and the scheduler reads them in this zone. |
| `EMBERLINE_WORKSPACES_HOST_DIR` | `./workspaces` | Host directory that holds the project workspaces.                                                                                                        |
| `EMBERLINE_METRICS_TOKEN`       | unset          | Enables `GET /metrics` for scrapers sending `Authorization: Bearer <token>`.                                                                             |

Core also understands the following variables. They are not passed through by `compose.yaml`; add them to the `core` service's `environment` if you need them:

| Variable                     | Default | Purpose                                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------------------- |
| `EMBERLINE_SETUP_TOKEN`      | random  | Choose the first-run setup token instead of reading it from the log.             |
| `EMBERLINE_TRUST_PROXY`      | `false` | Trust `X-Forwarded-*` from a reverse proxy in front of core.                     |
| `EMBERLINE_SECURE_COOKIES`   | `false` | Force `Secure` session cookies. Requests that arrive over HTTPS get them anyway. |
| `EMBERLINE_SESSION_TTL_DAYS` | `30`    | Login session lifetime.                                                          |
| `EMBERLINE_NOTIFY_URL`       | unset   | Default ntfy topic or webhook URL. It can also be set in the UI.                 |
| `EMBERLINE_BACKUP_KEEP`      | `10`    | Number of `make backup` snapshots to keep.                                       |
| `EMBERLINE_LOG_LEVEL`        | `info`  | pino log level.                                                                  |

## Desktop, mobile and embedded projects

Agents are not limited to web apps. The runner ships the system libraries that need root (Xvfb, GTK and webkit2gtk, clang and ninja), and the large SDKs are one click away in **Settings → Multi-Agent & Model Matrix → SDKs for Non-Web Projects** (agents can also run `emberline-sdk install <id>`):

| Project type                            | What the runner provides                                                                                   | Build & verify gate                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Electron                                | Node, Xvfb (`xvfb-run`) to launch the app and its UI tests                                                 | `npm run build` / `lint` / `test`                 |
| Tauri                                   | Rust, webkit2gtk and the other Tauri system libraries                                                      | npm steps, then `cargo check` in `src-tauri`      |
| Flutter (web, Linux, Android)           | `emberline-sdk install flutter`, clang/ninja/GTK; APKs need the Android SDK                                | `flutter analyze`, `flutter test`                 |
| Android, Capacitor, React Native / Expo | `emberline-sdk install android` (JDK 21 + Android SDK)                                                     | `./gradlew assembleDebug`                         |
| ESP32 / Arduino / STM32 (PlatformIO)    | `emberline-sdk install platformio`; `emberline-sdk install esp-qemu` to run ESP32 firmware without a board | `pio run`, plus `pio test -e native` when present |

A missing toolchain fails the gate with the command that installs it, so an agent can fix it itself. There is no display or Android emulator in the runner: GUI apps run under Xvfb and APKs are built, not run.

**Flashing a real board.** To let agents flash and monitor a USB serial board, enable [`compose.usb.yaml`](compose.usb.yaml) in `.env` (it is commented out in `.env.example`): set `EMBERLINE_SERIAL_DEVICE` to the board's `/dev/ttyUSB*` or `/dev/ttyACM*` device and `EMBERLINE_SERIAL_GID` to the group that owns it on the host (`stat -c %g /dev/ttyACM0`), then run `make up` with the board plugged in. With the published images, uncomment the `devices` and `group_add` lines in `deploy/compose.yaml` instead. The device keeps its name inside the runner. This works on Linux hosts; Docker Desktop on macOS and Windows cannot pass USB devices through.

## Security

Emberline gives AI agents a shell, your git credentials and your provider logins. Treat it like SSH access to the machine it runs on.

- **Keep it private.** By default it listens on `127.0.0.1` only. To reach it from other devices, put it behind a VPN (Tailscale, WireGuard) or a TLS reverse proxy. Plain HTTP on a LAN is tolerated, but passwords and session cookies then travel unencrypted.
- **Single admin account.** The first visitor needs the setup token from the server log, so nobody else on the network can claim a fresh instance.
- **Two containers, two roles.** `core` (API and UI) runs no workspace processes and ships without git, ssh or build tools. Everything that runs in a workspace (agents, git, installs, builds, tests) runs in `runner`. Git commands ignore repository hooks and command-running config.
- **The runner is one trust domain.** All agents and terminals run as the same user and can read each other's workspaces and the provider logins in the runner's home. Don't run agents for projects you don't trust next to ones you do.
- **Secrets are stored in plaintext** in the SQLite database in core's data volume. They are never sent back to the browser, but anyone with access to that volume or a backup can read them.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Architecture

```
 browser ──HTTP/WebSocket──▶ core (Fastify API + React UI, SQLite)
                               │  unix socket (ptyd protocol)
                               ▼
                             runner (Ubuntu + Node, ptyd, agent CLIs, Chromium)
                               │  agent hooks ──HTTP──▶ core
                               ▼
                             /workspaces (shared volume: projects and run worktrees)
```

| Path                      | What                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/core`               | API, board, scheduler, review/git layer and the factory services (Fastify, Drizzle, SQLite) |
| `apps/web`                | Web UI (React, Vite, xterm.js, Monaco)                                                      |
| `apps/ptyd`               | PTY daemon in the runner; keeps agent sessions alive across core restarts                   |
| `packages/protocol`       | zod schemas for every wire contract                                                         |
| `packages/adapter-sdk`    | Agent adapter interface                                                                     |
| `packages/adapter-claude` | Claude Code adapter (hooks, settings, personas)                                             |
| `packages/hook`           | `emberline-hook` and CLI wrappers; forward agent events from the runner to core             |

Design decisions and the reasons behind them are in [docs/DESIGN.md](docs/DESIGN.md).

## Operations

- **Health:** `GET /api/health` is the liveness check Docker uses. `GET /api/health/deep` also checks the database, the runner connection and protocol version, the workspaces volume and free disk space, and answers 503 with the failing check.
- **Metrics:** with `EMBERLINE_METRICS_TOKEN` set, `GET /metrics` exposes runs by state, tickets by column, scheduler queue and quota pause, runner connection, database size and HTTP responses.
- **Backups:** `make backup` takes a consistent snapshot (`VACUUM INTO`, safe while running), keeps the newest `EMBERLINE_BACKUP_KEEP` in the data volume and copies it to `./backups/`. Core also snapshots the database before applying migrations.
- **Logs:** structured JSON on stdout, `make logs`.
- **Upgrades:** with the published images, change `EMBERLINE_VERSION` (or keep `latest`), then `docker compose pull && docker compose up -d`; from source, `git pull && make up`. Core snapshots the database before it applies migrations. Restarting the runner stops running agents, so upgrade when they are idle. See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Development

All tooling runs in Docker; the source is bind-mounted and `node_modules` lives in volumes.

```bash
make dev                 # ptyd + core + web dev servers -> http://localhost:5173
make check               # lint + typecheck + test + build
make e2e                 # isolated core + runner stack and an end-to-end smoke test
make shell               # shell inside the toolbox
make lock                # after editing a package.json
make help                # everything else
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

Emberline is licensed under the **GNU Affero General Public License v3.0 or later** ([LICENSE](LICENSE)). If you run a modified Emberline as a network service, you must offer its source code to the users of that service.

The contract packages [`packages/protocol`](packages/protocol/LICENSE) and [`packages/adapter-sdk`](packages/adapter-sdk/LICENSE) are licensed under **Apache-2.0**, so third-party adapters can use any license.

The agent CLIs are third-party software under their vendors' own terms and are not part of Emberline. They are not included in the images; you install them from **Settings → Multi-Agent & Model Matrix**. The runner image includes the open-source Chromium browser.

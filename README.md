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
- **Review.** A Monaco diff of each run (branch vs. base, staged, unstaged), typed inline and whole-file comments (intent, priority) that go back to the agent as review rounds you verify, blocking comments that keep the merge gate closed, commit, push and pull requests to your forge. Finished runs are merged into the project's main workspace from the UI.
- **Issue import.** Pull GitHub, GitLab or Gitea issues into the board as tickets, by hand or with an opt-in label sync, and get progress comments (and optionally a close) on the issue. The forge token needs issue read/write scope; issue text is shown to the agent as the author's request, not as instructions.
- **Cross-provider review.** Optionally, a different CLI reviews a run's diff read-only before it is merged (for example, Codex reviewing Claude's work).
- **Completion signal.** Claude agents confirm a ticket is finished with an `emberline` tool, with a handoff note for dependent tickets; the factory waits for it and holds blocked tickets for you.
- **Quality gates.** A build/lint/test gate, and a pre-merge check for leftover secrets and debug code. Each project can override the gates (Inherit / On / Off) on its Project settings page.
- **Inbox.** Every run that needs you, across all projects, in one list: answer a question inline, and dismiss failures. You get one page per thing that needs you, and none while you have that run open.
- **Fleet view.** Watch up to four agent terminals side by side, grouped into Needs you, Ready for review, Working and Recently finished, and steer them inline. The Inbox lists what needs you across all projects.
- **Project tooling.** A project wizard (new idea or import from a Git URL or workspaces folder) that previews and writes `PROJECT.md`, `CLAUDE.md` and `.emberline/worktree.yml` and creates a Bootstrap ticket, per-project `worktree.yml` setup/services/checks, Preview & Build (each target's container preview or static build, with when and from which commit it was built; main's is rebuilt after every merge), a roadmap and brainstorming page, a code explorer and editor, a live view of the agent's headless browser, checkpoints with rollback, scheduled jobs and project export.
- **Build outputs.** APKs, installers and firmware are archived per project when a run finishes, so they outlive worktree cleanup. A Build Outputs page lists, downloads, pins and prunes them within a per-project quota.
- **Personas.** Route roles (architect, coder, DBA, QA, security) to the agent and model you prefer.
- **Notifications.** ntfy or a webhook (generic, Discord, Slack) for usage limits, resumes, agents waiting for input and finished runs.
- **Operations.** Health checks, Prometheus metrics, online SQLite backups and automatic pre-migration snapshots.

## Quick start

Requirements: **Docker** with Compose v2 on a Linux host. The images are `linux/amd64`.

### From the published images

[`deploy/compose.yaml`](deploy/compose.yaml) is a single file that runs the images from the GitHub Container Registry. It also works as a "custom app" on TrueNAS, Portainer or Dockge.

```bash
curl -fsSLO https://raw.githubusercontent.com/biohazardious/Emberline/main/deploy/compose.yaml
docker compose up -d         # the latest release; pin one with EMBERLINE_VERSION=<version>
docker compose logs core     # the first start prints a one-time setup token
```

The privileged, rootless [Docker engine](#docker-engine) for agents and compose previews is on by default; set `EMBERLINE_DOCKER_ENGINE=0` in `.env` to turn it off.

### From source

Building from source additionally needs `make` and `git`; nothing else is installed on the host.

```bash
git clone https://github.com/biohazardious/Emberline.git
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

| Variable                         | Default        | Purpose                                                                                                                                                                                                                           |
| -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBERLINE_BIND`                 | `127.0.0.1`    | Host interface the web UI binds to. `0.0.0.0` exposes it to your network; see [Security](#security).                                                                                                                              |
| `EMBERLINE_PORT`                 | `7420`         | Host port.                                                                                                                                                                                                                        |
| `TZ`                             | `UTC`          | Your IANA time zone (for example `Europe/Berlin`). CLIs print reset times as wall-clock times ("resets 2pm"), and the scheduler reads them in this zone.                                                                          |
| `EMBERLINE_WORKSPACES_HOST_DIR`  | `./workspaces` | Host directory that holds the project workspaces.                                                                                                                                                                                 |
| `EMBERLINE_ALLOWED_HOSTS`        | unset          | Comma-separated host names you open Emberline by, such as `emberline.example.com` or `truenas.local` (through a reverse proxy, say). IP addresses and `localhost` always work; other names get HTTP 421. `*` turns the check off. |
| `EMBERLINE_SESSION_BIND_IP`      | `true`         | A login is valid only from the network address that signed in (behind a proxy, with `EMBERLINE_TRUST_PROXY`, the forwarded address). A changed address signs you out. `false` turns this off; see [SECURITY.md](SECURITY.md#preview-ports-and-the-session-cookie). |
| `EMBERLINE_METRICS_TOKEN`        | unset          | Enables `GET /metrics` for scrapers sending `Authorization: Bearer <token>`.                                                                                                                                                      |
| `EMBERLINE_PREVIEW_PORTS_RUNNER` | `4300-4324`    | Host ports for command previews (dev servers), published by the runner on `EMBERLINE_BIND`.                                                                                                                                       |
| `EMBERLINE_PREVIEW_PORTS_DOCKER` | `4325-4349`    | Host ports for compose previews, published by the Docker engine. Keep the two ranges apart.                                                                                                                                       |
| `EMBERLINE_PREVIEW_HOST`         | unset          | Base URL previews open on, such as `http://previews.lan` (a second name for this machine); unset uses the host name you opened Emberline by. A separate name keeps Emberline's session cookie away from previews ([SECURITY.md](SECURITY.md#preview-ports-and-the-session-cookie)). |
| `EMBERLINE_DOCKER_ENGINE`        | `1`            | `0` turns the [Docker engine](#docker-engine) off; it is on by default. |
| `EMBERLINE_DOCKER_HOST`          | `tcp://docker:2376` | Where core reaches the engine. Only change it for an engine of your own; `EMBERLINE_DOCKER_ENGINE=0` wins over it. |

Core also understands the following variables. They are not passed through by `compose.yaml`; add them to the `core` service's `environment` if you need them:

| Variable                     | Default | Purpose                                                                                                                                                                                                                                  |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBERLINE_SETUP_TOKEN`      | random  | Choose the first-run setup token instead of reading it from the log.                                                                                                                                                                     |
| `EMBERLINE_TRUST_PROXY`      | `false` | Trust `X-Forwarded-*` from a reverse proxy in front of core. The proxy must overwrite `X-Forwarded-Host` and `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-Host $host;` and `proxy_set_header X-Forwarded-For $remote_addr;`, not `$proxy_add_x_forwarded_for`: sessions are bound to that address), and core should be reachable only through it (`EMBERLINE_BIND=127.0.0.1`). |
| `EMBERLINE_SECURE_COOKIES`   | `false` | Force `Secure` session cookies. Requests that arrive over HTTPS get them anyway.                                                                                                                                                         |
| `EMBERLINE_CONTAINER_HOSTS`  | `runner,docker` | Host names of Emberline's own containers; a session cookie that arrives from their addresses gets HTTP 403. |
| `EMBERLINE_SESSION_TTL_DAYS` | `30`    | Login session lifetime.                                                                                                                                                                                                                  |
| `EMBERLINE_NOTIFY_URL`       | unset   | Default ntfy topic or webhook URL. It can also be set in the UI.                                                                                                                                                                         |
| `EMBERLINE_BACKUP_KEEP`      | `10`    | Number of `make backup` snapshots to keep.                                                                                                                                                                                               |
| `EMBERLINE_LOG_LEVEL`        | `info`  | pino log level.                                                                                                                                                                                                                          |

## Project worktree setup: `.emberline/worktree.yml`

Each run gets a fresh git worktree. A `.emberline/worktree.yml` in the project tells Emberline how to prepare it, run it and verify it (the wizard writes one for you):

```yaml
version: 1
copy:                 # from the main workspace into each new run worktree
  - .env
  - { path: .env.local, mode: symlink }   # copy (default) | symlink
setup:                # run in a fresh run worktree before the agent starts
  - "[ ! -f package.json ] || pnpm install --frozen-lockfile"   # skipped until the skeleton exists
teardown:             # run before the worktree is pruned
  - docker compose down
services:             # long-running processes; $PORT is assigned by Emberline
  - name: web
    command: pnpm dev --port $PORT --host 0.0.0.0
    preview: true     # the run's Preview button starts this one
checks:               # override the build gate's detected steps (in order)
  build: pnpm build
  lint: pnpm lint
  test: pnpm test
```

**Containers (version 2).** With the [Docker engine](#docker-engine) on, a `version: 2` file can preview a service of the project's own compose file instead of a command:

```yaml
version: 2
services:
  - name: dev
    command: pnpm dev --port $PORT --host 0.0.0.0   # still available, no longer the preview
  - name: container
    compose: { file: compose.yaml, service: web, port: 8080 }   # file defaults to compose.yaml; port is the container's
    preview: true
```

Preview then runs `docker compose up -d --build web` in the engine under its own compose project and publishes the container port on a free port of `EMBERLINE_PREVIEW_PORTS_DOCKER`. Host ports and `container_name` fixed in the compose file are dropped for the preview, so parallel runs never collide. Top-level volumes and networks that set an explicit `name:` are not renamed: every run's preview (and every agent) shares them, so leave `name:` out unless you want that. The preview shows "starting" while it builds, and a failed build or a container that exits shows the end of its output. With the engine turned off, Preview says so and how to turn it on. The wizard writes such a file for the Docker Compose deploy target while the engine is on.

**Preview & Build and Live Browser.** With a compose preview service and the engine on, the project's **Preview & Build** tab opens main and every run on its container preview: its state, **Start** / **Stop**, the end of the output when it fails, and the page itself (**Open** gives a new tab). Main's preview runs from the main workspace under its own compose project, `emberline-main-<id>-preview`, and is rebuilt after every merge into main; when that refresh fails the preview is down until you press **Start**. The static build stays under **Static build**: it shows when and from which commit it was built, and main's is rebuilt after every merge with the approved setup and checks. Live Browser's **Open Project Demo**, **Auto-Interact** and **Run QA Browser Check** start the container preview first and open it in the shared browser at the address the runner reaches (`http://docker:<port>/`); without one they open the static build. Claude runs get a `preview` tool that does the same for their own worktree (pre-allowed in the `auto` and `bypassPermissions` modes, asked for in the others), and `$EMBERLINE_DEMO_URL` points at the run's own static build.

**Trust.** Every command runs in the runner, and agents can edit this file. Emberline therefore runs only the version you approved on **Project settings**, and only the version committed in the main workspace (HEAD of its checked-out branch) can be approved, so commit it there first. If the file changes (an agent's edit is merged with its run like any other file) or is removed, the Board and Project settings show "worktree.yml changed — review" with a diff, and the old approved version keeps applying until you approve the new one. A file that cannot be used (a symbolic link, over 64 KB, invalid) shows its errors instead and cannot be approved.

**Limits.** Each setup command may take 10 minutes and the whole setup 30 minutes; a failed or cut-short setup still starts the agent, which is told what failed. A `copy` entry over 200 MB or 5000 files and directories is skipped. Teardown commands get 2 minutes each; a prune or clean-up waits up to 60 seconds for them, then they finish in the background.

**Copy and symlink.** Copied files are not committed for you: copied `.env*` files that git does not ignore are flagged to the agent, so keep `.env` in `.gitignore`. Symlink mode lets a run modify the main workspace's file.

**Removing a project.** **Remove from Emberline** keeps the project's folder; **Remove and delete files** deletes it. A project imported from a workspaces folder keeps its files unless you choose the second.

## Docker engine

Some projects only run in containers: their own compose file, a database, system packages. Emberline runs an isolated Docker engine next to the runner, so agents can build and run containers and Preview can show a compose service. It is on by default: `make up` and `docker compose up -d` start it. The first start pulls `docker:29.8.2-dind-rootless` (a few hundred MB).

**Turning it off.** Add this line to `.env` and run `make up` again (with the published images, `docker compose up -d`):

```sh
EMBERLINE_DOCKER_ENGINE=0
```

Core and the runner then run without Docker, and no engine container is created. Do this on a host that refuses privileged containers or overlayfs: there the `docker` service keeps restarting, the Dashboard shows "Docker engine: unreachable" with the reason, and everything else keeps working, but the wizard writes command previews instead of compose previews. Remove the line and run `make up` to turn it on again. The Dashboard shows "Docker engine: on (version)", "off", or "unreachable" with the reason.

**Stopping it.** `make down` stops the engine with the rest. To stop only the engine while the rest runs, use `docker compose stop docker` (remove its container with `docker compose rm -sf docker`); Emberline then shows it as unreachable until you start it again, so for good set `EMBERLINE_DOCKER_ENGINE=0`.

**Upgrading from 0.3.4 or earlier.** The `COMPOSE_PROFILES=docker` and `EMBERLINE_DOCKER_HOST` lines in `.env` are not needed any more; leaving them does no harm. `make up-docker` is gone: `make up` does the same.

**What agents get.** While the engine answers, every run gets `DOCKER_HOST` and the client certificate variables, plus `EMBERLINE_COMPOSE_PROJECT` (`emberline-` and the first 8 characters of the run id). Its first prompt asks the agent to use that compose project, not to publish fixed host ports, and to stop what it started. A run that takes over another run's worktree keeps that compose project. `worktree.yml` setup and teardown commands and Run Build & Verify's setup get the same variables. All agents share this one engine.

**Preview ports.** Command previews use `EMBERLINE_PREVIEW_PORTS_RUNNER` (default 4300-4324), published by the runner; compose previews use `EMBERLINE_PREVIEW_PORTS_DOCKER` (default 4325-4349), published by the engine. Both are published on `EMBERLINE_BIND`, and the preview link uses the host name you opened Emberline by (`EMBERLINE_PREVIEW_HOST` overrides it). With the default bind `127.0.0.1` the links open only on the Docker host itself; from other devices, reach those ports the way you reach Emberline (a VPN, or a bind address on a private interface).

**Cleanup.** When a worktree is pruned (by hand, by **Clean up worktrees**, by the automatic clean-up, or with its project), Emberline runs its teardown commands and then `docker compose down -v --rmi local --remove-orphans` for the worktree's compose project and for the preview project of every run in it (up to 2 minutes per `down`). That removes their containers, volumes and the images they built; images pulled under their own tag stay. Deleting a run does the same for its preview project, and for its own project when no other run works in that worktree. A Stop only stops the preview's containers. The first sweep runs a minute after Emberline starts and then every 30 minutes: it removes compose projects named `emberline-…` whose run is gone or ended without a worktree (up to 10 at a time). Once a day it also deletes dangling images and build cache older than 72 hours. It never touches a compose project with another name. Files that a container wrote into the worktree as a user other than root belong to a user the runner cannot delete. When the normal removal fails on them, Emberline hands them back through a throwaway `busybox` container (pulled the first time) and removes the worktree again.

**Docker page.** While the engine is on, the sidebar shows **Docker**. It lists Emberline's own compose projects in the engine (Agents, Previews, Build & Verify, and Leftovers that the cleanup removes), with their containers, state and published ports (a port of `EMBERLINE_PREVIEW_PORTS_DOCKER` is a link, like a preview link), the engine's disk use, and when the cleanup and the image prune last ran. **Logs** shows the end of a project's output, **Stop** takes its containers down and keeps its volumes, **Remove** also deletes its volumes and the images it built, and **Clean up now** runs the cleanup with the prune at once. Leftovers only offer **Remove**: a stopped leftover would keep its volumes, and the cleanup could no longer find it. Stopping a running agent's project is allowed, with a warning, since the agent may be using it. Compose projects with other names never appear there.

**Privileged, but rootless.** Docker inside a container needs the `privileged` flag, also in rootless mode. In plain words: the engine container can reach much more of the host's kernel than an ordinary container (devices, mounts, kernel settings). Emberline uses the rootless engine, so the Docker daemon and every container it starts run as an unprivileged user (uid 1000 and its sub-uids), never as root on the host. The host's Docker socket is never mounted, so agents cannot see or control the host's own containers. It is on by default; if you do not accept that trade, turn it off with `EMBERLINE_DOCKER_ENGINE=0`. [SECURITY.md](SECURITY.md#the-docker-engine) has the details.

**Storage.** Images, containers and volumes live in the `docker-data` volume. `make down` keeps it; `docker compose down -v` deletes it, along with the engine's certificates (a new set is made at the next start). The engine stores layers with overlayfs, which works on ext4, xfs and btrfs; on ZFS (TrueNAS, for example) it needs OpenZFS 2.2 or later.

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
- **Host names are checked.** Requests whose `Host` is not an IP address, `localhost` or a name in `EMBERLINE_ALLOWED_HOSTS` get HTTP 421, which stops DNS-rebinding pages from reaching Emberline through your browser. WebSocket connections must also carry an `Origin` header.
- **Single admin account.** The first visitor needs the setup token from the server log, so nobody else on the network can claim a fresh instance.
- **Two containers, two roles.** `core` (API and UI) runs no workspace processes and ships without git, ssh or build tools. Everything that runs in a workspace (agents, git, installs, builds, tests) runs in `runner`. Git commands ignore repository hooks and command-running config.
- **The Docker engine is privileged, and on by default.** It runs rootless and never gets the host's Docker socket, and its API needs a client certificate, but the container itself is privileged, and anything that can start containers in it (every agent) can control all of it. See [Docker engine](#docker-engine).
- **Preview ports are published.** The runner publishes 4300-4324 on `EMBERLINE_BIND` on every install; with `0.0.0.0` a running preview is open to your network without a login.
- **The runner is one trust domain.** All agents and terminals run as the same user and can read each other's workspaces and the provider logins in the runner's home. Don't run agents for projects you don't trust next to ones you do.
- **Secrets are stored in plaintext** in the SQLite database in core's data volume. They are never sent back to the browser, but anyone with access to that volume or a backup can read them.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Provider terms

Emberline runs each vendor's official CLI, signed in with your own account, and never handles the login tokens itself. Usage limits come from what the CLIs report. Whether a subscription may be used this way is up to each vendor:

- **Claude Code:** Anthropic allows running the unmodified Claude Code binary with your own Claude subscription, including on a platform that hosts it. Their plans are sized for ordinary individual use, so keep concurrency and automatic runs reasonable.
- **Antigravity:** Google does not support using an Antigravity consumer login (Google AI Pro/Ultra) inside third-party tools and has suspended accounts for it. Settings asks you to accept that risk before Antigravity can be enabled, and Emberline never adds it to a fallback chain for you.
- **Gemini CLI:** Google ended consumer Google logins in Gemini CLI on 2026-06-18. Use a Gemini API key or a Gemini Code Assist Standard/Enterprise account.
- **Others:** check the current terms of each CLI you enable. An API key is always the safest route.

Last checked 2026-10-16. Vendors change these terms without notice; Settings shows the current notes per provider.

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

# Changelog

All notable changes to Emberline are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, any release may change behaviour or configuration; read the notes before upgrading.

## [Unreleased]

## [0.1.1] - 2026-10-16

### Added

- Runs show their full final answer (Events, Run Inspector, Fleet), recovered from the transcript for runs recorded before this change.
- The terminal's last screen is kept when an agent session closes.
- "Build outputs" list the APKs, installers and firmware images a run produced, with their full paths (host path when known), in Review, the ticket drawer and Fleet; they can be downloaded.
- Finished runs stay in Fleet's Live view for 15 minutes with their final answer; they can be hidden.
- Roadmap milestones can be filtered by status (several at once, e.g. everything but Done) and category, and searched by item, ticket key or milestone; the choice is remembered per project.

### Fixed

- Event details are no longer cut at 500 characters; long ones collapse with "Show more".
- Stops made by the factory pipeline are recorded as system events with their reason, not as user stops.
- Roadmap items labelled both Idea and Planned as "TODO"; they now read Idea, To do, In progress and Done.

## [0.1.0] - 2026-10-15

First public preview.

### Agents and runs

- Runs the official agent CLIs in persistent terminals inside a separate `runner` container. Restarting or upgrading the web app never stops a running agent.
- Claude Code with hook-driven state (working, needs you, done), plus experimental support for Codex, Gemini CLI, Antigravity, GitHub Copilot CLI and Aider.
- Each run works in its own git worktree and branch.
- A usage-aware scheduler queues runs with a concurrency limit. When a provider's usage limit is hit, it reads the reset time, pauses dispatch and resumes the session automatically afterwards.
- Personas (architect, coder, DBA, QA, security) can be routed to different agents and models.

### Workflow

- A Kanban board per project; starting a ticket launches an agent and the card follows it.
- Review: a Monaco diff with inline line comments that go back to the agent, plus commit, push and pull requests (GitHub, GitLab, Gitea), and merging a finished run into the main workspace.
- Quality gates before merge:
  - build/lint/test;
  - a scan for leftover secrets and debug code;
  - an optional read-only review of the diff by a different provider.
- Fleet view of up to four agent terminals, a new-project wizard, a roadmap page, a code explorer, a live view of the agent's headless browser, checkpoints with rollback, scheduled jobs and notifications (ntfy, webhooks).

### Desktop, mobile and embedded projects

- The runner ships Xvfb, the GTK/webkit2gtk libraries for Tauri and Flutter Linux builds, and headless Chromium.
- Settings installs pinned SDKs into a persistent volume, already on the agents' PATH: PlatformIO, JDK 21 with the Android SDK, Flutter, and Espressif's ESP32 QEMU. Agents can also install them with `emberline-sdk`.
- The build gate checks every ecosystem in a project: npm, PlatformIO, Tauri, Cargo, Go, Flutter and Gradle. A missing toolchain fails the gate with the command that installs it.
- Optional USB serial passthrough (`compose.usb.yaml`) lets agents flash and monitor a real board.

### Operations and security

- Single admin account claimed with a one-time setup token. HTTP-only session cookies with CSRF checks. Secrets are write-only in the API.
- Core never runs workspace code; git, installs, builds and agents all run in the runner.
- Health checks, Prometheus metrics, online SQLite backups and automatic pre-migration snapshots.
- Images for `linux/amd64` on the GitHub Container Registry: `emberline-core` and `emberline-runner`. `deploy/compose.yaml` runs them from a single file.

[Unreleased]: https://github.com/biohazardious/emberline/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/biohazardious/emberline/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/biohazardious/emberline/releases/tag/v0.1.0

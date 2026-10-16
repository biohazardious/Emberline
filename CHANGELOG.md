# Changelog

All notable changes to Emberline are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, any release may change behaviour or configuration; read the notes before upgrading.

## [Unreleased]

### Added

- A run whose turn died on a temporary provider error (503 / unavailable, overloaded, 5xx, network errors) is retried automatically after 1, 5 and 15 minutes, continuing the same session. It waits as "retrying n/3" without pausing other runs; sign-in, billing, quota and request errors are never retried, a stop cancels the pending retry, and after the third failure the run is left for you as before.
- Fallback chains: each persona has an ordered list of routes (provider, model, and sign-in, API key or — for Antigravity — AI credits). Settings → Multi-Agent & Model Matrix sets them and two policies: whether new runs wait for a provider's quota to reset or start on the next route, and whether a run that runs out of quota waits or hands off to the next route. A handoff continues in the same worktree and branch with a summary of the work so far; it shows as "handed off" with links between the runs, and a waiting run offers "Continue with…" (another route of its chain, its persona's chain or any enabled provider).
- Quota limits are tracked per provider, sign-in and model pool: one provider running out no longer pauses the others. Each exhausted lane has its own countdown and "Try now".
- Notifications name the lane that ran out ("Antigravity (all models) quota reached …") and say when it is back.
- Settings shows the Claude account's extra usage (it is set on claude.ai).

### Fixed

- Claude Code runs could stop at the Claude in Chrome dialog ("Claude in Chrome extension detected — use my browser?"), shown when the signed-in account has the extension on another computer. Runs now start with `--no-chrome` and the dialog is pre-answered; an answer you already gave is kept.
- Antigravity's "Individual quota reached … Resets in 31h43m" (RESOURCE_EXHAUSTED / 429) failed the run instead of waiting for the reset; quota and rate-limit errors of every CLI (429, RESOURCE_EXHAUSTED, "quota exceeded") are now recognised, billing errors are not.
- Gemini CLI, Codex, Copilot and Aider runs resumed after a limit started over without context; they now get the task, the last message and the worktree state.
- Scheduled (cron) jobs were skipped while any provider was out of quota; they now start, and only a job whose own provider is out of quota waits queued for it.
- Claude Code's spend-limit messages ("You've hit your monthly spend limit") and the end of its own usage-limit wait are recognised as limits, so the run waits for the reset or hands off like any other limit.

### Upgrading

- Migration 0013 runs on start (a database backup is taken first).
- Persona settings become one-step chains. A persona whose provider had an API key saved keeps using that key (route "API key"); put a "Sign-in" route first if you want the subscription used first.
- "Auto-downgrade Claude" is gone: Fable and Opus personas no longer step down to Sonnet at 80 % Claude usage. If it was on, Sonnet becomes the persona's second route, which is only used when a policy is set to "Start on the next route" / "Hand off to the next route"; with the default policies the persona waits for Claude's reset instead.
- Antigravity runs no longer receive the Gemini API key; they use the Antigravity sign-in.
- Antigravity's "Use AI credits" is now set by Emberline for each run: off for "Sign-in" routes, on for "AI credits" routes. A value switched by hand in agy is overwritten by the next run; add an "AI credits" route to the chain instead.
- Both policies default to "wait": work whose provider is out of quota waits for that provider's reset while the other providers keep working.
- The factory still works on one ticket at a time per project, so a ticket waiting for a provider's quota holds that project's queue unless the persona has a fallback route and a policy is set to use it.

## [0.1.3] - 2026-10-16

### Added

- Update tracking (Settings → Updates): checks GitHub for a newer Emberline release, npm and PyPI for the installed agent CLIs, and npm for the MCP servers run through npx. Checks run every 12 hours (can be turned off; then nothing is sent) and on demand. A newer Emberline shows its release notes and the upgrade commands; CLIs update with one click, and an npx MCP server's cached copy can be dropped so its next start fetches the latest version. A dot next to the version in the sidebar shows when updates are available. An optional GitHub token (only sent to api.github.com) is needed while the repository is private.

### Fixed

- Claude Code's "Try the new fullscreen renderer?" dialog could appear in the middle of a run; accepting it relaunched Claude Code and dropped the turn in progress. Runs now pin the classic renderer (which also suppresses the offer), hide spinner tips and disable the feedback survey, so nothing in the terminal waits for an answer the agent cannot give.
- A run whose Claude Code session restarted (`resume`) or was cleared showed as working while the agent sat at an empty prompt; it now shows as waiting for you.
- Claude Code runs pre-answer every other dialog that could wait in the terminal: the bypass-mode warning (whose default is "exit"), approval of a project's `.mcp.json` servers, the "use this API key?" question for a key set in Settings (default "No"), the onboarding screen of API-key-only installs, effort and auto-mode nudges, resume screens, LSP plugin offers and the cost-threshold acknowledgement.
- Starting a Claude run without a Claude login or API key fails at once with instructions instead of waiting at Claude Code's sign-in screen. Login detection no longer mistakes a leftover `~/.claude.json` for a login.
- Codex: auto mode used the removed `--full-auto` flag and failed at once; Codex's own sandbox cannot run in the runner, so runs now use the container as the sandbox. Update offers are off, an OpenAI key from Settings reaches `codex exec`, and the interactive UI no longer asks to trust the repository.
- Gemini CLI refused to run in run worktrees ("not running in a trusted directory", exit 55) and silently dropped `--yolo`. Accept-edits now maps to `--approval-mode auto_edit`; update offers are off and an API key skips the auth picker.
- GitHub Copilot CLI: unattended runs may use their tools without asking, `/workspaces` is a trusted folder, auto-update is off.
- Antigravity: interactive sessions asked "Do you trust the contents of this project?" for every run worktree; the worktree is now trusted before the session starts.
- Aider could not be installed (it does not support Python 3.14; it now gets its own Python 3.12), stopped at first-run questions, edited the project's `.gitignore`, and reported failed logins as success.

## [0.1.2] - 2026-10-16

### Fixed

- "Back" on a terminal page returns to the page that opened it (Settings, a board, Overview, Fleet) instead of always going to Overview; opened directly, it still goes to Overview. The board's back arrow works the same way.
- Settings tabs, Overview sections and the open ticket with its drawer tab are kept in the address (`?tab=`, `?section=`, `?ticket=&view=`), so coming back from a login or install terminal, a run's terminal or a reload restores them instead of resetting to the first tab.

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

[Unreleased]: https://github.com/biohazardious/emberline/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/biohazardious/emberline/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/biohazardious/emberline/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/biohazardious/emberline/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/biohazardious/emberline/releases/tag/v0.1.0

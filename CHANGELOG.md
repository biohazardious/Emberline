# Changelog

All notable changes to Emberline are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, any release may change behaviour or configuration; read the notes before upgrading.

## [Unreleased]

### Security

- Downloading a run's build output now reads the file that was checked, through one open file handle that never follows a symbolic link. Before, an agent could swap the file for a link between the check and the download and have core send any file it can read, such as its own database. A run worktree that was replaced by a link is neither listed nor served.

### Added

- Build Outputs page under Code Explorer. Build outputs (APKs, installers, firmware) are archived per project each time a run finishes a turn or fails, and right before any worktree is pruned (manual cleanup, per-run prune, automatic cleanup), so a deliverable in a git-ignored `build/` folder survives its worktree. The archive sits in `.emberline-outputs` on the workspaces volume; deleting a project removes its archive. The page lists outputs with size, ticket and run, and lets you download, pin, delete, search and filter them, copy the path on the host, and "Collect now" from runs that still have a worktree. Each project has a quota (default 5 GB, 0.5 to 1000 GB) in **Settings → Quota & Concurrency**; when it is exceeded the oldest unpinned outputs are removed first. Problems (quota full, an output larger than the quota, a failed copy) appear as notes in the run's timeline and never hold up a run or its pipeline. In Fleet, a finished run shows a compact "n outputs" badge that opens the page filtered to that run.

## [0.2.1] - 2026-10-17

### Security

- Core now answers HTTP 421 to requests whose `Host` is an unknown name, which blocks DNS-rebinding attacks from web pages. **Upgrade note:** if you open Emberline by a host name (a reverse proxy, `truenas.local` and so on), add it to `EMBERLINE_ALLOWED_HOSTS` in `.env` (comma-separated). The same goes for monitors and scrapers (Prometheus, Uptime Kuma and so on) that reach core by a host name, such as a Docker service name other than `core`. An entry pasted as a URL (`https://name:8443/`) counts as its host name; one that is not a host name is ignored, with a warning in core's log. IP addresses and `localhost` keep working without changes.
- WebSocket connections (`/api/events`, terminals) without an `Origin` header are refused.
- The web app shows a dismissible warning when you open it over plain HTTP from another machine, since passwords and session cookies then travel unencrypted.

### Added

- Settings shows a short terms note per provider: a risk level (low, medium, high), what the vendor's terms say about running its CLI inside a platform like Emberline, the date it was checked and a link to the source. The README lists the same. Several accounts per provider stays a non-goal.

### Changed

- Gemini: a Google login found in the runner home no longer counts as a working sign-in on its own. Consumer Google logins stopped working in Gemini CLI on 2026-06-18, so the card shows a warning (only Code Assist Standard/Enterprise accounts still work), a saved API key takes priority, and Antigravity is no longer marked signed in because of Gemini login files.
- Claude's 5-hour, weekly and spend limits now come from what Claude Code itself reports to its status line during a run (Emberline sets the run's status line). The runner no longer reads the Claude login token to query Anthropic's usage endpoint. Settings shows when the limits were last reported.
- Antigravity's model quota percentages are gone: they came from Google's internal quota service, queried with your Antigravity login while posing as the Antigravity client. A limit still shows up when a run hits it.
- Enabling Antigravity (or signing in to it from Settings) first asks you to accept that Google does not support its consumer logins inside third-party tools and may suspend the account. Installs that already use it keep running. Antigravity steps in a fallback chain carry an "account risk" badge, and the multi-provider preset no longer picks Antigravity.

### Fixed

- Slow browsers and long-running runs can no longer grow Emberline's memory without limit. A terminal or live-update connection whose browser falls too far behind is closed and reconnects on its own (a terminal then shows a fresh screen). A terminal that is still attaching holds at most 1 MiB of output or typing before it reconnects. Each run keeps its newest 5000 events; older ones are pruned, except the few that Emberline reads later (such as the saved last screen), so for very long runs the tool-call count reflects only the retained events.
- Cleaning up finished runs no longer deletes work that was not merged. Garbage collection (manual, per project, and the automatic one) now keeps a worktree that has uncommitted changes or commits missing from the branch Emberline merges into (the one checked out in the project), and says how many it kept and why. If Emberline cannot tell, it keeps the worktree. Pruning one run's worktree from the dashboard asks first when it holds such work, with a "Prune anyway" button.
- Runs that start on their own (scheduled jobs and the factory's automatic ticket runs) no longer sit forever on a permission prompt. If one waits for 30 minutes with nobody answering, Emberline stops it as failed, frees its slot and sends a notification. Runs you started by hand are never stopped this way. Scheduled jobs can only use "Autonomous" or "Bypass permissions". **Upgrade note:** an older job saved with "Ask", "Accept edits" or "Plan only" is paused instead of run, and the jobs list says why; its permissions are never raised on their own. To run it again, pick "Autonomous" or "Bypass permissions" in its "Enable as…" menu. The jobs list now shows each job's permission mode. The factory's one-time "keep going" nudge is now remembered per run, so a restart no longer repeats it.
- A run that looks busy but has done nothing for 20 minutes (no agent activity and an unchanged terminal) no longer holds its slot forever. This also covers an agent that never gets past starting, for example after "Continue" was typed into a hung terminal. It is marked as waiting on you, which frees the slot and sends the "agent waiting" notification. If the agent was only slow, it goes back to working as soon as it does something. A scheduled or factory run that stalls is stopped 30 minutes later, like one stuck on a permission prompt.
- Build checks, guards and the merge now wait 20 seconds after an agent finishes its turn. If the agent picks up work again in that time, they wait for its next finish instead of checking half-done work. The ticket still moves to Review right away.
- A follow-up prompt sent while the agent is still starting is refused with a clear message instead of being lost. "Continue" and Emberline's own automatic prompts (factory nudges, fix requests from the build check and guards) are only typed when the agent is idle, never into the middle of a turn. Your own prompts while the agent works still go through.

## [0.2.0] - 2026-10-16

### Added

- A run whose turn died on a temporary provider error (503 / unavailable, overloaded, 5xx, network errors) is retried automatically after 1, 5 and 15 minutes, continuing the same session. It waits as "retrying n/3" without pausing other runs; sign-in, billing, quota and request errors are never retried, a stop cancels the pending retry, and after the third failure the run is left for you as before.
- Fallback chains: each persona has an ordered list of routes (provider, model, and sign-in, API key or — for Antigravity — AI credits). Settings → Multi-Agent & Model Matrix sets them and two policies: whether new runs wait for a provider's quota to reset or start on the next route, and whether a run that runs out of quota waits or hands off to the next route. A handoff continues in the same worktree and branch with a summary of the work so far; it shows as "handed off" with links between the runs, and a waiting run offers "Continue with…" (another route of its chain, its persona's chain or any enabled provider).
- Quota limits are tracked per provider, sign-in and model pool: one provider running out no longer pauses the others. Each exhausted lane has its own countdown and "Try now".
- Notifications name the lane that ran out ("Antigravity (all models) quota reached …") and say when it is back.
- A factory chain that pauses (ticket runs failing) sends a notification, under the "Agent waiting on you / factory paused" switch. The run timeline names the factory and gate notes ("factory paused", "held: secret found", …) instead of showing their internal names.
- Settings shows the Claude account's extra usage (it is set on claude.ai).
- Tickets can depend on other tickets. The product owner orders the tickets it creates (for example: icons and the Android shell in parallel, the APK build after both, QA last); without explicit order a default applies (architecture and database first, code and UI in parallel, QA last). Independent tickets of a project run at the same time, up to "Parallel tickets per project" (default 2). The board shows what a ticket waits for, and dependencies can be edited in the ticket drawer. A merge conflict between parallel tickets gets one automatic resolution attempt by the agent before it waits for you in Review.

### Fixed

- Claude Code runs could stop at the Claude in Chrome dialog ("Claude in Chrome extension detected — use my browser?"), shown when the signed-in account has the extension on another computer. Runs now start with `--no-chrome` and the dialog is pre-answered; an answer you already gave is kept.
- Antigravity's "Individual quota reached … Resets in 31h43m" (RESOURCE_EXHAUSTED / 429) failed the run instead of waiting for the reset; quota and rate-limit errors of every CLI (429, RESOURCE_EXHAUSTED, "quota exceeded") are now recognised, billing errors are not.
- Gemini CLI, Codex, Copilot and Aider runs resumed after a limit started over without context; they now get the task, the last message and the worktree state.
- Scheduled (cron) jobs were skipped while any provider was out of quota; they now start, and only a job whose own provider is out of quota waits queued for it.
- Claude Code's spend-limit messages ("You've hit your monthly spend limit") and the end of its own usage-limit wait are recognised as limits, so the run waits for the reset or hands off like any other limit.
- A running factory chain stopped when core restarted; it now continues after the restart without clicking Run pipeline.
- A failed ticket run stopped the factory chain; the other ready tickets now go on. When two ticket runs fail in a row, or a run fails before it gets to work, the chain pauses with a note on the run saying why.
- Runs already waiting for a quota reset stayed waiting after the in-flight policy was switched to "Hand off to the next route" or after a fallback route's lane reopened; they now hand off to the next open route (at most 3 handoffs per ticket attempt).
- Limit notifications and the quota panel could show the agent's earlier output instead of the limit; they now show only the limit sentence up to its reset time, without the CLI's raw error dump (for example "error: Individual quota reached. … Resets in 31h43m5s.").
- Settings and "Continue with…" offered "API key" routes when the key only came from core's environment; the server refuses those routes, so they are no longer offered and the sign-in route is suggested instead.
- "Hand off" on a run that is waiting for you ends its live session; it now asks for a second click first.
- The ticket drawer shows the whole handoff chain of a run (oldest first, with links) instead of only the run it continued.
- A ticket still waiting for its dependencies that was dropped on In progress moved there without a run; it now stays in Ready and opens its drawer with "Start anyway".
- A ticket a gate left in Review for you (secret guard, slop or critic check, failed build gate, failed merge) could be merged by a later dispatch; it now stays in Review.
- A ticket that finished while the factory chain was off (started on its own or by hand) did not start the tickets waiting for it; they now start.
- A deleted ticket's key was given to the next new ticket of the project, so its old runs showed under the new ticket; ticket keys are no longer reused.

### Upgrading

- Migration 0013 runs on start (a database backup is taken first).
- Persona settings become one-step chains. A persona whose provider had an API key saved keeps using that key (route "API key"); put a "Sign-in" route first if you want the subscription used first.
- "Auto-downgrade Claude" is gone: Fable and Opus personas no longer step down to Sonnet at 80 % Claude usage. If it was on, Sonnet becomes the persona's second route, which is only used when a policy is set to "Start on the next route" / "Hand off to the next route"; with the default policies the persona waits for Claude's reset instead.
- Antigravity runs no longer receive the Gemini API key; they use the Antigravity sign-in.
- Antigravity's "Use AI credits" is now set by Emberline for each run: off for "Sign-in" routes, on for "AI credits" routes. A value switched by hand in agy is overwritten by the next run; add an "AI credits" route to the chain instead.
- Both policies default to "wait": work whose provider is out of quota waits for that provider's reset while the other providers keep working.
- Migration 0014 adds ticket dependencies. Factory projects now run up to 2 tickets at once; set Parallel tickets per project to 1 for the previous one-at-a-time behaviour. Existing tickets have no dependencies.
- Moving a ticket to Done by hand only starts the tickets that were waiting for it (or continues a factory chain that is already running); other ready tickets are not started by it.
- A ticket waiting for a provider's quota holds one of its project's parallel ticket slots unless the persona has a fallback route and a policy is set to use it.
- Factory chains are remembered across restarts. 0.1.3 kept them in memory only, so the first 0.2.0 start resumes every project that has factory tickets waiting (a "[Factory]" ticket and a ticket that is ready to start), as long as Auto-Pickup Ready Queue is on.
- A ticket started by hand no longer starts the rest of the queue when it finishes; only the tickets that depend on it start.

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

[Unreleased]: https://github.com/biohazardious/emberline/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/biohazardious/emberline/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/biohazardious/emberline/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/biohazardious/emberline/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/biohazardious/emberline/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/biohazardious/emberline/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/biohazardious/emberline/releases/tag/v0.1.0

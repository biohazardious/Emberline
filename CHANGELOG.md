# Changelog

All notable changes to Emberline are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, any release may change behaviour or configuration; read the notes before upgrading.

## [Unreleased]

## [0.6.1] - 2026-10-23

A clean-up release: every known bug and piece of technical debt left after 0.6.0, from the Answer dialog to held tickets, restarts, previews, project delete and how repository addresses and credentials are shown.

### Fixed

- Saving `.emberline/worktree.yml` from Project settings while the runner was out of date said the runner was not reachable. It now says the runner is outdated and to update it (run `make up` again).
- **Stop** on a Docker preview whose containers could not be taken down said it was stopped and freed its port while they kept running. It now reports the error, shows the preview as failed with **Stop Preview** still on its Review page, and keeps its port reserved until a stop works. A clean-up that could not take a preview down marks it the same way; as the clean-up removes the run's worktree, the port is freed then, and the automatic Docker clean-up takes the containers left behind down within 30 minutes (or remove them on the Docker page). Deleting a project tries a Docker project that could not be taken down once more.
- Deleting a project with its files could remove the project folder, and the `.git` inside it, while a slow `worktree.yml` teardown was still running, so teardown commands that use git failed. The folder now goes once the teardown ended.
- Deleting a project took each run's Docker containers down twice, also beside a slow `worktree.yml` teardown still taking them down. It now does it once, which makes the delete faster.
- The README's from-source steps said `cd emberline`, which fails on case-sensitive file systems. They now say `cd Emberline`.
- With Claude's question picker open, the Inbox card said "Permission · Claude needs your permission". It now shows the run as a question with the picker's questions, as the Answer dialog does. A real permission prompt is still shown as a permission.
- An answer that could not be delivered after its files were stored (the agent started working meanwhile, its session ended, or a later file failed) left the stored files in the run's worktree. They are now removed again. A working agent, or a successor whose agent can't start (no API key, out of quota), is refused before anything is stored. An answer that already reached the agent keeps its files when a later step fails (for example starting the new run that takes it over), since the agent's prompt names them.
- Sending an answer with the same file again within the same second failed with "Couldn't store … in the run's worktree". Stored file names now carry the time to the millisecond.
- For Claude's picker with several questions, the Answer dialog offered the first question's options as chips, so a chip answered without saying which question it was for. Such a picker now offers no chips: type your answer.
- When a Claude session ended with its question picker still open, the Answer dialog still treated the picker as open, and an option chip restarted the session with a bare number as the prompt. The end of the session now closes the picker.
- A long agent message cut short for the Inbox, the Answer dialog's options or a suggestion could end in a broken character when the cut fell inside an emoji. Cuts now keep whole characters.
- An option chip in the Answer dialog replaced what you had typed; with Claude's question picker open, it sent the option alone and threw away your typed answer and attached files. With an answer typed or files attached, a chip now adds the option to your answer (a second chip swaps it, unless you edited the answer since), and Send sends all of it.
- The Answer dialog opened from a held run's block in the ticket drawer or the run dock closed by itself, with the files you had attached, when the run changed (for example when the hold ended) or when the run dock switched to its Terminal tab. It now stays open until you close it.
- Reopening the Answer dialog for a new question could briefly show the previous question's option chips, and a click on one picked that number in the new question. The dialog now loads each question fresh.
- Dropping a folder on the Answer dialog added it as an empty file, or failed at Send. It is now refused with "… is a folder. Add the files inside it instead."
- An option's explanation in the Answer dialog showed only as a hover tooltip, which touch screens never show. It now shows under the option.
- Screen readers now hear why **Suggest an answer** is off, and each problem with an attached file as it appears.
- A prompt to a Codex, Gemini or other one-shot agent that had just finished its turn could wait up to a minute or more while the background clean-up ran. It now checks only that agent's session and goes on at once.
- **Prune worktree** on a run whose agent had just exited could fail with "stop the active run before pruning its worktree", and **Clean Up Finished** or **Clean Worktrees** skipped a run that had just ended. They now notice the exit first.
- A run sharing its worktree with another run (after a handoff) could start a preview while that worktree was being torn down and removed. The preview is now refused until the removal is done.
- When core restarted while a finished ticket run waited for its checks and merge, the ticket stayed in Review without them unless the project's factory chain was on. After a restart, such a ticket now gets its checks and merge in every project, as it would have without the restart. A finished run without a ticket (for example one that wrote a tickets file) gets its cut-off checks too, so its tickets file is read.
- **Run pipeline** (and a running factory picking up its next ticket) could merge a ticket you had started yourself and left in Review, and move it to Done, when the factory was off as that ticket finished. Such a ticket now stays in Review for you.
- When an agent stopped again while the checks of its previous stop were still running (a slow build, the critic's review), its ticket could be merged with the newer work unchecked, even past a secret or a failed build found in it, merged twice, or asked to fix a ticket that was already Done. A run's checks now go one stop at a time: only the agent's latest turn is checked, merged once, and asked for fixes. Work the agent adds while the merge is being prepared waits for its next stop.
- A merge refused at the last moment (the agent had started working again, or a merge you started met open blocking review comments) had already committed the run's work on its branch as "factory run output", in the middle of the agent's turn or without a merge. A refused merge now leaves the run's branch, staged changes and files as they were.
- When an agent wrote both `.emberline/new-tickets.json` and `.emberline/tickets.json`, its stop imported only the first; the second waited for a next stop, which a finished run never has. Both are now imported at the same stop.
- After the agent fixed what the build checks or the critic asked for, its fix was merged without building or reviewing it again. The fix is now checked again; if it still fails, the ticket waits for you in Review, without a second automatic request, and each later stop of the agent is checked again too, so the ticket is merged only once its build and review pass. A critic's request for changes on a run that could no longer take a prompt was merged anyway; it now waits for you too.
- When core restarted right after a check asked the agent for a fix (the build checks, the worktree config checks, the secret or quality guard, the critic, or the reminder to call `ticket_complete`), the request could be lost: the ticket stayed in Review, nothing reached the agent, and nobody was told. After a restart, the request is now sent, in full, and one that cannot be delivered leaves the ticket for you.
- **Clean Up Finished**, **Clean Worktrees** and the automatic clean-up could archive a run's build outputs again and start its teardown while you were pruning that run's worktree, and could remove a run whose worktree (shared after a handoff) another run's prune was tearing down. They now leave such a run for the next clean-up, and **Clean Up Finished** and **Clean Worktrees** say so in their result.
- The **Default branch** field of a Git URL import had no effect: the clone always checked out the repository's default branch. The branch you type is now the one cloned, and finished runs are merged into it; a branch the repository doesn't have, or a tag, fails the import and says so. The field now starts empty, which keeps the repository's default branch.
- With **Keep main pushed** on, a push the runner could not run (it was restarting, or did not answer) waited without a word in Project settings → Repository, and when the runner was connected but did not answer, the push waited until the next merge. The Repository block now says "Waiting for the runner; main is pushed when it answers.", and a runner that did not answer is asked again after 30 seconds.
- A run's pull request (open, merged, closed, CI status) stopped refreshing when the forge account in Settings had lost its token, even with `EMBERLINE_FORGE_TOKEN` set for the same server. It now refreshes with the token that works, and sends no request with an empty one. When only such an account matches, the pull request form on the Review page now says "Add a forge account for this repository's server" too.
- A repository address in the `host:path` form with an `@` before any `/` (such as `server:app@v2`) was shown as `server@v2`, and two different addresses of this kind could count as the same repository. Now only the plain `user:password@host:path` form is shown without its password. Any other address of this kind that may hold a password (such as `server:app@v2` or `user:token@host/path`) is kept as it is, shown with `***` in its place, never taken for another repository, and still refused by **Connect**. A password containing `@` (`alice:p@ss@host:path`) was partly shown; it is now fully masked.
- **Connect** accepted an ssh URL whose user name holds an `@` followed by a password (`ssh://user@domain:password@host/…`) and stored it with the password. It is now refused like any other URL with a password.
- An origin set by hand as `user:token@host/path`, or as `user@domain:password@host:path` (or `…@host/path`), kept its token in git's errors and in a push's output, and the second one was shown in full in Project settings → Repository. Both are now masked there, and **Connect** refuses the second one too. An origin whose password holds an `@` (`user:p@ss@host:path`) now finds the forge account of `host`.
- An origin set by hand whose password starts with or holds a tab, a non-breaking or other space, or a typographic quote mark (`’`, `“`, `«`), or holds a `/`, showed part of the password in git's errors and in a push's output. In Project settings → Repository, such an address that is not a valid URL, an scp-style one whose password holds a `/` (`user:pa/ss@host/path`), and a URL whose password starts with digits and then `/`, `?` or `#` (`https://user:2024/rest@host/…`) were shown in full. The password is now masked in all of them, and **Connect** refuses such an address like any other with a password.
- The new-project wizard keeps its draft in the browser's session storage without the repository address's password, but kept part of one that held an `@`, `/` or `:`, all of one that started with digits and then `/`, `?` or `#`, all of an scp-style `user:password@host:path`, and a token in the address's query. No part of them is kept now.
- For an origin set by hand that may hold a password (shown with `***` in its place), **Connect** in Project settings → Repository was filled in with that masked address, which it then refused. The field is now left empty, and the note above it says to type the address again without the password. Two such origins that look the same once masked could also share one last read of origin; a read now counts only for the repository it was made for.
- **Push main to origin** and **Refresh** refused an origin that named the connected repository with its host in other letters (`GitHub.com` instead of `github.com`) as "not the repository connected for this project". Host names now compare without case.
- After **Mark done ✓** failed in the ticket drawer, moving the ticket to another column and back brought the old error and its **Merge anyway** or **Move to Done without merging** button back. The first move now clears them.
- **Start Auto-Interact** in the Live Browser said "Auto-Interact runs only in the shared browser, not in an agent's own browser" also when it did not start because the project's browser tab was not open or not shown. It now says why it did not start.
- When the page could not reload the settings right after **Use container preview** was saved, the box stayed and offered the save again, which then failed. The box now goes away as soon as the save works.
- Changing the admin password could, rarely, land you on the sign-in form although the change worked. The sign-in state is now checked again with the new key.
- On a first visit, the Inbox, Docker, Fleet and the dashboard briefly showed every project (or the first one) before narrowing to the active project. They now wait until the active project is known.
- When the server named the active project more than 5 seconds after a first visit began, the pages kept the first project for that visit. They now switch to it, start afresh for it and say so, unless you picked a project meanwhile. The Inbox, Docker, Fleet and the dashboard no longer start over while their own project is worked out again, and a page whose project was deleted waits for the next one instead of asking for the deleted one.
- **Prune worktree** on a run whose `worktree.yml` teardown took longer than the request looked as if nothing happened. It now says "Teardown is running; the worktree is removed when it ends." until the worktree is removed, and if the worktree cannot be removed when the teardown ends, it says so (the run's events too, and it keeps saying so when more happens on the run), so you can prune it again.

### Upgrade notes

- The compose file is unchanged. **The runner image changes** (its Chromium fallback also removes the PPA key it no longer uses). Updating with the published images (`docker compose pull && docker compose up -d`) replaces the runner container, which stops running agents, so update when they are idle. From source, `make upgrade-core` updates core alone and leaves agents running; the runner's change matters only when its image is built, so it can wait for your next `make up` (which restarts agents). The browser daemon 1.5.3 replaces 1.5.2 on first use.
- Nothing to migrate, and existing settings keep working.
- The first start after the update cannot tell whether checks that were running during the update (the build, the critic, the merge after an agent's last stop) finished. In a project whose factory chain is on, with **Auto-Sync Completed Worktrees into Main Host Workspace** or **Auto-Move Verified Factory Tickets to Done** on in Settings (a project's own **Auto-merge to main** setting counts for auto-sync), such a ticket waits in Review with "Checks cut off by an update" and shows in the Inbox: **Run the checks again** asks the agent to finish its turn again, which runs its checks and merge as usual, also if the project's chain has been turned off since. Letting running checks finish before you update avoids this.

## [0.6.0] - 2026-10-23

An Answer dialog for agents that wait on you: the agent's own question, its options as chips, a suggested answer on request, and file attachments.

### Added

- **Answer dialog.** **Answer** in the Inbox opens a dialog with the agent's own question (its last message, its blockers, the hold's reason, or the questions of Claude's picker), the options the agent offered as one-click chips, a large answer box, file attachments and Send. Drafts are kept per run in the browser. In the Inbox, the ticket drawer and the run dock, a recovery suggestion that comes with a prompt opens the dialog with that prompt filled in. A held run that can't take a prompt any more offers no **Answer**; its hold block says why and offers Copy.
- **Suggest an answer** in the dialog: Claude Code drafts a reply read-only in the run's worktree, only when you press it, with the model `EMBERLINE_SUGGEST_MODEL` (default `haiku`) and a 60 second limit. It says why when Claude Code is not signed in or the runner is not reachable.
- **Attachments** to an answer: up to 10 files, 10 MB each and 25 MB in all. They are stored under `.emberline/attachments/answers/` in the run's worktree, never merged into main, and the prompt lists their paths.
- With Claude's question picker open, typed text cancels the picker and arrives as the answer. For a picker with one single-choice question, a chip answers the picker directly; for several questions or several choices, a chip fills the answer box. A real permission prompt is answered in the terminal; the dialog says so and offers **Open terminal**.
- The Inbox shows the agent's own question (its last message, up to 2,000 characters) instead of "Claude is waiting for your input".
- One answer at a time per run: a second one gets "An answer is already being sent."

### Upgrade notes

- The compose file is unchanged. Only core (with the web app) has changes of its own, but updating with the published images (`docker compose pull && docker compose up -d`) also replaces the runner container, which stops running agents, so update when they are idle. From source, `make upgrade-core` updates core alone.
- Nothing to migrate, and existing settings keep working. The nginx limit of 45 MB from 0.5.0 already covers attachments.
- Pages for a waiting agent now quote the start of the agent's question (up to 300 characters) instead of "Claude is waiting for your input".
- **Suggest an answer** spends Claude usage (your subscription or key) only when you press it. `EMBERLINE_SUGGEST_MODEL` (default `haiku`) chooses the model; add it to the `core` service's `environment` to change it.

## [0.5.2] - 2026-10-23

A fix for held tickets whose merge failed for another reason than conflicts.

### Fixed

- A merge that failed for another reason than conflicts (for example a file in the main workspace that the runner cannot write) said "The branch merges cleanly into main now" and offered **Merge now**, which failed the same way. The held ticket now names git's reason and offers **Try the merge again**; when the reason is "Permission denied" it says to give the file back to the runner's user (uid 1000). The run's event list also shows why a merge failed.

### Upgrade notes

- The compose file is unchanged. Only core (with the web app) has changes of its own, but updating with the published images (`docker compose pull && docker compose up -d`) also replaces the runner container, which stops running agents, so update when they are idle. From source, `make upgrade-core` updates core alone.
- Nothing else to do: no migration, and existing settings keep working.

## [0.5.1] - 2026-10-22

Clean-up after 0.5.0: the items its reviews left open, two escape hatches for unusual setups, and formatting checks for contributors.

### Added

- `EMBERLINE_FORGET_SECRETS=1`: for a database restored without its secrets key. Core clears the stored secrets the current key cannot read instead of refusing to start, keeps a snapshot of the database first (`emberline.db.pre-forget-secrets-*.bak`) and logs which secrets it cleared, never their values. Enter them again, then remove the variable. A forge account whose token was cleared is not used until you enter the token again; Emberline says so instead of sending an empty token.
- `EMBERLINE_CONTAINER_NETWORKS`: comma-separated CIDR ranges (IPv4 and IPv6) that container trust accepts besides the private ranges, for Docker address pools such as 100.64/10 or public IPv6. An address must still be on one of core's own networks. Entries that are not CIDR ranges are logged at start and ignored.

### Fixed

- The first start creates `/data/secrets.key` on volumes without hard links, such as SMB/CIFS mounts.
- After a runner restart, forge-account git works again within seconds instead of being refused for up to a minute.
- The main container preview reads its status with one `docker compose ps` per poll, and compose output that is not JSON no longer takes a running preview down.
- Keep main pushed binds a queued push to the repository it was queued for: if the project's repository changed meanwhile, it does not push and says why.
- Saving `worktree.yml` while the runner is down says the runner is not reachable instead of "not on a branch".
- A prompt to a finished one-shot run starts it again even while Emberline is tidying up runs, instead of being refused.
- A run you stopped no longer shows "exited unexpectedly with exit code 0". After a failed merge, the ticket drawer keeps core's own message and offers **Merge anyway** or **Move to Done without merging**, as the board's dialog does, while the ticket is still in that column.
- Repository settings keep the owner you chose when you open Create again.
- A browser that blocks site storage gets its own sign-in notice, and signing out forgets the browser's key even when the request fails.
- Live Browser: refusals from another project's Auto-Interact are recognised reliably, and Start on an agent's own browser says that Auto-Interact runs only in the shared browser.
- The Container preview link from Preview & Build scrolls to the box and keeps it in view while the page above it loads.

### Changed

- The runner image checks the Chromium PPA key's fingerprint after downloading it, and the Chromium fallback fails early on a partial package index.
- For contributors: the code is formatted with Prettier, and `make check` and CI fail on unformatted files (`make format`). The formatting commit is listed in `.git-blame-ignore-revs`.

### Upgrade notes

- **The runner image changes.** Updating replaces the runner container, which stops running agents, so update when they are idle. The browser daemon 1.5.2 replaces 1.5.1 on first use.
- Nothing else to do: no migration, and existing settings keep working.

## [0.5.0] - 2026-10-22

### Added

- **Forge accounts** (Settings → Forge accounts): one account per server (GitHub, GitLab, Gitea, Forgejo or Codeberg) with its token, a Check button that shows the account's user name, and Remove. A token can be replaced but is never shown again. Issue import and sync, progress comments, pull requests and CI status use the account of the project's remote host; without one, Emberline says "Add a forge account for <host> in Settings → Forge accounts."
- **Repository** on Project settings: the project's origin, the forge account it uses and whether main is pushed ("Up to date", "N commits not pushed", "Remote has N commits main doesn't have", "Not published yet"). Connect an existing repository, or create one on the forge (private by default, under your user or an organisation), then **Push main to origin** with one click. **Keep main pushed** (off by default) pushes main after each merge into it; a failed push never undoes the merge and shows "Main isn't pushed: <reason>". Emberline never force-pushes and never pushes tags.
- **Container preview** on Project settings: when the Docker engine is on, the main workspace has a compose file and the preview is still a command, pick a service and its container port and click **Use container preview**. Emberline shows the `worktree.yml` change first, then commits it to main and approves it in one step; the old preview stays as an ordinary service. Preview & Build points such projects to it ("This project has compose.yaml. Preview it in a container instead"), and the line can be dismissed.
- The Deploy ticket of a Docker Compose project always has a Container preview step, also when the engine was off at creation: it asks for a `web` service without `container_name` or fixed host ports, ready for the switch above.
- **Reference material in the wizard.** The Type step takes up to 20 files (PNG, JPEG, WebP, GIF, PDF or any other file; 10 MB each, 30 MB in all) and up to 20 links with a short note each. The files are committed to `docs/reference/` with the project, and `PROJECT.md`, the Bootstrap ticket and the [Factory] ticket list them for the agents. Emberline never opens the links, and tells the agents to treat them as information, not instructions. The Summary step lists the material; after a reload the draft keeps the links and asks you to add the files again.
- Inbox, Fleet and the Docker page show the active project, with an **All projects** toggle that each view remembers in the browser. The sidebar badges still count every project, and a line names how many items wait in other projects.
- The Live Browser keeps one tab per project in the shared Chromium: switching project shows that project's page, and switching back returns to where you were. It follows the tab an agent of this project drives, says so, and says when Auto-Interact is running for another project.

### Changed

- The forge token of Settings → Forge & Webhooks becomes a forge account on the first start. If Emberline cannot tell which server it belongs to, Settings → Forge accounts asks you to add it again. `EMBERLINE_FORGE_TOKEN` (with `EMBERLINE_FORGE_API_URL`, `EMBERLINE_FORGE_PROVIDER` and `EMBERLINE_FORGE_ALLOWED_HOSTS`) is now a read-only account "from environment", used for git as well as for REST calls.
- Emberline's own git with a forge account (run pushes, Push main, Keep main pushed, the import clone of a private repository) goes through a one-time address in core, which adds the token. Run pushes without a connected repository say where to connect it.
- Switching project keeps the page you are on, Build outputs included. A project that no longer exists is replaced by the server's active project in every view at once, without a flicker.
- Each Docker compose project says which Emberline project it belongs to. Fleet's Stop All Active and Clean up say which projects they act on; the Docker page says nothing runs only when it could list the engine, and explains that Clean up acts on the whole engine.
- `make upgrade-core` creates the Docker engine when it has no container yet. An engine of your own (`EMBERLINE_DOCKER_HOST`) works with `EMBERLINE_DOCKER_ENGINE=0`, and any value of `EMBERLINE_DOCKER_ENGINE` other than 0 or 1 is reported at start.
- Held tickets: a person can start an explicit Autonomous run when a review send is refused for an agent without a terminal; recovery names the merges that moved main and the `worktree.yml` hold; Discard and Mark done use the suggestion's own wording, and merge errors from the ticket drawer show in the drawer.
- Saving `worktree.yml` explains a missing git repository or a failed commit, and Reload asks before it drops your edits.
- The runner image retries apt and the Chromium download, and falls back to a pinned, checksum-verified Chrome for Testing build when the Chromium PPA cannot be reached; the build log names the source.

### Fixed

- Held work is followed across handoffs, so a ticket's later runs are checked and merged like the first. A prompt sent while a session closes, or while the ticket changes, no longer gets lost, and the handoff context of a successor run is shortened to fit instead of failing.
- A run whose `worktree.yml` differs from main's only by line-ending conversion is no longer held as if it had changed the file.
- After a restart, Keep main pushed resumes a push it had not finished, once the runner is connected; a merge into another branch is reported as such.
- The Live Browser matches an agent's navigation to a bare host name, ignores changes of the page's `#` part, cleans up the tabs of deleted projects and keeps a chosen tab until this project's agent stops.
- The Docker page re-checks an engine that stopped or came back. Preview links follow `EMBERLINE_PREVIEW_HOST`. A removed run's abandoned preview, and a main preview whose containers vanished (an engine reset), are taken down and free their port.
- Reading a compose file for the container preview never fetches a remote `include`, and a file compose cannot read is named in the error.
- An import URL with a user name or token is stored without them, so the repository stays connected after a restart.
- A preview frame policy that would be too long for a reverse proxy's header buffer names the preview host on any port instead of each port.
- Container trust keeps working on a host where core cannot list its network interfaces.

### Security

- **Secrets are encrypted at rest.** Provider keys, forge tokens, the notification token, the demo signing secret and MCP server environment values are stored with AES-256-GCM under `EMBERLINE_SECRETS_KEY` or `/data/secrets.key`. Existing values are encrypted on the first start, and stored repository URLs lose their `user:token@`.
- **Each sign-in gets a key kept in the browser.** Changes and live connections (terminals, the event stream) need it, so a session cookie that leaks to a preview can read but not change anything. A new sign-in ends that browser's older session.
- **Forge tokens never leave core.** The runner and agents never receive them: REST calls go only to the account's own server, and git goes through a one-time address that core accepts only from the runner, for one repository and one operation, and for a push only the planned branch and commit. Remote URLs, errors and request logs never show a token or a one-time address.
- Container trust (refusing a session cookie that comes from Emberline's own containers) accepts only loopback or private addresses on core's own networks, so a machine on your network that happens to be called `runner` or `docker` is neither trusted nor refused.
- The web UI frames previews only on the preview port ranges of the preview host, not on every port.

### Upgrade notes

- **Sign in once on every device.** Sessions from before 0.5.0 are refused with "Signed out: Emberline now ties each sign-in to this browser. Sign in again.", and tabs left open ask to be reloaded. Each browser keeps its own key.
- **Back up `/data/secrets.key`** (or your `EMBERLINE_SECRETS_KEY`) apart from the database. The first start creates it and encrypts the stored secrets. `make backup` copies the database only, and a backup cannot be restored without that key. To keep the key out of the data volume, set `EMBERLINE_SECRETS_KEY` in `.env` to the contents of `/data/secrets.key` (with the published images, use the current `deploy/compose.yaml`, which passes it on); a different value stops core. Compose files from before 0.5.0 work without it.
- **Delete the old plaintext snapshots** once you no longer need to roll back. Core names them in a warning at the first start: `emberline.db.pre-migration-*.bak` and earlier `backups/emberline-*.db`.
- **Rolling back to 0.4.x means restoring the pre-migration `.bak`.** 0.4.x cannot read encrypted secrets or the new sessions.
- **If core keeps restarting with "Emberline can't read its stored secrets: the secrets key changed or is missing."**, put the original key file back or set the original variable. Nothing in the database was changed.
- **Repository URLs lose their credentials.** Stored repository URLs that held `user:token@` are cleaned in the database, but the workspace's `.git/config` origin still holds the token. To use Push main or Keep main pushed for such a project, add a forge account for its server and connect the clean URL in Project settings → Repository.
- **`EMBERLINE_FORGE_TOKEN` is now an environment forge account.** With `EMBERLINE_FORGE_API_URL`, `EMBERLINE_FORGE_PROVIDER` and `EMBERLINE_FORGE_ALLOWED_HOSTS` it defines read-only accounts (one per server host) that Emberline also uses for git on those servers, not only for REST calls. A forge account stored for the same host wins over it.
- **Both images change.** The runner image has the Chromium fallback and the apt retries. Updating with the published images (`docker compose pull && docker compose up -d`) replaces the runner container, which stops running agents, so update when they are idle; from source, `git pull && make up`. An old runner keeps working with the new core until it is replaced. The browser daemon 1.5.1 replaces 1.4.0 on first use, and Chromium keeps running.
- `make upgrade-core` now creates a missing Docker engine. `EMBERLINE_DOCKER_ENGINE` accepts only 0 or 1. An engine of your own (`EMBERLINE_DOCKER_HOST`) now works with `EMBERLINE_DOCKER_ENGINE=0`.
- **Preview frames are allowed only on the preview port ranges of the preview host** (on any of its ports when the list would make the header too long for a reverse proxy). An IPv6-literal preview host gets an `http:` frame source.
- **Container trust accepts only private addresses on core's own networks** (10/8, 172.16/12, 192.168/16, fc00::/7). With a Docker address pool outside those ranges (for example 100.64/10, or public IPv6), forge-account git through the gateway is refused, and setting `EMBERLINE_RUNNER_HOSTS` or `EMBERLINE_CONTAINER_HOSTS` does not help.
- **`/data` must support hard links** for the first start, when core creates the key file. Named volumes and ZFS datasets do; SMB/CIFS mounts do not. Setting `EMBERLINE_SECRETS_KEY` avoids the key file.
- Behind a reverse proxy, the wizard's reference files need a larger upload limit (nginx: `client_max_body_size 45m;`). Otherwise the wizard says the files are larger than the server accepts.
- Existing projects keep their command preview. Once the engine is on and the repository has a compose file, Project settings offers the switch.

## [0.4.0] - 2026-10-21

### Added

- `.emberline/worktree.yml` can be edited on Project settings (Edit, then "Save and approve"): the editor checks the file as you type, and saving commits it to main and approves it in one step. Runs use it from their next start. When the file in the repository can't be used, the Board banner has Edit too. The Code Explorer lists the file read-only and links to the editor.
- A container preview whose app does not allow being shown inside another page (`X-Frame-Options` or `Content-Security-Policy: frame-ancestors`) now says so, with the header, and offers "Open in new tab" instead of a blank frame. When Emberline can't tell, a line under the frame says to open it in a new tab if it stays blank.

### Fixed

- A new project's Bootstrap or Deploy ticket could write its own ticket plan while the [Factory] ticket planned the same work, so the board got two overlapping plans. The [Factory] ticket is now the only planner of a wizard project: a tickets file from Bootstrap or Deploy creates no tickets while it is open ("Ticket plan left to the [Factory] ticket"), and their instructions, the generated CLAUDE.md and the architect's prompt say so.
- A tickets file draft with the same title as an open ticket, or as an earlier draft in the same file, is skipped; drafts that depended on it depend on the existing ticket.
- An Auto Bootstrap (stack left to the agent) that finished without writing the commands into `.emberline/worktree.yml` was merged and the build gate silently fell back to detection. It is now held and asked once to add them.

### Upgrade notes

- The compose file is unchanged. Only core (with the web app) has changes of its own, but updating with the published images (`docker compose pull && docker compose up -d`) also replaces the runner container, which stops running agents, so update when they are idle. From source, `make upgrade-core` updates core alone.
- Projects created before 0.4.0 have no recorded wizard tickets: their tickets files are imported as before.

## [0.3.6] - 2026-10-21

### Fixed

- A ticket run that ended without changing anything and without saying what it did (for example an agent that was refused every command) used to count as "already merged" and moved its ticket to Done. It is now held in Review as "Finished without changes", with suggestions: do the ticket, mark it done anyway, or discard it. Runs that reported with the completion tool (Claude) why nothing was needed, runs whose tickets file created tickets, runs whose work was already merged, and the Factory planning ticket are not affected.
- Antigravity, Copilot and Gemini run without a terminal to answer in, so in Ask and Accept edits modes they silently refused every command. Starting one in those modes is now refused with a message (start it in Autonomous mode or pick another agent), and a run that switches to one of them later (a quota handoff or a fallback) fails with that message instead of finishing empty. Plan mode is unchanged.
- A run that adds an invalid `.emberline/worktree.yml` (for example an unknown `checks` key) is stopped before the merge and the agent is asked once to fix it; main no longer receives a file Emberline would ignore. A file the run inherited unchanged doesn't count. `worktree.yml` errors now list the allowed keys, for example `checks: Unrecognized key: "container" (allowed: build, lint, test)`.

### Upgrade notes

- The compose file is unchanged. Only core has changes of its own, but updating with the published images (`docker compose pull && docker compose up -d`) also replaces the runner container, which stops running agents, so update when they are idle. From source, `make upgrade-core` updates core alone.
- If the repository of an existing project already has an invalid `.emberline/worktree.yml` on main (Settings shows "worktree.yml in the repository can't be used"), fix the file in the repository. Runs keep using the approved version meanwhile.

## [0.3.5] - 2026-10-21

### Changed

- The isolated Docker engine for agents and compose previews is on by default: `make up` and `docker compose up -d` start it without any change to `.env`. `EMBERLINE_DOCKER_ENGINE=0` in `.env` turns it off; then no engine container is created, and Emberline treats the engine as off even when `EMBERLINE_DOCKER_HOST` is still set. Where Emberline used to say "enable the Docker engine (COMPOSE_PROFILES=docker)", it now says that the engine is turned off and how to turn it on again. When the engine does not answer, the Dashboard and the Docker page add that a host which cannot run it (privileged containers, overlay) can set `EMBERLINE_DOCKER_ENGINE=0`. When core has no engine address and nobody turned the engine off (it was started from a compose file older than 0.3.5), Emberline says that no Docker engine is configured and to use the current `deploy/compose.yaml`, instead of claiming that `EMBERLINE_DOCKER_ENGINE=0` is set; an engine that has not answered yet is no longer reported as turned off either.
- The upgrade box on the Settings page first downloads the `deploy/compose.yaml` of the release it offers (keeping a copy of yours as `compose.yaml.bak`), and no longer says that running agents keep working: the runner restarts when its image or settings change.
- `make up-docker` is removed: `make up` starts the engine.
- The runner no longer receives `EMBERLINE_DOCKER_HOST`; nothing in the runner read it. Agents still get `DOCKER_HOST` from core for each run.

### Upgrade notes

- **Installs that never turned the engine on get it with this upgrade:** a new container, `docker`, that runs privileged (a rootless Docker-in-Docker; see "Docker engine" in the README and SECURITY.md). If you do not want it, add `EMBERLINE_DOCKER_ENGINE=0` to `.env` before you upgrade.
- The first start pulls `docker:29.8.2-dind-rootless` (a few hundred MB) and creates two volumes: `docker-data` (the engine's images, containers and volumes) and `docker-certs` (its certificates).
- The engine publishes the compose preview ports 4325-4349 (`EMBERLINE_PREVIEW_PORTS_DOCKER`) on `EMBERLINE_BIND`; with `EMBERLINE_BIND=0.0.0.0` these 25 extra ports listen on your network. If another program on the host uses one of them, the engine's container cannot start: `make up` or `docker compose up -d` (or the stack in Portainer or TrueNAS) reports an error for the `docker` service, while core and the runner keep running and the Dashboard shows the engine as unreachable. Set `EMBERLINE_PREVIEW_PORTS_DOCKER` to a free range, or turn the engine off.
- On ZFS (TrueNAS, for example) the engine needs OpenZFS 2.2 or later. On older ZFS it keeps restarting and the Dashboard shows it as unreachable; turn it off there.
- Once the engine answers, agents get `DOCKER_HOST` and a compose project of their own, and the new-project wizard writes a compose preview (a `version: 2` `worktree.yml`) for the Docker Compose deploy target instead of a command preview.
- The cleanup sweeps run in the engine: every 30 minutes Emberline removes leftover `emberline-…` compose projects of runs that are gone, and once a day it deletes dangling images and build cache older than 72 hours. Compose projects with other names are never touched.
- To turn the engine off, add `EMBERLINE_DOCKER_ENGINE=0` to `.env` and run `make up` (with the published images, `docker compose up -d`). Remove the line and run it again to turn the engine back on.
- If you had turned the engine on before, the `COMPOSE_PROFILES=docker` and `EMBERLINE_DOCKER_HOST` lines in `.env` are not needed any more. They do no harm if they stay; you can delete them.
- Update the whole stack, not only core: from source `git pull && make up`; with the published images, also download the current `deploy/compose.yaml` (the old file keeps the engine behind its profile), then `docker compose pull && docker compose up -d`. An update that only pulls new images and keeps the old file (Portainer's "pull and redeploy", Dockhand, a TrueNAS image update) starts no engine; Emberline then says that no Docker engine is configured. `make upgrade-core` restarts only core, which would then look for an engine that was never started. The runner image has no changes of its own in this release, but compose recreates the runner because its settings changed (it no longer gets `EMBERLINE_DOCKER_HOST`), and that stops running agents, so upgrade when they are idle.

## [0.3.4] - 2026-10-21

### Fixed

- A ticket the factory held for you (for example "Merge failed") can be prompted and resumed again. Its run used to be stopped when the ticket was held, so a prompt, a Resume or an Inbox reply got "this run was stopped; start a new run". The run now only closes its session and continues where it left off when you send it something.
- One-shot agents such as antigravity now get the automatic conflict fix too. They had already exited when the merge ran, so their merge conflicts always went to a person.
- When main moves on after an agent resolved a merge conflict and the next merge conflicts again, the agent is asked to resolve it again instead of the ticket going straight to you: one attempt each time main has moved, at most 3 per run. A second conflict while main has not moved still goes to you.
- Resume on a held ticket tells the agent what is wrong. It used to send a bare "Continue where you left off.", so the agent repeated its work and the ticket was held again for the same reason. A ticket held because the agent is blocked and waits for your answer still gets the plain continue; answer it with its suggestion instead.

### Added

- Recovery suggestions for held tickets in the ticket drawer, the run dock and the Inbox: one line on why the ticket is held (for a failed merge, from a fresh comparison with main, naming the conflicting files) and up to three ways out, the best first. A suggested prompt opens prefilled and editable and goes to the agent with **Send** (in the Inbox it fills the reply box); the others are Discard (after a confirmation, moves the ticket to Done without merging), Merge now (merges the branch, then moves the ticket to Done like accepting it), Resolve by hand (the files and the git commands) and Open review. Discard and Merge now work in the ticket drawer; the dock and the Inbox show them as links to the ticket. When another finished ticket already added the same files, Discard comes first ("EL-10 already added these files").
- `GET /api/runs/:id/recovery` returns a held run's suggestions, and `POST /api/runs/:id/recover` sends a prompt to it, into its session or to a new run on the same branch, and says which.

### Changed

- The code audit's hold reads "Code audit asked for changes" (it was "Critic blocked").
- Resuming a gemini, codex, copilot or aider run, which starts a new conversation, now always gives the agent the handoff context (the ticket, the worktree's state and its last answer) before your text. It used to get it only with a bare Resume.

### Upgrade notes

- Tickets held before the upgrade had their runs stopped. They continue in a new run on the same worktree and branch, with the same agent and model, when you use one of their suggestions; the ticket follows that run, and when it finishes its work is checked and merged as usual. A run you stopped yourself stays stopped: its suggested prompts can only be copied, and the ticket can be discarded or started again.
- Only core changed: `make upgrade-core`, or with the published images `docker compose pull && docker compose up -d`. The runner does not need an update for this release.

## [0.3.3] - 2026-10-19

### Added

- A Docker page (sidebar **Docker**, shown while the Docker engine is on) lists Emberline's own compose projects in the engine, grouped as Agents, Previews, Build & Verify and Leftovers, with their containers, state and published ports (ports of the compose preview range are links). You can read a project's logs, stop or remove it after a confirmation (leftovers can only be removed) (for a running agent's project it warns that the agent may be using it, but does not block), see the engine's disk use and when the cleanup last ran, and start the cleanup now. Projects with other names are never listed or touched.
- Preview & Build says when and from which commit each target's static build was made ("Built 5m ago from 0123456"), shows "main changed since this build" (or "changed since this build" for a run) when the workspace moved on, and "Rebuilding…" while a build runs. Opening a stale target starts its build.
- Main's demo is rebuilt after every merge into main, by the factory or by you, in the background with the approved setup and checks (the same as **Run Build & Verify**). It never holds the ticket; quick merges run one build at a time with at most one more queued, and a failed rebuild shows on main's target.
- A container preview of main: when the approved `worktree.yml` previews a compose service and the Docker engine is on, main can run its own preview (compose project `emberline-main-<id>-preview`, on a port of `EMBERLINE_PREVIEW_PORTS_DOCKER` that no run preview takes). After a merge a running main preview is rebuilt with the new code. The Docker page lists it under Previews as "Preview of main", and deleting the project removes it.
- Container previews in Preview & Build: for a project with a compose preview service and the engine on, main and every run open on their container preview, with its state, **Start** / **Stop**, the end of the output when it fails, the page itself and **Open** for a new tab (from an HTTPS page, a plain-HTTP preview opens only in the new tab). The static build stays one click away under **Static build**, with its freshness line. Projects without a compose preview service, or with the engine off, show the static build as before.
- QA runs open their own work. Claude runs get a second `emberline` tool, `preview`: it starts the run's preview when it is not running (container or dev server, as `worktree.yml` says), waits until it answers and returns the address the agent's browser can open. It is pre-allowed only in the `auto` and `bypassPermissions` modes; in the other modes it asks first, like Bash, because a preview runs the worktree's own dev script or compose build. The QA and UI/UX personas use it, and fall back to `$EMBERLINE_DEMO_URL` without it.

### Changed

- `$EMBERLINE_DEMO_URL` now points at the run's own static build instead of main's.
- Live Browser's **Open Project Demo**, **Auto-Interact** and **Run QA Browser Check** start the target's container preview first when it has one, wait until it answers and open it in the shared browser; otherwise they open the static build. When there is nothing to open, Live Browser says so. The QA check's request no longer contains an address: the QA run opens its own preview with the `preview` tool.

### Fixed

- Live Browser's **Open Project Demo**, **Auto-Interact** and the QA check load the page again. They sent the shared browser to the demo address of the web UI, which needs a login; the runner's browser has none, so it got HTTP 401. It now gets an address that works without a login: the running container or dev-server preview, or the demo's capability URL.

### Security

- Logins are bound to the network address that signed in, and a session cookie that arrives from Emberline's own containers (the runner, the Docker engine) is refused with HTTP 403. Browsers send Emberline's cookie to previews on the same host name, where an agent's code could otherwise replay it. `EMBERLINE_SESSION_BIND_IP=false` turns the address binding off. For full isolation, set `EMBERLINE_PREVIEW_HOST` to a separate host name so previews never get the cookie (it is now passed through `compose.yaml`); see SECURITY.md.
- Reading a workspace's git HEAD (for the build freshness) and the files the build gate plans from (`package.json`, `platformio.ini`) no longer follows FIFOs or symbolic links and is size-capped, so a crafted workspace can no longer hang core or make it read files outside the workspace.
- The web UI may now frame pages from the host you opened it by on any port (or from `EMBERLINE_PREVIEW_HOST`), for the container preview in Preview & Build. The frame is sandboxed and, in Chromium-based browsers, loaded without Emberline's cookies.

### Upgrade notes

- Everyone is signed out once: logins from before the upgrade have no address recorded. From then on a login ends when your network address changes, for example a laptop moving to another network; the login screen then says "signed out: your network address changed". Set `EMBERLINE_SESSION_BIND_IP=false` in `.env` if that happens often. Behind a reverse proxy, set `EMBERLINE_TRUST_PROXY=true`, or every login is bound to the proxy's address.
- Update the runner too, not only core, so Claude runs get the `preview` tool: with the published images `docker compose pull && docker compose up -d`, from source `make up`. Restarting the runner stops running agents, so update it when they are idle. Until then agents fall back to `$EMBERLINE_DEMO_URL`, which now points at the run's own work.
- The rebuild after a merge runs main's approved setup and checks after every merge (an `npm ci`, for example), so busy projects spend more build time. It runs outside the merge lock: if the build rewrites tracked files, those changes land in the next merge's "snapshot workspace edits" commit, as after a manual **Run Build & Verify** on main. Keep build output in `.gitignore`.
- Demos built before the upgrade have no build record: Preview & Build shows "Build not recorded" with "may be out of date" until they are built again. Opening such a target in Preview & Build the first time builds it, which runs the project's approved setup and checks (for example an `npm ci`).
- A refresh of the main preview after a merge that fails takes the main preview down. Preview & Build shows the error with "the refresh after the last merge failed — Start to retry".

## [0.3.2] - 2026-10-18

### Added

- An optional Docker engine for agents and previews (compose profile `docker`: set `COMPOSE_PROFILES=docker` and `EMBERLINE_DOCKER_HOST=tcp://docker:2376` in `.env`, or run `make up-docker`). It is a rootless Docker-in-Docker container of its own; it runs privileged, never gets the host's Docker socket, and its API takes only the runner's client certificate. Agents get `DOCKER_HOST` and a compose project of their own, and the Dashboard shows whether the engine is on. See the README and SECURITY.md before you turn it on.
- Compose previews: a `version: 2` `.emberline/worktree.yml` can preview a service of the project's own compose file (`compose: { file, service, port }`). Preview builds and starts it in the engine on a free published port, ignores the file's fixed host ports, shows "starting" while it builds, and shows the end of the output when the build or the container fails.
- The wizard writes a compose preview for the Docker Compose deploy target while the engine is on, and keeps the dev command as a service without preview. With the engine off it writes the command preview as before, and the summary says to enable the Docker engine to preview the container.
- Pruning a worktree (per run, **Clean up worktrees**, automatic clean-up, project delete) also takes down its compose project and the preview projects of its runs, with their volumes and the images they built. Every 30 minutes Emberline removes leftover `emberline-…` compose projects of runs that are gone, and once a day it deletes dangling images and build cache older than 72 hours. Files that containers left in a worktree under another user no longer stop the worktree from being removed.

### Changed

- Previews now use published host ports: command previews 4300-4324 (published by the runner), compose previews 4325-4349 (published by the engine), both on `EMBERLINE_BIND` and set by `EMBERLINE_PREVIEW_PORTS_RUNNER` and `EMBERLINE_PREVIEW_PORTS_DOCKER`. They used to be 3100-3899 and were not published, so a stock install could not open them. The preview link now uses the host name you opened Emberline by (`EMBERLINE_PREVIEW_HOST` still overrides it). **Upgrade note:** the runner now publishes 4300-4324 on every install; if another program on the host uses those ports, the runner does not start until you set `EMBERLINE_PREVIEW_PORTS_RUNNER` to a free range. They are published on `EMBERLINE_BIND`: with `0.0.0.0`, anyone on your network can open a running preview without logging in (see SECURITY.md).

### Fixed

- Run Build & Verify (and the build gate) runs the project's approved `setup` commands from `.emberline/worktree.yml` before its `checks`, so a fresh main workspace no longer fails with errors like `astro: not found`.
- A merge conflict found after a run's session had gone idle no longer leaves the ticket held as "Merge failed": Emberline resumes the session to resolve it, and no longer closes an idle session while its checks and merge are still running.

## [0.3.1] - 2026-10-18

### Fixed

- A factory project could create the same tickets over and over when a tickets file an agent had staged ended up committed to main; Emberline now never commits its scratch files, ignores a tickets file a run inherited from main, removes ones already committed on the next merge, and never imports the same tickets file twice.
- Deleting a ticket whose run was held (for example "Merge failed") now takes that run out of the Inbox instead of leaving it there for up to a day.

## [0.3.0] - 2026-10-18

### Added

- Rebuilt project wizard: a dialog on desktop and a full-screen flow on phones. Pick a type (including static sites), then choose frontend, backend, database, auth and deploy independently, each with None, Let the agent decide or Other. The summary shows the exact `PROJECT.md`, `CLAUDE.md` and `.emberline/worktree.yml` that will be written. A Bootstrap ticket builds the skeleton, a Deploy ticket is added when you choose a target, and you finish with **Create and start** (the factory starts at once) or **Create project**.
- Wizard: an **Auto** preset, listed first and selected by default for every type, leaves the stack to the Bootstrap agent, which picks it from your vision (required, at least 20 characters), gives a one-line reason for each choice in `PROJECT.md` and writes the worktree commands for you to approve. Each preset says what it is best for and what it costs, and each Stack row says what the choice affects and what the selected option suits.
- Import a project from a Git URL or from a folder in the workspaces volume. Detection reads files only and runs nothing. Adopt writes only the files you tick, makes one local commit and pushes nothing. A URL import merges runs into the branch the clone checks out. The summary says when a `worktree.yml` is approved on import: its setup runs in every run worktree and an install may run the repository's own install scripts.
- `.emberline/worktree.yml`: copy or symlink files into each run worktree, `setup` and `teardown` commands, `services` for Preview and `checks` for the build gate. Runs always use the approved version. A changed or removed file (including an agent's edit merged from a run) shows "worktree.yml changed — review" on the Board and on Project settings until you approve it; a file that cannot be used (a symbolic link, over 64 KB, invalid) shows its errors and cannot be approved. When the diff is too long to show whole, Approve waits until you open **Show full file**. Caps: 10 min per setup command and 30 min for the whole setup; a `copy` entry over 200 MB or 5000 files and directories is skipped. A prune or clean-up waits up to 60 s for teardown commands, which then finish in the background.
- Per-project gate overrides on the new Project settings page (Inherit / On / Off).
- Inbox: all runs that need you across your projects, grouped by what they need (permission, question, held, failed and so on). Reply to a question right in the list and Dismiss a failure you have seen. Alt+N opens the oldest one. The Fleet Active view is now grouped into Needs you, Ready for review, Working and Recently finished.
- Claude runs now confirm that a ticket is finished. They get an `emberline` tool, `ticket_complete`, with a summary, an optional handoff note for dependent tickets and an optional list of blockers. In the factory, a Claude ticket advances to merge and Done only after that signal; other agents still finish by their exit code. If a Claude run ends its turn without the signal, the agent is asked once to confirm; if it still does not, the ticket stays in Review for you. A signal that lists blockers also holds the ticket. You get a page for a held ticket when notifications are on with **Agent waiting on you / factory paused** (Settings → Forge & Webhooks). The handoff note and any blockers go into the prompts of the tickets that depend on it, for every agent; a new run of the ticket clears its old completion. The ticket drawer shows the completion (summary, handoff, blockers, run and time), the run timeline shows each step, and a Fleet card shows a "blocked" badge when the agent raised blockers. **Settings → Auto-Pilot & Theme → Require agents to confirm completion** turns this off (on by default). A Claude run whose agent never got the tool (a runner that was not updated, or a session started before the upgrade) keeps the old behaviour and advances when its turn ends. **Upgrade note:** update the runner too, not only core: with the published images `docker compose pull && docker compose up -d`, from source `make up`. After `make upgrade-core` alone, new Claude runs have no `ticket_complete` tool and advance the old way until the runner is updated. Restarting the runner stops running agents, so update it when they are idle. Review tickets left over from runs before the upgrade had no tool either, so they finish the old way.
- Import GitHub, GitLab and Gitea issues from the Board (**Import issues**): one ticket per issue, with already-imported issues shown as linked. The persona and priority come from labels `persona:<id>`, `priority:high|critical|low` and `P0`-`P3`. Tickets show an `#123` chip that opens the issue, its labels, and a "closed" chip. The issue text is marked in the ticket as the author's request, not as instructions. The forge token needs issue read/write scope.
- Optional label sync for issues: every 10 minutes Emberline imports the most recently updated labelled issues, up to 200 (on Gitea: the 100 most recently created); use manual import for older ones. A **Sync now** button runs it at once. Only issues from trusted authors go straight to Ready; everything else lands in Backlog with a "needs triage" chip, and no automatic dispatch (Backlog auto-pickup, **Run pipeline**) starts it until you move or edit the ticket. Deleting an imported ticket keeps its issue from coming back.
- Progress comments on the issue when a pull request is opened or the work is merged locally (by the factory, or by you when you drag the ticket to Done), and an optional close of the issue when the ticket moves into Done. An issue that was already closed by then is left alone, also if someone reopens it later, and turning the option on does not close tickets that are already Done.
- Review comments are typed: each has an intent (Fix, Change, Question, Approve) and a priority (Blocking, Important, Suggestion), and the composer takes several lines (Ctrl/Cmd+Enter adds it). **Add file comment** comments on a whole file, including deleted and binary files. Comments follow their code when lines move, and show as outdated, with the old line's text, when it is gone. A file you marked viewed shows "changed" when its content changes, even with the same line counts.
- Review rounds: feedback that was not resolved comes back with the next request. When the agent finishes its turn a comment turns to addressed, and you choose Verify (resolved) or Not done (reopened). Request changes (n) lets you send to this run or to a new run from main; a new run does not contain the earlier attempt's worktree, and the comments are carried into its prompt. If a run can no longer take a prompt, the dialog offers "Start a new run instead".
- Open blocking comments keep the merge gate closed: the factory holds the ticket ("Blocking review comments"), and dragging a ticket to Done on the Board, or syncing a run to main, asks first. **Merge anyway** goes ahead and the override is recorded in the run's timeline. Blocking feedback sent to a new run from main keeps that run's gate closed until you check the new attempt and press **Verified** in its review. Comments on files that are no longer in the diff are listed apart, so you can still resolve them.

### Changed

- The Dashboard's separate new-project form is gone; the wizard replaces it. Starter tickets are replaced by the Bootstrap ticket for new projects (the Board's **Seed Starter Backlog** stays for existing ones). The build gate runs the approved `checks` when present, and Preview uses the approved `preview` service.
- Creating a new project through the API with three or more of frontend, backend, database, auth and deploy left to the agent (including the Blank and Polyglot presets) now needs a vision of at least 20 characters.
- Creating a project (the old API form) in a folder that exists and is not empty now answers 409 instead of writing into it.
- Removing a project asks inline instead of in a browser dialog: **Remove from Emberline** keeps the folder, **Remove and delete files** deletes it. A project imported from a folder keeps its files unless you choose the second; for it the confirm says that this deletes your repository folder. Live runs stop before the project's teardown commands run.
- Phone and webhook pages are sent once per thing that needs you: a permission prompt and Claude's later reminder about it are one page. They are never repeated after a restart, and are not sent while you have that run open in a visible tab. Every kind of hold (merge failed, build checks failed, guard blocks, no completion signal, blocked) now pages when **Agent waiting on you** is on. Waits from before the update do not page. Failure pages still follow **Run finished**.
- One count everywhere: the sidebar Inbox, the header and the Fleet badge show the same number of things that need you, across all projects. The Fleet badge used to show the number of active runs.
- The sidebar's "N need you" button is replaced by the Inbox entry, and **Enable desktop alerts** moved to the top of the Inbox page. The header's "need you" pill now opens the Inbox.
- A held or blocked ticket needs you only while it is in Review and only for its latest run: moving the ticket on, or starting it again, clears it from the Inbox. A hold of a run without a ticket shows for 24 hours.
- A hold that the agent was already asked to fix (build checks, the slop and secret guards, the critic, a merge conflict) neither shows in the Inbox nor pages while the agent works on it. If that request cannot be sent, the hold shows and pages once.
- Forge API calls now time out after 15 s. A redirect is followed only within the same server (a renamed repository, up to 3 hops). A redirect elsewhere fails with a message that names the new address: update the remote, or set the Forge API URL.

### Fixed

- A factory ticket that was held is now re-checked on the agent's next turn, even after the factory chain has stopped.
- Dragging a ticket to Done no longer moves it there when its merge into main failed. If the run's worktree is gone, the ticket moves when the run's work is already in main; otherwise the Board (and **Sync to Main** in the status panel) asks whether to move it to Done without merging.
- Security: text an agent wrote and that is typed into a session (review feedback, prompts) can no longer break out of the paste and send keystrokes.

### Security

- Copied `.env*` files that git does not ignore are flagged to the agent (do not commit them). Symlink mode lets a run modify the main workspace's file. Setup output is cleaned before it reaches the agent and is marked there as output of the project's setup command, to be treated as data. File names in detected commands are shell-quoted.

### Upgrade notes

- Existing projects have no `worktree.yml`: add one (example in the README), commit `.emberline/worktree.yml` to the main branch (the one checked out in the project), then approve it on Project settings.
- The runner protocol is now 3. An older runner keeps working: stopping a run during setup stops the run at once, but its setup command keeps running in the runner until it ends or times out (10 min). `make up` updates it, which restarts running agents.

## [0.2.2] - 2026-10-17

### Security

- Downloading a run's build output now reads the file that was checked, through one open file handle that never follows a symbolic link. Before, an agent could swap the file for a link between the check and the download and have core send any file it can read, such as its own database. A run worktree that was replaced by a link is neither listed nor served. **Upgrade note:** this includes a `.worktrees` folder (or a single worktree) that you replaced with a symbolic link yourself, for example to keep worktrees on another disk: its build outputs are no longer listed, downloaded or archived. Mount the other disk at that path instead of linking it.

### Added

- Build Outputs page under Code Explorer. Build outputs (APKs, installers, firmware) are archived per project each time a run finishes a turn or fails, and right before any worktree is pruned (manual cleanup, per-run prune, automatic cleanup), so a deliverable in a git-ignored `build/` folder survives its worktree. If that copy takes longer than 60 seconds, a per-run prune goes ahead without it; the manual and automatic cleanups instead keep the worktree (shown as "build outputs not archived in time") and archive it on their next pass. When copying fails (for example an unreadable file), the automatic cleanup keeps the worktree and retries for up to 24 hours, then prunes it as before. The archive sits in `.emberline-outputs` on the workspaces volume; deleting a project removes its archive, pinned outputs included. The page lists outputs with size, ticket and run, and lets you download, pin, delete, search and filter them, copy their path (on the host when `EMBERLINE_WORKSPACES_HOST_DIR` is set, otherwise the path inside the containers), and "Collect now" from runs that still have a worktree. Each project has a quota (default 5 GB, 0.5 to 1000 GB) in **Settings → Quota & Concurrency**; when it is exceeded the oldest unpinned outputs are removed first. An output removed this way, or deleted by you, is not copied back later unless it is rebuilt. A lower quota applies as soon as you save it. The same file is archived once, even when several runs share a workspace or every worktree checks out the same committed file. Outputs are not copied while another run is still building in the same worktree (that run archives them when it finishes), nor while the workspaces volume has less than 1 GB free. Problems (quota full, an output larger than the quota, low disk space, a failed copy) appear as notes in the run's timeline and never hold up a run or its pipeline. In Fleet, a finished run shows a compact "n outputs" badge that opens the page filtered to that run and its handoff chain; once its worktree is gone the badge counts the archived outputs. **Upgrade note:** outputs of worktrees that 0.2.1 already pruned are gone; use "Collect now" once per project to archive what the remaining worktrees hold. The archive uses disk space on the workspaces volume, up to the quota for each project.

### Fixed

- On phones, a Fleet card whose ticket title wraps no longer cuts off its reply box at the bottom.
- Downloading a run artifact, a run build output, a project file or a project export whose file name has characters outside Latin-1 (for example `çıktı.apk` or an emoji) failed with an error 500. The download now sends the name in an ASCII fallback plus its full UTF-8 form.

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

[Unreleased]: https://github.com/biohazardious/emberline/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/biohazardious/emberline/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/biohazardious/emberline/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/biohazardious/emberline/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/biohazardious/emberline/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/biohazardious/emberline/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/biohazardious/emberline/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/biohazardious/emberline/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/biohazardious/emberline/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/biohazardious/emberline/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/biohazardious/emberline/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/biohazardious/emberline/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/biohazardious/emberline/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/biohazardious/emberline/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/biohazardious/emberline/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/biohazardious/emberline/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/biohazardious/emberline/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/biohazardious/emberline/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/biohazardious/emberline/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/biohazardious/emberline/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/biohazardious/emberline/releases/tag/v0.1.0

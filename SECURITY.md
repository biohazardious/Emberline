# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Include the version or commit, your setup (bind address, reverse proxy) and the steps to reproduce.

You will get an answer within a week. Fixes land on `main` and in the next release; the advisory is published once a fix is available.

## Supported versions

Only the latest release and `main` receive security fixes.

## Security model

Emberline gives AI agents a shell, your git credentials and your provider logins. An Emberline login is roughly equivalent to SSH access to the runner container, so protect it accordingly.

### What Emberline protects

- **Who can log in.** A single admin account, hashed with argon2id. A fresh instance can only be claimed with the one-time setup token printed to the server log. Sessions are HTTP-only cookies (`Secure` and `__Host-` over HTTPS); mutating API calls need a CSRF header and a matching `Origin`; revoking sessions also closes their WebSockets.
- **Core from workspace code.** Core holds the database and the provider secrets and never executes anything in a workspace. Git, installs, builds, tests and agents all run in the separate runner container. Git commands disable repository hooks and command-running config.
- **Secrets from the browser.** Provider API keys, forge tokens and notification tokens are write-only in the UI and API: they are never sent back to the browser.
- **Forge tokens from other hosts.** Forge tokens are only sent to the configured forge's API host, never to a host taken from a repository's remote.
- **Default branches.** Emberline refuses to push to `main`, `master` or a project's default branch.

### What it does not protect

- **Agents from each other.** All agents and terminals in the runner run as the same user. Any agent can read every workspace and every provider login in the runner's home directory. Don't run agents on untrusted code next to projects you care about.
- **Secrets at rest.** Provider keys and tokens are stored in plaintext in the SQLite database in core's data volume, and in its backups. Anyone with access to that volume, to `./backups/` or to the Docker host can read them.
- **Traffic on the network.** Emberline does not terminate TLS. It listens on `127.0.0.1` by default. If you set `EMBERLINE_BIND=0.0.0.0` without a TLS reverse proxy or VPN, passwords and session cookies travel in plaintext on your network.
- **Attached hardware.** With `compose.usb.yaml` enabled, every agent can read and flash the attached serial device.
- **The host from the Docker engine.** The optional engine is a privileged container; see [The optional Docker engine](#the-optional-docker-engine).
- **What agents do with their access.** Agents can run arbitrary commands in the runner, reach the network and push branches with the credentials you gave them. Review their changes before merging.

### The optional Docker engine

With the compose profile `docker` on, Emberline runs a Docker engine of its own (the `docker` service) so agents can build and run containers and Preview can show a compose service. What that means for your host:

- **It is privileged.** Docker inside a container needs the `privileged` flag, rootless mode included. A privileged container can reach much more of the host's kernel than an ordinary one (devices, mounts, kernel settings), so a flaw in the engine or the kernel is a way out of it. Turn the engine on only if you accept that.
- **It is rootless.** The Docker daemon and every container it starts run as an unprivileged user (uid 1000 and its sub-uids), never as root on the host. A container's root is uid 1000 on the host; any other user in a container is a sub-uid from 100000 up.
- **It never gets the host's Docker socket.** Nothing in Emberline mounts `/var/run/docker.sock`. Agents cannot see, start or stop the host's own containers, and the engine has its own image store (the `docker-data` volume).
- **Its API needs a client certificate.** The engine listens on port 2376 of the compose network only (no published port) with mutual TLS. The entrypoint creates a CA and keeps it and the server key in the `docker-certs` volume, which no other container mounts. The client certificate goes to the `docker-client-certs` volume, mounted read-only into the runner only. Core never talks to the engine itself: it runs the Docker CLI in the runner, like every other command. A container inside the engine, or anything else on the compose network, gets no access without that certificate.
- **Agents share the engine.** Every agent can use the client certificate, so every agent can see and control every container, image and volume in the engine. Emberline gives each run its own compose project name and cleans up by those names, but a compose project is a naming convention, not a security boundary. The same rule as for the runner applies: don't run agents for projects you don't trust next to ones you do.
- **Published ports.** Compose previews are published on `EMBERLINE_BIND` from the `EMBERLINE_PREVIEW_PORTS_DOCKER` range (default 4325-4349, on `127.0.0.1`). Whatever a project serves there is reachable by anyone who can reach those ports.

### Recommended setup

- Keep the default `127.0.0.1` bind and reach Emberline through Tailscale, WireGuard or a TLS reverse proxy (set `EMBERLINE_TRUST_PROXY=true` behind a proxy).
- Use fine-grained forge tokens limited to the repositories Emberline works on.
- Treat the Docker host, the `data` volume and `./backups/` as sensitive.

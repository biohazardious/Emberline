# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Include the version or commit, your setup (bind address, reverse proxy) and the steps to reproduce.

You will get an answer within a week. Fixes land on `main` and in the next release; the advisory is published once a fix is available.

## Supported versions

Only the latest release and `main` receive security fixes.

## Security model

Emberline gives AI agents a shell, your git credentials and your provider logins. An Emberline login is roughly equivalent to SSH access to the runner container, so protect it accordingly.

### What Emberline protects

- **Who can log in.** A single admin account, hashed with argon2id. A fresh instance can only be claimed with the one-time setup token printed to the server log. Sessions are HTTP-only cookies (`Secure` and `__Host-` over HTTPS). Each sign-in also gets a per-login key that the browser keeps in local storage: changes (non-GET API calls) send it as the CSRF header with a matching `Origin`, and WebSockets send it as a subprotocol, so the cookie alone only allows reads. A new sign-in ends that browser's older session; revoking sessions also closes their WebSockets.
- **Core from workspace code.** Core holds the database and the provider secrets and never executes anything in a workspace. Git, installs, builds, tests and agents all run in the separate runner container. Git commands disable repository hooks and command-running config.
- **Secrets from the browser.** Provider API keys, forge tokens and notification tokens are write-only in the UI and API: they are never sent back to the browser.
- **Forge tokens stay in core.** Each forge account's token is sent only to that account's server, by REST calls and by core's git gateway. For Emberline's own git, the runner's git (no credentials) uses a one-time URL that core accepts only from the runner. It lives for a few minutes (up to 60 minutes for an import clone), for one repository and one service, and for a push only for the one planned branch and commit. Core adds the token and streams the data through without parsing git objects: of a push it reads only the command list, to check the branch and commit. The runner, ptyd and agents never receive the token: they run as the same user, so anything given to them would be readable by agents. An agent that catches a one-time URL while it lives can use it once, within those limits. Remotes without an account use the runner's own credentials, as before.
- **Default branches.** Emberline pushes a project's default branch only when a person clicks Push main, or after a merge when the project turns on Keep main pushed, and never with `--force`. Run pushes refuse `main`, `master` and the default branch. Enable branch protection on `main` at your forge: it is the control that also stops an agent that uses a one-time URL it caught, or the credentials you gave the runner.

### What it does not protect

- **Agents from each other.** All agents and terminals in the runner run as the same user. Any agent can read every workspace and every provider login in the runner's home directory. Don't run agents on untrusted code next to projects you care about.
- **Secrets at rest, from someone with the key.** Secrets in the database are encrypted with AES-256-GCM under `EMBERLINE_SECRETS_KEY` or `/data/secrets.key`, which sits in the same data volume unless you set the variable, so anyone with access to that volume or to the Docker host can still read them, and snapshots from before 0.5.0 hold them in plaintext.
- **Traffic on the network.** Emberline does not terminate TLS. It listens on `127.0.0.1` by default. If you set `EMBERLINE_BIND=0.0.0.0` without a TLS reverse proxy or VPN, passwords and session cookies travel in plaintext on your network.
- **Attached hardware.** With `compose.usb.yaml` enabled, every agent can read and flash the attached serial device.
- **The host from the Docker engine.** The engine is on by default and is a privileged container; see [The Docker engine](#the-docker-engine). `EMBERLINE_DOCKER_ENGINE=0` turns it off.
- **What agents do with their access.** Agents can run arbitrary commands in the runner, reach the network and push branches with the credentials you gave them. Review their changes before merging.

### The Docker engine

By default Emberline runs a Docker engine of its own (the `docker` service; `EMBERLINE_DOCKER_ENGINE=0` in `.env` turns it off and no container is created) so agents can build and run containers and Preview can show a compose service. What that means for your host:

- **It is privileged.** Docker inside a container needs the `privileged` flag, rootless mode included. A privileged container can reach much more of the host's kernel than an ordinary one (devices, mounts, kernel settings), so a flaw in the engine or the kernel is a way out of it. The engine is on by default; turn it off if you do not accept that.
- **It is rootless.** The Docker daemon and every container it starts run as an unprivileged user (uid 1000 and its sub-uids), never as root on the host. A container's root is uid 1000 on the host; any other user in a container is a sub-uid from 100000 up.
- **It never gets the host's Docker socket.** Nothing in Emberline mounts `/var/run/docker.sock`. Agents cannot see, start or stop the host's own containers, and the engine has its own image store (the `docker-data` volume).
- **Its API needs a client certificate.** The engine listens on port 2376 of the compose network only (no published port) with mutual TLS. The entrypoint creates a CA and keeps it and the server key in the `docker-certs` volume, which no other container mounts. The client certificate goes to the `docker-client-certs` volume, mounted read-only into the runner only. Core never talks to the engine itself: it runs the Docker CLI in the runner, like every other command. Something on the compose network that cannot start containers in the engine gets no access without that certificate. But anything that can start containers in the engine can take it: a container may bind-mount the engine's own `/certs`. We checked this: `docker run --rm -v /certs/client:/c busybox ls /c` lists `ca.pem`, `cert.pem` and `key.pem`; `-v /certs:/c` also shows the CA's private key (`/c/ca/key.pem`, readable as the container's root); and a `docker:29.8.2-cli` container given `/certs/client` controls the engine over TCP. So every agent, and every container an agent or a project starts in the engine, can control the whole engine.
- **Agents share the engine.** Every agent can use the client certificate, so every agent can see and control every container, image and volume in the engine. Emberline gives each run its own compose project name and cleans up by those names, but a compose project is a naming convention, not a security boundary. The same rule as for the runner applies: don't run agents for projects you don't trust next to ones you do.
- **Published ports.** Compose previews are published on `EMBERLINE_BIND` from the `EMBERLINE_PREVIEW_PORTS_DOCKER` range (default 4325-4349, on `127.0.0.1`). Whatever a project serves there is reachable by anyone who can reach those ports.

### Preview ports on every install

By default 4300-4349 are published on `EMBERLINE_BIND`. The runner publishes the command-preview range `EMBERLINE_PREVIEW_PORTS_RUNNER` (default 4300-4324) on every install, and the Docker engine publishes the compose-preview range `EMBERLINE_PREVIEW_PORTS_DOCKER` (default 4325-4349) unless `EMBERLINE_DOCKER_ENGINE=0` turns it off. With the default `127.0.0.1` only the Docker host reaches them. With `EMBERLINE_BIND=0.0.0.0`, every dev server or compose service a preview starts is reachable from your network without logging in to Emberline, so use a private interface, a firewall or a VPN, and don't preview anything you would not show to the network.

### Preview ports and the session cookie

Browsers scope cookies by host name, not by port. On a plain-HTTP install, your browser therefore sends Emberline's session cookie (`emberline_session`) to every preview on the same host name, for example `http://127.0.0.1:4325/` next to `http://127.0.0.1:7420/`. A preview runs code an agent wrote, so it can read the cookie and try to use it against Emberline. Over HTTPS the cookie is `Secure` and is never sent to a plain-HTTP preview.

Since 0.3.3 Emberline does two things against a replayed cookie:

- **A session is bound to the address that signed in.** A request with the cookie from any other client address gets HTTP 401 ("signed out: your network address changed"). Behind a reverse proxy with `EMBERLINE_TRUST_PROXY=true`, the forwarded address counts. `EMBERLINE_SESSION_BIND_IP=false` turns this off.
- **Cookies from Emberline's own containers are refused.** A request with a session cookie that comes from the `runner` or the `docker` container gets HTTP 403 (`session_from_container`), whatever proxy header it sends. Agents' own credentials (hook tokens, the demo capability URLs) are not affected.

**What remains.** When the browser runs on the Docker host itself and Emberline is bound to `0.0.0.0`, the browser and a container that connects to the host's published port can arrive from the same address (Docker's port forwarding). A replay is then not told apart from you.

**Full isolation (opt-in).** Set `EMBERLINE_PREVIEW_HOST` (in `.env`) to a host name other than the one you open Emberline by. For example, open Emberline as `http://emberline.lan:7420` and set `EMBERLINE_PREVIEW_HOST=http://previews.lan`, with both names pointing at the same machine. Previews then live on another host name and never receive Emberline's cookie.

Previews may be framed only from the configured preview ports on the preview host; when Emberline is opened on an IPv6 address, the policy allows any http(s) origin (the preview iframe stays sandboxed).

### Recommended setup

- Keep the default `127.0.0.1` bind and reach Emberline through Tailscale, WireGuard or a TLS reverse proxy (set `EMBERLINE_TRUST_PROXY=true` behind a proxy).
- Use fine-grained forge tokens limited to the repositories Emberline works on.
- Treat the Docker host, the `data` volume and `./backups/` as sensitive, and keep a copy of `/data/secrets.key` (or `EMBERLINE_SECRETS_KEY`) apart from the backups: a backup cannot be restored without it.

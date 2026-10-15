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
- **What agents do with their access.** Agents can run arbitrary commands in the runner, reach the network and push branches with the credentials you gave them. Review their changes before merging.

### Recommended setup

- Keep the default `127.0.0.1` bind and reach Emberline through Tailscale, WireGuard or a TLS reverse proxy (set `EMBERLINE_TRUST_PROXY=true` behind a proxy).
- Use fine-grained forge tokens limited to the repositories Emberline works on.
- Treat the Docker host, the `data` volume and `./backups/` as sensitive.

# Contributing to Emberline

Thanks for your interest. Bug reports, fixes and focused features are welcome. For anything large (a new provider, a new page, a schema change), please open an issue first so we can agree on the approach before you write the code.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Everything runs in Docker. You need Docker with Compose v2, `make` and `git`; do not install Node or pnpm on the host. The source is bind-mounted into a `dev` image and `node_modules` lives in Docker volumes.

```bash
make dev                 # ptyd + core + web dev servers -> http://localhost:5173
make shell               # shell inside the toolbox
make check               # lint + typecheck + test + build: run before every pull request
make e2e                 # isolated core + runner stack and an end-to-end smoke test
make lock                # after editing any package.json
make db-generate         # after editing apps/core/src/db/schema.ts
```

To run a single test file:

```bash
docker compose -f compose.dev.yaml run --rm tools npx vitest run apps/core/src/tickets.test.ts
```

Docker creates empty, root-owned `node_modules/` mount points in the repository. They are ignored by git and harmless. Your editor has no host `node_modules`; attach it to the dev container if you need IntelliSense.

## How the code is organized

See the layout in the [README](README.md#architecture) and the reasoning in [docs/DESIGN.md](docs/DESIGN.md). A few rules hold everywhere:

- **Core runs nothing in a workspace.** Anything that executes in a project (git, installs, builds, tests, agents) goes through `ptyd` in the runner, via `apps/core/src/command-exec.ts` or `apps/core/src/git-exec.ts`. Never spawn a workspace process from core.
- **Every wire contract is a zod schema** in `packages/protocol`. Change the schema first, then core and web.
- **Secrets are write-only.** API responses expose `…Configured` booleans, never the secret itself.
- **Database changes are migrations.** Edit `apps/core/src/db/schema.ts`, then `make db-generate`, and commit the generated migration.
- **Everything is in English**: code, comments, UI text and docs.

## Pull requests

- Keep each pull request to one change. Refactors go separately from features.
- Add or update tests for what you change. Bug fixes should come with a test that fails without the fix.
- `make check` must pass. Run `make e2e` too when you touch runs, the runner, `ptyd` or the Dockerfile.
- Format only the files you touched (`npx prettier --write <files>` inside `make shell`), not whole directories.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope, for example `fix(scheduler): keep the quota timer across restarts`. The body explains why.
- Keep new dependencies to a minimum, prefer releases that have been out for at least two weeks, and commit the updated `pnpm-lock.yaml` (`make lock`).

## License of contributions

Emberline is licensed under AGPL-3.0-or-later, with `packages/protocol` and `packages/adapter-sdk` under Apache-2.0. By submitting a contribution, you agree that it is licensed under the license of the files and packages it changes.

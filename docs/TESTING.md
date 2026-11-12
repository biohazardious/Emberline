# Testing

Emberline is verified by Vitest unit and integration tests in every package, plus one end-to-end smoke test.

## Running

| Command                                         | Scope                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                     | Every `{apps,packages}/*/src/**/*.test.ts` (about 2 minutes)                                                                                  |
| `pnpm vitest run apps/core/src/tickets.test.ts` | One file                                                                                                                                      |
| `pnpm vitest run -t "scheduler"`                | Tests whose name matches                                                                                                                      |
| `pnpm lint && pnpm typecheck && pnpm build`     | The rest of the build gate (`.emberline/worktree.yml`)                                                                                        |
| `pnpm format:check`                             | Prettier                                                                                                                                      |
| `make check`                                    | All of the above in the dev toolbox container                                                                                                 |
| `make e2e`                                      | `e2e/smoke.mjs`, the isolation suite `e2e/isolation.sh`, then the Playwright suite `e2e/ui/run.mjs`, on an isolated core + runner + ops stack |

Tests are hermetic: `apps/core/src/test-setup.ts` strips host Docker, run and provider variables, so results
are the same in an Emberline runner and in CI. Some tests are skipped when a host capability (such as a Docker
engine) is absent; they run in the `make ci` stage.

## Where each core workflow is covered

| Workflow (PROJECT.md §3.3)               | Tests                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Board: tickets, columns, dependencies    | `apps/core/src/tickets.test.ts`, `ticket-dependencies.test.ts`, `ticket-bulk-route.test.ts`                |
| Runs and run events                      | `apps/core/src/runs.test.ts`, `apps/core/src/transcript-usage.test.ts`                                     |
| Scheduling and usage-limit resume        | `apps/core/src/scheduler.test.ts`, `packages/adapter-claude/src`                                           |
| Review: diffs, comments, rounds, gate    | `apps/core/src/review*.test.ts`, `worktree-merge.test.ts`, `post-merge.test.ts`                            |
| Factory (planning, tickets file ingest)  | `apps/core/src/factory.test.ts`, `tickets-file-ingest.test.ts`                                             |
| Worktree config and gates                | `apps/core/src/worktree-config.test.ts`, `project-gates*.test.ts`                                          |
| Compose and container previews           | `apps/core/src/compose-preview.test.ts`, `container-preview.test.ts`, `agent-preview.test.ts`              |
| Authentication and route coverage        | `apps/core/src/auth-coverage.test.ts`, `session-binding.test.ts`                                           |
| Wire contracts                           | `packages/protocol/src` (`ptyd.test.ts`, `hooks.test.ts` for the frame and hook schemas)                   |
| Package layering, manifests, hygiene     | `apps/core/src/workspace-layers.test.ts`, `workspace-manifests.test.ts` (PROJECT.md AC-1.3–1.5, 1.9, 1.11) |
| M3 board workflow acceptance (AC-3.x)    | `apps/core/src/m3-workflows.test.ts` (PROJECT.md AC-3.1–3.6)                                               |
| Layer lint probes, manifests, env, skips | `apps/core/src/m1-layers.test.ts`, `m1-guards.test.ts` (AC-1.3, 1.4, 1.5, 1.9, 1.11)                       |
| PTY host and framing                     | `apps/ptyd/src/{server,session,framing,drop}.test.ts`                                                      |
| Hooks and MCP server                     | `packages/hook/src/mcp-server.test.ts`                                                                     |
| Web UI domain logic                      | `apps/web/src/*.test.ts` (board filter, selection, attention, error boundaries, answer dialog)             |
| Whole stack                              | `e2e/smoke.mjs`                                                                                            |
| Runner, ops and ptyd isolation           | `e2e/isolation.sh`, `e2e/isolation/run.mjs` (below)                                                        |

## Isolation suite (SECURITY.md, "The shared runner")

`make e2e` runs `e2e/isolation.sh` after the smoke test on the same stack. `e2e/isolation/run.mjs` opens
agent terminals through core's API (the runner's ptyd starts them as node, as it starts every agent) while
another terminal is open and an import clone is held in `ops`, and runs `e2e/isolation/agent-facts.sh`
there. `e2e/isolation.sh` then replays the signed-in cookie from the other containers, scans the volumes as
root and checks the mounts. Every check reports, so one run lists every broken guarantee. Reverting the
0.7.0 terminal-inheritance fix (`patches/node-pty@1.1.0.patch`) fails SR-05 and SR-06.

| Test  | SECURITY.md claim                                                                                          | Where              |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| SR-01 | Agents run as `node` with node's groups (`dialout`), never in `emberline-core`, and cannot join it         | agent terminal     |
| SR-02 | ptyd runs as `ptyd` with setuid, setgid, setpcap, kill and chown only; sessions get no capabilities        | agent terminal     |
| SR-03 | An agent cannot connect to ptyd's socket, so cannot list, watch, type into or stop sessions through it     | agent terminal     |
| SR-04 | An agent cannot stop ptyd or read its environment                                                          | agent terminal     |
| SR-05 | A session starts with only its own terminal: no other session's pty master (0.7.0 fix)                     | agent terminal     |
| SR-06 | A command core runs in the runner holds no session's terminal (0.7.0 fix)                                  | build gate command |
| SR-07 | The `ops-socket` volume is not in the runner                                                               | agent terminal     |
| SR-08 | Agents see no process, command line or environment of core or ops (core's secrets, one-time git addresses) | agent terminal     |
| SR-09 | No private SSH key is readable where an agent can look; ptyd's logs are closed to it                       | agent terminal     |
| SR-10 | Agents cannot replace the browser daemon's script or Playwright hook, or stop it; it has no capabilities   | agent terminal     |
| SR-11 | The runner makes its service directories afresh over 0.6.x volumes and follows no planted link             | agent terminal     |
| SR-12 | A session cookie from the runner is refused (`403 session_from_container`)                                 | agent terminal     |
| SR-13 | The git gateway refuses the runner                                                                         | agent terminal     |
| SR-14 | A session cookie from `ops` is refused                                                                     | `ops`              |
| SR-15 | A session cookie from a container named `docker` is refused                                                | probe as `docker`  |
| SR-16 | Control: from another address the cookie is signed out (401), so SR-12/14/15 refuse by name                | fake forge         |
| SR-17 | The git gateway accepts `ops`                                                                              | `ops`              |
| SR-18 | The git gateway refuses any other container                                                                | fake forge         |
| SR-19 | No private SSH key in any volume the runner or ops mounts (read as root)                                   | host               |
| SR-20 | Only core and ops mount `ops-socket`; ops mounts none of the runner's home, AI tools, logs or ptyd socket  | host               |

## Adding tests

Bug fixes come with a test that fails without the fix. No `.skip`, `xit` or `test.todo`; assert real behavior.

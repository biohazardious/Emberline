# Testing

Emberline is verified by Vitest unit and integration tests in every package, plus one end-to-end smoke test.

## Running

| Command                                         | Scope                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm test`                                     | Every `{apps,packages}/*/src/**/*.test.ts` (about 2 minutes)                                          |
| `pnpm vitest run apps/core/src/tickets.test.ts` | One file                                                                                              |
| `pnpm vitest run -t "scheduler"`                | Tests whose name matches                                                                              |
| `pnpm lint && pnpm typecheck && pnpm build`     | The rest of the build gate (`.emberline/worktree.yml`)                                                |
| `pnpm format:check`                             | Prettier                                                                                              |
| `make check`                                    | All of the above in the dev toolbox container                                                         |
| `make e2e`                                      | `e2e/smoke.mjs`, then the Playwright suite `e2e/ui/run.mjs`, on an isolated core + runner + ops stack |

Tests are hermetic: `apps/core/src/test-setup.ts` strips host Docker, run and provider variables, so results
are the same in an Emberline runner and in CI. Some tests are skipped when a host capability (such as a Docker
engine) is absent; they run in the `make ci` stage.

## Where each core workflow is covered

| Workflow (PROJECT.md §3.3)              | Tests                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Board: tickets, columns, dependencies   | `apps/core/src/tickets.test.ts`, `ticket-dependencies.test.ts`, `ticket-bulk-route.test.ts`                |
| Runs and run events                     | `apps/core/src/runs.test.ts`, `apps/core/src/transcript-usage.test.ts`                                     |
| Scheduling and usage-limit resume       | `apps/core/src/scheduler.test.ts`, `packages/adapter-claude/src`                                           |
| Review: diffs, comments, rounds, gate   | `apps/core/src/review*.test.ts`, `worktree-merge.test.ts`, `post-merge.test.ts`                            |
| Factory (planning, tickets file ingest) | `apps/core/src/factory.test.ts`, `tickets-file-ingest.test.ts`                                             |
| Worktree config and gates               | `apps/core/src/worktree-config.test.ts`, `project-gates*.test.ts`                                          |
| Compose and container previews          | `apps/core/src/compose-preview.test.ts`, `container-preview.test.ts`, `agent-preview.test.ts`              |
| Authentication and route coverage       | `apps/core/src/auth-coverage.test.ts`, `session-binding.test.ts`                                           |
| Wire contracts                          | `packages/protocol/src`                                                                                    |
| Package layering, manifests, hygiene    | `apps/core/src/workspace-layers.test.ts`, `workspace-manifests.test.ts` (PROJECT.md AC-1.3–1.5, 1.9, 1.11) |
| PTY host and framing                    | `apps/ptyd/src/{server,session,framing,drop}.test.ts`                                                      |
| Hooks and MCP server                    | `packages/hook/src/mcp-server.test.ts`                                                                     |
| Web UI domain logic                     | `apps/web/src/*.test.ts` (board filter, selection, attention, error boundaries, answer dialog)             |
| Whole stack                             | `e2e/smoke.mjs`                                                                                            |

## Adding tests

Bug fixes come with a test that fails without the fix. No `.skip`, `xit` or `test.todo`; assert real behavior.

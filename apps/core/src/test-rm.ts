import { rmSync } from 'node:fs';

/**
 * Removes a temp directory for a test. A process that is still exiting may add a file while the
 * tree is removed (ENOTEMPTY), so it retries. Kept apart from test-utils.ts so the small tests that
 * only need this do not load the whole app.
 */
export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

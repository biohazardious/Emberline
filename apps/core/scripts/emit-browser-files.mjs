// Writes the browser daemon's script and the agents' Playwright hook to dist/browser/, from the
// built module, for the runner image (Dockerfile: /opt/emberline/browser, root's, 0644).
import { mkdir, writeFile } from 'node:fs/promises';

const { BROWSER_DAEMON_SCRIPT, PLAYWRIGHT_HOOK_SCRIPT } =
  await import('../dist/factory/browser-daemon-script.js');
const out = new URL('../dist/browser/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('browser-daemon.mjs', out), BROWSER_DAEMON_SCRIPT, { mode: 0o644 });
await writeFile(new URL('playwright-hook.cjs', out), PLAYWRIGHT_HOOK_SCRIPT, { mode: 0o644 });

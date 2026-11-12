#!/usr/bin/env node
/**
 * One request to core from wherever this runs (an agent terminal in the runner, the ops container, a
 * container on the e2e network), compared with what core must answer there. Used by run.mjs and
 * e2e/isolation.sh. Dependency-free, so it also runs piped into `node -` in the ops container.
 *
 *   node probe.mjs <base> cookie  "<status> <error>"   GET /api/projects with $E2E_COOKIE
 *   node probe.mjs <base> gateway "<status>"           GET a git gateway address that never existed
 *
 * Core resolves its containers' names once a minute, so a mismatch is retried for up to
 * E2E_PROBE_WAIT_MS (default 0). Prints `E2E:probe=<answer>`; exits 1 when it never matched.
 */
const [base, kind, expected] = process.argv.slice(-3);
const waitMs = Number(process.env.E2E_PROBE_WAIT_MS ?? 0);

async function answer() {
  if (kind === 'cookie') {
    const res = await fetch(`${base}/api/projects`, { headers: { cookie: process.env.E2E_COOKIE ?? '' } });
    const body = await res.json().catch(() => ({}));
    return `${res.status} ${body.error ?? '-'}`;
  }
  if (kind === 'gateway') {
    const capability = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const res = await fetch(`${base}/api/internal/git/${capability}/info/refs?service=git-upload-pack`);
    await res.arrayBuffer();
    return String(res.status);
  }
  throw new Error(`unknown probe ${kind}`);
}

const deadline = Date.now() + waitMs;
let got = await answer();
while (got !== expected && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  got = await answer();
}
console.log(`E2E:probe=${got}`);
process.exit(got === expected ? 0 : 1);

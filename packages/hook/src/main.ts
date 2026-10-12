#!/usr/bin/env node
/**
 * emberline-hook <EventName>
 *
 * Invoked by Claude Code for each configured hook. Reads the JSON payload from stdin and
 * forwards it to core. It must never block or break the agent: every failure is swallowed
 * and the process always exits 0 quickly.
 *
 * Env:
 *   EMBERLINE_RUN_ID    run this Claude session belongs to (required, else no-op)
 *   EMBERLINE_CORE_URL  core base URL, default http://127.0.0.1:7420
 *   EMBERLINE_HOOK_TOKEN shared secret sent as a bearer token
 */
import { HookEventName, type HookEnvelope, HookPayload } from '@emberline/protocol';

const TIMEOUT_MS = 2_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const runId = process.env.EMBERLINE_RUN_ID;
  const event = HookEventName.safeParse(process.argv[2]);
  if (!runId || !event.success) return;

  const raw = await readStdin();
  let json: unknown = {};
  try {
    json = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    json = { unparsed: raw.slice(0, 10_000) };
  }
  const payload = HookPayload.safeParse(json);

  const envelope: HookEnvelope = {
    runId,
    event: event.data,
    receivedAt: new Date().toISOString(),
    payload: payload.success ? payload.data : {},
  };

  const base = process.env.EMBERLINE_CORE_URL ?? 'http://127.0.0.1:7420';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.EMBERLINE_HOOK_TOKEN) headers.authorization = `Bearer ${process.env.EMBERLINE_HOOK_TOKEN}`;

  await fetch(new URL('/api/internal/hooks', base), {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

main()
  .catch(() => {
    // Intentionally ignored: hook failures must not affect the agent.
  })
  .finally(() => process.exit(0));

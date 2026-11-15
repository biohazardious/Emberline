#!/usr/bin/env node
/**
 * Usage: emberline-copilot-models.mjs [copilot-command]
 *
 * Prints the models the signed-in Copilot CLI offers, one `modelId<TAB>name` line each, for model
 * discovery. Copilot has no listing command, but `copilot --acp` speaks the Agent Client Protocol
 * (newline-delimited JSON-RPC over stdio), and the answer to `session/new` names the models the
 * account may pick. So this opens a session, reads that list, closes the session again so the
 * person's Copilot session list does not fill up with probes, and stops the CLI.
 *
 * It never sends a prompt: only `initialize`, `session/new` and `session/close` are sent, and any
 * request the CLI makes of this client is refused. On any failure it exits non-zero with one short
 * reason on stderr, which core shows in the failure notice.
 */
import { spawn } from 'node:child_process';

const command = process.argv[2] || 'copilot';
// Well under discovery's 60 s hard timeout, so the reason names the step that hung.
const TIMEOUT_MS = Number(process.env.EMBERLINE_COPILOT_MODELS_TIMEOUT_MS) || 40_000;
/** How long the CLI gets to confirm the close, and then to exit on its own. */
const CLOSE_WAIT_MS = 3_000;
const EXIT_WAIT_MS = 2_000;

const child = spawn(command, ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'] });

let step = 'initialize';
let stderrTail = '';
let finished = false;
const pending = new Map();
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Ends the CLI: stdin closed first (an ACP agent exits on EOF), then a signal if it lingers. */
async function stopChild() {
  // No pid: it never started.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), EXIT_WAIT_MS);
  const hardTimer = setTimeout(() => child.kill('SIGKILL'), EXIT_WAIT_MS * 2);
  await exited;
  clearTimeout(timer);
  clearTimeout(hardTimer);
}

async function fail(reason) {
  if (finished) return;
  finished = true;
  process.stderr.write(`${reason.replace(/\s+/g, ' ').trim()}\n`);
  await stopChild();
  process.exit(1);
}

const timeout = setTimeout(
  () => void fail(`Copilot did not answer within ${Math.round(TIMEOUT_MS / 1000)} s (waiting for ${step})`),
  TIMEOUT_MS,
);

child.on('error', (err) => void fail(`could not start ${command}: ${err.message}`));
child.stdin.on('error', () => undefined);
child.stderr.on('data', (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
});
child.on('exit', (code, signal) => {
  if (finished) return;
  const said = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' / ');
  void fail(`${command} exited with ${code ?? signal} before it answered ${step}${said ? `: ${said}` : ''}`);
});

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) onMessage(line);
  }
});

function onMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Not protocol output; the CLI should not print any, but a stray line is no reason to fail.
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.method !== undefined) {
    // A request from the CLI (permissions, files, terminals): this client offers none of them.
    if (msg.id !== undefined && msg.id !== null) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })}\n`,
      );
    }
    return; // A notification (session updates): nothing to do.
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message || `error ${msg.error.code}`));
  else waiter.resolve(msg.result ?? {});
}

/** One `id<TAB>name` line per model; ids with whitespace (which would break the line format) are dropped. */
function lines(models) {
  const out = [];
  for (const m of models) {
    const id = typeof m?.modelId === 'string' ? m.modelId.trim() : '';
    if (!id || /\s/.test(id)) continue;
    const name = typeof m.name === 'string' ? m.name.replace(/\s+/g, ' ').trim() : '';
    out.push(`${id}\t${name || id}`);
  }
  return out;
}

async function main() {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  step = 'session/new';
  const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const models = session?.models?.availableModels;
  const sessionId = session?.sessionId;
  if (typeof sessionId === 'string' && sessionId) {
    step = 'session/close';
    let closeTimer;
    const closed = await Promise.race([
      request('session/close', { sessionId }).then(
        () => true,
        () => false,
      ),
      new Promise((resolve) => (closeTimer = setTimeout(() => resolve(false), CLOSE_WAIT_MS))),
    ]);
    clearTimeout(closeTimer);
    if (!closed) process.stderr.write(`Copilot did not confirm closing session ${sessionId}\n`);
  }
  if (!Array.isArray(models)) return fail('Copilot opened a session but named no models');
  const out = lines(models);
  if (out.length === 0) return fail('Copilot opened a session but named no models');
  finished = true;
  clearTimeout(timeout);
  await stopChild();
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

main().catch(
  (err) => void fail(`Copilot refused ${step}: ${err instanceof Error ? err.message : String(err)}`),
);

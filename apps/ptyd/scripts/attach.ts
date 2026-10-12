/**
 * Interactive ptyd attach tool for manual testing.
 *
 *   pnpm --filter @emberline/ptyd attach            # spawn $SHELL and attach
 *   pnpm --filter @emberline/ptyd attach <id>       # attach to an existing session
 *   pnpm --filter @emberline/ptyd attach --list     # list sessions
 *
 * Detach with Ctrl-] (the session keeps running inside ptyd).
 */
import os from 'node:os';
import path from 'node:path';
import { PtydClient } from '../src/client.js';

const DETACH_KEY = '\x1d'; // Ctrl-]

const socketPath =
  process.env.EMBERLINE_PTYD_SOCKET ?? path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'emberline', 'ptyd.sock');

const client = await PtydClient.connect(socketPath);
const arg = process.argv[2];

if (arg === '--list') {
  const { sessions } = await client.list();
  for (const s of sessions) console.log(`${s.id}\t${s.status}\tpid=${s.pid}\t${s.file} ${s.args.join(' ')}`);
  client.close();
  process.exit(0);
}

const cols = process.stdout.columns ?? 120;
const rows = process.stdout.rows ?? 32;
const sessionId =
  arg ?? (await client.spawn({ file: process.env.SHELL ?? '/bin/bash', cwd: process.cwd(), cols, rows })).id;

client.on('output', (id, data) => {
  if (id === sessionId) process.stdout.write(data);
});
client.on('exit', (id, code) => {
  if (id !== sessionId) return;
  process.stderr.write(`\r\n[session exited with code ${code}]\r\n`);
  cleanup(0);
});
client.on('close', () => cleanup(1));

const { snapshot } = await client.attach(sessionId);
process.stdout.write('\x1bc'); // reset local terminal before replaying the remote screen
process.stdout.write(snapshot.data);
await client.resize(sessionId, cols, rows);
process.stderr.write(`\x1b]0;ptyd:${sessionId}\x07`);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data: string) => {
  if (data === DETACH_KEY) {
    process.stderr.write(`\r\n[detached from ${sessionId}]\r\n`);
    cleanup(0);
    return;
  }
  void client.write(sessionId, data);
});
process.stdout.on('resize', () => {
  void client.resize(sessionId, process.stdout.columns, process.stdout.rows);
});

function cleanup(code: number): never {
  process.stdin.setRawMode?.(false);
  client.close();
  process.exit(code);
}

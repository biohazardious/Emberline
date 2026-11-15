import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../wrappers/emberline-copilot-models.mjs', import.meta.url));

/**
 * A stand-in for `copilot --acp`: answers initialize, session/new and session/close the way Copilot
 * CLI 1.0.112 does (a session update notification before the session/new answer, a request of its
 * own to the client), and logs every method it receives. FAKE_ACP_MODE picks a misbehaviour.
 */
const FAKE_AGENT = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const mode = process.env.FAKE_ACP_MODE || 'ok';
const log = process.env.FAKE_ACP_LOG;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
if (process.argv[2] !== '--acp') { process.stderr.write('expected --acp\\n'); process.exit(2); }
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    appendFileSync(log, (msg.method ?? 'response:' + msg.id + ':' + (msg.error ? msg.error.code : 'ok')) + '\\n');
    if (mode === 'hang') continue;
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
    } else if (msg.method === 'session/new') {
      if (mode === 'signed-out') { send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } }); continue; }
      if (mode === 'exit') { process.stderr.write('boom\\n'); process.exit(3); }
      send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'available_commands_update' } } });
      send({ id: 'agent-1', method: 'session/request_permission', params: {} });
      const availableModels = mode === 'none' ? [] : [
        { modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
        { modelId: 'gpt-5.6-luna', name: 'GPT-5.6\\tLuna', _meta: { copilotEnablement: 'enabled' } },
        { modelId: 'bad id', name: 'Spaced' },
        { modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      ];
      send({ id: msg.id, result: { sessionId: 's-1', models: { availableModels, currentModelId: 'auto' } } });
    } else if (msg.method === 'session/close') {
      if (mode !== 'no-close') send({ id: msg.id, result: {} });
    } else if (msg.id !== undefined && msg.method) {
      send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    }
  }
});
process.stdin.on('end', () => { appendFileSync(log, 'eof\\n'); process.exit(0); });
`;

let dir: string;
let agent: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'copilot-models-'));
  agent = path.join(dir, 'fake-copilot');
  writeFileSync(agent, FAKE_AGENT);
  chmodSync(agent, 0o755);
});

function run(mode: string, extraEnv: Record<string, string> = {}) {
  const log = path.join(dir, `${mode}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const res = spawnSync(process.execPath, [wrapper, agent], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', FAKE_ACP_MODE: mode, FAKE_ACP_LOG: log, ...extraEnv },
    encoding: 'utf8',
    timeout: 12_000,
  });
  const received = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, received };
}

describe('emberline-copilot-models', () => {
  it('prints the models of a new session, closes it and never sends a prompt', () => {
    const { status, stdout, stderr, received } = run('ok');
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toBe('auto\tAuto\ngpt-5.6-luna\tGPT-5.6 Luna\nclaude-sonnet-5\tClaude Sonnet 5\n');
    expect(received).toEqual([
      'initialize',
      'session/new',
      // The CLI's own request was refused, not answered.
      'response:agent-1:-32601',
      'session/close',
      'eof',
    ]);
    expect(received).not.toContain('session/prompt');
  });

  it('still prints the models when the close is not confirmed, and says so', () => {
    const { status, stdout, stderr, received } = run('no-close');
    expect(status).toBe(0);
    expect(stdout).toContain('claude-sonnet-5\tClaude Sonnet 5');
    expect(stderr).toBe('Copilot did not confirm closing session s-1\n');
    expect(received).toContain('session/close');
  });

  it('exits non-zero with the step it waited for when the CLI does not answer', () => {
    const { status, stdout, stderr, received } = run('hang', { EMBERLINE_COPILOT_MODELS_TIMEOUT_MS: '500' });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Copilot did not answer within 1 s (waiting for initialize)\n');
    // The CLI was stopped by closing its input.
    expect(received).toEqual(['initialize', 'eof']);
  });

  it('reports a refused session (signed out)', () => {
    const { status, stderr, received } = run('signed-out');
    expect(status).toBe(1);
    expect(stderr).toBe('Copilot refused session/new: Authentication required\n');
    expect(received).not.toContain('session/prompt');
  });

  it('reports a CLI that exits before it answers, with what it said', () => {
    const { status, stderr } = run('exit');
    expect(status).toBe(1);
    expect(stderr).toMatch(/exited with 3 before it answered session\/new: boom\n$/);
  });

  it('fails on a session that names no models', () => {
    const { status, stdout, stderr, received } = run('none');
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Copilot opened a session but named no models\n');
    expect(received).toContain('session/close');
  });

  it('fails clearly when the command is missing', () => {
    const res = spawnSync(process.execPath, [wrapper, path.join(dir, 'no-such-copilot')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 12_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^could not start .*no-such-copilot: spawn .* ENOENT\n$/);
  });
});

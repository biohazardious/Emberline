import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentId, type CliToolStatus, resolveCliModel, setModelCatalog } from '@emberline/protocol';
import { PtydClient } from '@emberline/ptyd/client';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenedDb, openDb, setSetting } from '../db/index.js';
import { NoticeService } from '../notices/service.js';
import { ToolchainService } from '../toolchain/service.js';
import { updateFactorySettings } from '../factory/settings.js';
import { readCatalog } from './catalog.js';
import {
  DISCOVERY_JOBS,
  type DiscoveryJob,
  failureReason,
  listingJob,
  MODEL_PROBE_KIND,
  ModelDiscovery,
  type ModelDiscoveryDeps,
  PROBE_DIR_NAME,
  pickerJob,
} from './discovery.js';
import { parseAgyModels } from './list-command.js';
import { PickerError, type PickerScript } from './picker.js';

const FAKE_PICKER = fileURLToPath(new URL('./fixtures/fake-picker-cli.mjs', import.meta.url));
const AGY_FIXTURE = fileURLToPath(new URL('./fixtures/agy-models.txt', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/codex-debug-models-0.169.0.json', import.meta.url));

let opened: OpenedDb;
let notices: NoticeService;
beforeEach(() => {
  opened = openDb(':memory:');
  notices = new NoticeService(opened.db);
  enable(['claude', 'antigravity']);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setModelCatalog(null);
  opened.close();
});

function enable(providers: AgentId[]) {
  setSetting(opened.db, 'factory.settings', { enabledProviders: providers });
}

class FakePtyd extends EventEmitter {
  status = 'connected';
  client = {} as never;
  get() {
    return this.client;
  }
  connect() {
    this.status = 'connected';
    this.emit('status', 'connected');
  }
}

/** A toolchain that reports `installed` CLIs at version 1.2.3 and can announce an install. */
function fakeToolchain(installed: AgentId[]) {
  const listeners = new Set<(p: AgentId) => void>();
  return {
    getToolStatus: async (provider: AgentId) =>
      ({
        provider,
        installed: installed.includes(provider),
        installing: false,
        version: installed.includes(provider) ? '1.2.3' : null,
      }) as CliToolStatus,
    onCliInstalled: (listener: (p: AgentId) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    announce: (provider: AgentId) => listeners.forEach((l) => l(provider)),
  };
}

const listed =
  (...ids: string[]): DiscoveryJob =>
  async () => ({
    models: ids.map((id) => ({ id, label: `Label ${id}` })),
    source: 'cli',
  });

function discovery(overrides: Partial<ModelDiscoveryDeps> = {}) {
  return new ModelDiscovery({
    db: opened.db,
    ptyd: new FakePtyd(),
    toolchain: fakeToolchain(['claude', 'antigravity', 'aider']),
    notices,
    log: () => undefined,
    now: () => new Date('2026-11-15T10:00:00.000Z'),
    ...overrides,
  });
}

describe('refresh', () => {
  it('reads installed and enabled providers only, one at a time', async () => {
    enable(['claude', 'antigravity', 'gemini']);
    let running = 0;
    let most = 0;
    const ran: AgentId[] = [];
    const job =
      (agent: AgentId): DiscoveryJob =>
      async () => {
        ran.push(agent);
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { models: [{ id: `${agent}-x`, label: 'X' }], source: 'cli' };
      };
    const d = discovery({
      // aider is installed but not enabled; gemini is enabled but not installed.
      toolchain: fakeToolchain(['claude', 'antigravity', 'aider']),
      jobs: {
        claude: job('claude'),
        antigravity: job('antigravity'),
        aider: job('aider'),
        gemini: job('gemini'),
      },
    });
    const reads = await d.refresh();
    expect(ran).toEqual(['claude', 'antigravity']);
    expect(most).toBe(1);
    expect(Object.keys(reads).sort()).toEqual(['antigravity', 'claude']);
    expect(reads.claude).toMatchObject({ ok: true, cliVersion: '1.2.3' });
  });

  it('reads a provider whose command is overridden even when the toolchain does not know it', async () => {
    const d = discovery({
      toolchain: fakeToolchain([]),
      jobs: { claude: listed('c-1'), antigravity: listed('a-1') },
    });
    expect(Object.keys(await d.refresh())).toEqual([]);
    vi.stubEnv('EMBERLINE_ANTIGRAVITY_COMMAND', '/e2e/fake-agy.mjs');
    expect(Object.keys(await d.refresh())).toEqual(['antigravity']);
    vi.unstubAllEnvs();
  });

  it('does not read a picker provider just because its command is overridden', async () => {
    vi.stubEnv('EMBERLINE_CLAUDE_COMMAND', '/e2e/fake-claude.mjs');
    const d = discovery({ toolchain: fakeToolchain([]), jobs: { claude: listed('c-1') } });
    expect(Object.keys(await d.refresh())).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('joins a read of the same provider that is still queued', async () => {
    const calls: AgentId[] = [];
    const d = discovery({
      jobs: {
        claude: async () => {
          calls.push('claude');
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { models: [{ id: 'opus', label: 'Opus' }], source: 'picker' };
        },
        antigravity: async () => {
          calls.push('antigravity');
          return { models: [{ id: 'a-1', label: 'A' }], source: 'cli' };
        },
      },
    });
    await Promise.all([d.refresh(), d.refresh('antigravity'), d.refresh('antigravity')]);
    expect(calls).toEqual(['claude', 'antigravity']);
  });

  it('skips everything while the runner is away', async () => {
    const ptyd = new FakePtyd();
    ptyd.status = 'disconnected';
    const job = vi.fn(listed('a-1'));
    expect(await discovery({ ptyd, jobs: { antigravity: job } }).refresh()).toEqual({});
    expect(job).not.toHaveBeenCalled();
  });

  it('announces new models once, and closes an open failure notice', async () => {
    const newModels = vi.spyOn(notices, 'newModels');
    const recovered = vi.spyOn(notices, 'readRecovered');
    // gemini-4-argon-medium was known at release; the hydrogen ones are new.
    const d = discovery({
      jobs: {
        antigravity: listed('gemini-4-argon-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh'),
      },
    });
    await d.refresh('antigravity');
    expect(newModels).toHaveBeenCalledTimes(1);
    expect(newModels.mock.calls[0]![0]).toBe('antigravity');
    expect(newModels.mock.calls[0]![1].map((m) => m.id)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-xhigh',
    ]);
    expect(recovered).toHaveBeenCalledWith('antigravity');

    await d.refresh('antigravity');
    expect(newModels).toHaveBeenCalledTimes(1);
    expect(notices.list().filter((n) => n.kind === 'new_models')).toHaveLength(1);
  });

  it('records each failure and opens one notice for two in a row', async () => {
    const readFailed = vi.spyOn(notices, 'readFailed');
    const d = discovery({
      jobs: {
        antigravity: async () => {
          throw new Error('`agy` exited with 1: not signed in.');
        },
      },
    });
    await d.refresh('antigravity');
    const reads = await d.refresh('antigravity');
    expect(reads.antigravity).toMatchObject({ ok: false, error: '`agy` exited with 1: not signed in' });
    expect(readFailed).toHaveBeenCalledTimes(1);
    const unread = notices.list().filter((n) => n.kind === 'models_unread');
    expect(unread).toHaveLength(1);
    expect(unread[0]!.text).toBe(
      "Couldn't read AGY's model list (1.2.3): `agy` exited with 1: not signed in. The last list read stays; you can add a model by hand.",
    );
  });

  it('stops a job past the hard timeout, records it as failed, and only then starts the next', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const stop = vi.fn();
    const d = discovery({
      jobs: {
        claude: (ctx) =>
          new Promise((_resolve, reject) => {
            order.push('claude started');
            ctx.onStop(async () => {
              stop();
              order.push('claude stopped');
              reject(new Error('killed'));
            });
          }),
        antigravity: async () => {
          order.push('antigravity started');
          return { models: [{ id: 'a-1', label: 'A' }], source: 'cli' };
        },
      },
    });
    const reads = d.refresh();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stop).not.toHaveBeenCalled();
    expect(order).toEqual(['claude started']);
    await vi.advanceTimersByTimeAsync(1);
    const result = await reads;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['claude started', 'claude stopped', 'antigravity started']);
    expect(result.claude).toMatchObject({
      ok: false,
      error: 'it did not finish within 60 s and was stopped',
    });
    expect(notices.list().filter((n) => n.kind === 'models_unread')).toHaveLength(1);
  });
});

describe('failureReason', () => {
  it("names the picker's step with the end of its screen, within 300 characters", () => {
    const reason = failureReason(
      new PickerError('ready', `Welcome\n\n  Do you trust this folder?  \n${'x'.repeat(400)}`),
    );
    expect(
      reason.startsWith('its prompt did not appear (the screen ended with: Welcome / Do you trust'),
    ).toBe(true);
    expect(reason).toHaveLength(300);
  });
});

describe('triggers', () => {
  it('reads once when the runner first connects, then every 24 hours, until stopped', async () => {
    vi.useFakeTimers();
    const ptyd = new FakePtyd();
    ptyd.status = 'connecting';
    const job = vi.fn(listed('a-1'));
    const d = discovery({ ptyd, jobs: { antigravity: job } });
    d.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(job).toHaveBeenCalledTimes(0);

    ptyd.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(job).toHaveBeenCalledTimes(1);
    // A reconnect is not a core start.
    ptyd.status = 'disconnected';
    ptyd.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(job).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(job).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(job).toHaveBeenCalledTimes(3);

    await d.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(job).toHaveBeenCalledTimes(3);
  });

  it('waits for a runner that may not start anything yet (the ops service is missing)', async () => {
    const ptyd = Object.assign(new FakePtyd(), { available: false });
    const ops = new EventEmitter();
    const job = vi.fn(listed('a-1'));
    const d = discovery({ ptyd, ops, jobs: { antigravity: job } });
    d.start();
    expect(await d.refresh()).toEqual({});
    expect(job).not.toHaveBeenCalled();
    ptyd.available = true;
    ops.emit('status', 'connected');
    await vi.waitFor(() => expect(job).toHaveBeenCalledTimes(1));
    await d.stop();
  });

  it('publishes the stored list on start, before any read: runs launched meanwhile resolve against it', async () => {
    setSetting(opened.db, 'models.catalog', {
      antigravity: {
        models: [
          {
            id: 'gemini-4-argon-high',
            label: 'Argon (High)',
            shortLabel: 'gemini-4-argon-high',
            rank: 4,
            tier: 'high',
            badge: 'discovered',
            capabilities: [],
            description: '',
            source: 'cli',
            missingSince: null,
            firstSeen: '2026-11-14T10:00:00.000Z',
            lastSeen: '2026-11-14T10:00:00.000Z',
          },
        ],
        read: null,
      },
    });
    const ptyd = new FakePtyd();
    ptyd.status = 'connecting';
    const d = discovery({ ptyd, jobs: {} });
    expect(resolveCliModel('antigravity', 'argon')).toBeNull();
    d.start();
    expect(resolveCliModel('antigravity', 'argon')).toBe('gemini-4-argon-high');
    await d.stop();
  });

  it('reads at once on start when the runner is already connected', async () => {
    const job = vi.fn(listed('a-1'));
    const d = discovery({ jobs: { antigravity: job } });
    d.start();
    await vi.waitFor(() => expect(job).toHaveBeenCalledTimes(1));
    await d.stop();
  });

  it('stop() ends the running job and waits for it, recording no failure', async () => {
    let stopped = false;
    const d = discovery({
      jobs: {
        antigravity: (ctx) =>
          new Promise((_resolve, reject) =>
            ctx.onStop(async () => {
              stopped = true;
              reject(new Error('killed'));
            }),
          ),
      },
    });
    d.start();
    await vi.waitFor(() => expect(d['stopCurrent']).not.toBeNull());
    await d.stop();
    expect(stopped).toBe(true);
    expect(readCatalog(opened.db).antigravity.read).toBeNull();
  });

  it('reads antigravity again after the toolchain updates its CLI', async () => {
    const client = {
      spawn: vi.fn(async () => ({ id: 's1' })),
      list: vi.fn(async () => ({ sessions: [{ id: 's1', status: 'exited', exitCode: 0, meta: {} }] })),
      snapshot: vi.fn(async () => ({ data: 'done' })),
      remove: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    const bridge = { status: 'connected', get: () => client };
    const toolchain = new ToolchainService(opened.db, bridge as never, '/workspaces');
    const d = discovery({ toolchain });
    const refresh = vi.spyOn(d, 'refresh').mockResolvedValue({});

    const response = await toolchain.executeAction('antigravity', { action: 'update', spawnTerminal: false });
    expect(response.output).toBe('done');
    expect(refresh).toHaveBeenCalledWith('antigravity');
    expect(refresh).toHaveBeenCalledTimes(1);

    // An uninstall reads nothing; neither does a failed update.
    await toolchain.executeAction('antigravity', { action: 'uninstall', spawnTerminal: false });
    client.list.mockResolvedValue({ sessions: [{ id: 's1', status: 'exited', exitCode: 1, meta: {} }] });
    await expect(
      toolchain.executeAction('antigravity', { action: 'update', spawnTerminal: false }),
    ).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
    await d.stop();
  });

  it('a toolchain install announcement starts a read of that provider only', async () => {
    const toolchain = fakeToolchain(['claude', 'antigravity']);
    const claude = vi.fn(listed('opus'));
    const agy = vi.fn(listed('a-1'));
    const d = discovery({ toolchain, jobs: { claude, antigravity: agy } });
    toolchain.announce('antigravity');
    await vi.waitFor(() => expect(agy).toHaveBeenCalledTimes(1));
    expect(claude).not.toHaveBeenCalled();
    await d.stop();
  });
});

describe('jobs in a runner', () => {
  let dir: string;
  let home: string;
  let tools: string;
  let server: PtydServer;
  let client: PtydClient;
  let ptyd: FakePtyd;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'discovery-'));
    home = path.join(dir, 'home');
    tools = path.join(dir, 'tools');
    mkdirSync(home);
    mkdirSync(path.join(tools, 'bin'), { recursive: true });
    server = new PtydServer({ socketPath: path.join(dir, 'ptyd.sock') });
    await server.listen();
    client = await PtydClient.connect(server.socketPath);
    ptyd = new FakePtyd();
    ptyd.client = client as never;
  });
  afterEach(async () => {
    delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
    delete process.env.EMBERLINE_CODEX_COMMAND;
    delete process.env.EMBERLINE_COPILOT_COMMAND;
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const inRunner = (jobs: ModelDiscoveryDeps['jobs'], extra: Partial<ModelDiscoveryDeps> = {}) =>
    discovery({ ptyd, runnerHome: home, toolsDir: tools, jobs, ...extra });

  function fakeScript(env: Record<string, string> = {}, stepTimeoutMs = 3_000): PickerScript {
    return {
      command: {
        file: process.execPath,
        args: [FAKE_PICKER],
        env: { FAKE_PICKER_LOG: path.join(dir, 'fake.log'), ...env },
      },
      ready: /^>\s*$/m,
      picker: /Select model/,
      groupRow: /More models/,
      cursorRow: /^\s*❯/,
      exit: '/exit',
      stepTimeoutMs,
    };
  }

  it('runs agy models in the scratch folder after the seed and parses its list', async () => {
    const seedLog = path.join(dir, 'seed.log');
    const seed = path.join(tools, 'bin', 'emberline-cli-seed.mjs');
    writeFileSync(seed, `#!/bin/sh\necho "seed $1" >> "${seedLog}"\n`);
    chmodSync(seed, 0o755);
    const agy = path.join(dir, 'fake-agy');
    writeFileSync(agy, `#!/bin/sh\necho "agy $* in $(pwd)" >> "${seedLog}"\ncat "${AGY_FIXTURE}"\n`);
    chmodSync(agy, 0o755);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = agy;

    const reads = await inRunner({ antigravity: listingJob((out) => parseAgyModels(out)) }).refresh();
    expect(reads.antigravity).toMatchObject({ ok: true });
    const probeDir = path.join(home, PROBE_DIR_NAME);
    expect(readFileSync(seedLog, 'utf8')).toBe(
      `seed antigravity\nagy --log-file /dev/null models in ${probeDir}\n`,
    );
    const ids = readCatalog(opened.db).antigravity.models.map((m) => m.id);
    expect(ids).toContain('gemini-4-hydrogen-xhigh');
    expect(notices.list().find((n) => n.kind === 'new_models')?.title).toBe('AGY has 7 new models');
  });

  /** A `codex` that logs how it was called and prints the captured catalog on one line. */
  function fakeCodex(): string {
    const log = path.join(dir, 'codex.log');
    const codex = path.join(dir, 'fake-codex');
    writeFileSync(
      codex,
      `#!/bin/sh\necho "codex $* key=$CODEX_API_KEY" >> "${log}"\ntr -d '\\n' < "${CODEX_FIXTURE}"\n`,
    );
    chmodSync(codex, 0o755);
    process.env.EMBERLINE_CODEX_COMMAND = codex;
    return log;
  }

  it("does not run Codex without a Codex login: signed out it prints its bundled catalog as if it were the account's", async () => {
    enable(['codex']);
    updateFactorySettings(opened.db, { openaiApiKey: 'sk-test' });
    const log = fakeCodex();
    const reads = await inRunner(
      { codex: DISCOVERY_JOBS.codex },
      { toolchain: fakeToolchain(['codex']) },
    ).refresh();
    expect(reads.codex).toBeUndefined();
    expect(existsSync(log)).toBe(false);
    expect(readCatalog(opened.db).codex).toEqual({ models: [], read: null });
    expect(notices.list()).toEqual([]);
  });

  it("reads Codex's catalog with the stored key as Codex reads it, and knows the models it shipped with", async () => {
    enable(['codex']);
    updateFactorySettings(opened.db, { openaiApiKey: 'sk-test' });
    mkdirSync(path.join(home, '.codex'));
    writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
    const log = fakeCodex();

    const reads = await inRunner(
      { codex: DISCOVERY_JOBS.codex },
      { toolchain: fakeToolchain(['codex']) },
    ).refresh();
    expect(reads.codex).toMatchObject({ ok: true });
    expect(readFileSync(log, 'utf8')).toBe(
      'codex -c check_for_update_on_startup=false debug models key=sk-test\n',
    );
    expect(readCatalog(opened.db).codex.models.map((m) => m.id)).toEqual([
      'gpt-6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    // Every model of the capture was known when this release was cut.
    expect(notices.list().filter((n) => n.kind === 'new_models')).toEqual([]);
  });

  it("reads Copilot's models through the listing script; Copilot's own auto alone is an empty read", async () => {
    enable(['copilot']);
    const seedLog = path.join(dir, 'seed.log');
    const seed = path.join(tools, 'bin', 'emberline-cli-seed.mjs');
    writeFileSync(seed, `#!/bin/sh\necho "seed $1" >> "${seedLog}"\n`);
    chmodSync(seed, 0o755);
    const answer = path.join(dir, 'answer.txt');
    const script = path.join(tools, 'bin', 'emberline-copilot-models.mjs');
    writeFileSync(
      script,
      `#!/bin/sh\necho "list $1 update=$COPILOT_AUTO_UPDATE" >> "${seedLog}"\ncat "${answer}"\n`,
    );
    chmodSync(script, 0o755);
    const job = () =>
      inRunner({ copilot: DISCOVERY_JOBS.copilot }, { toolchain: fakeToolchain(['copilot']) });

    writeFileSync(answer, 'auto\tAuto\ngpt-5.6-luna\tGPT-5.6 Luna\n');
    expect((await job().refresh()).copilot).toMatchObject({ ok: true });
    expect(readFileSync(seedLog, 'utf8')).toBe('seed copilot\nlist copilot update=false\n');
    expect(readCatalog(opened.db).copilot.models).toMatchObject([{ id: 'gpt-5.6-luna', missingSince: null }]);

    // A free account: the read works and lists nothing of Copilot's own, so the earlier model is
    // marked missing (kept, not wiped) and no failure is recorded.
    writeFileSync(answer, 'auto\tAuto\nauto\tAuto\n');
    expect((await job().refresh()).copilot).toMatchObject({ ok: true, error: null });
    expect(readCatalog(opened.db).copilot.models).toMatchObject([
      { id: 'gpt-5.6-luna', missingSince: '2026-11-15T10:00:00.000Z' },
    ]);
    expect(notices.list().filter((n) => n.kind !== 'new_models')).toEqual([]);
  });

  it('ends the Copilot CLI with the listing script when the hard timeout cancels the script', async () => {
    // A stand-in `copilot --acp` that never answers and outlives the end of its input: only a kill of
    // the whole process group stops it.
    const pidFile = path.join(dir, 'copilot.pid');
    const copilot = path.join(dir, 'fake-copilot');
    writeFileSync(
      copilot,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.stdin.resume();\nprocess.stdin.on('end', () => undefined);\nsetInterval(() => undefined, 1000);\n`,
    );
    chmodSync(copilot, 0o755);
    const script = fileURLToPath(
      new URL('../../../../packages/hook/wrappers/emberline-copilot-models.mjs', import.meta.url),
    );
    const execId = 'copilot-listing';
    const running = client.exec({
      file: process.execPath,
      args: [script, copilot],
      cwd: dir,
      execId,
      timeoutMs: 30_000,
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    await client.execCancel(execId);
    expect(await running).toMatchObject({ cancelled: true });
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  });

  it('counts a cut-off listing as a failure', async () => {
    const agy = path.join(dir, 'fake-agy');
    writeFileSync(agy, `#!/bin/sh\nhead -c 9000000 /dev/zero | tr '\\0' 'a'\n`);
    chmodSync(agy, 0o755);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = agy;
    const reads = await inRunner({ antigravity: listingJob((out) => parseAgyModels(out)) }).refresh();
    expect(reads.antigravity?.error).toBe(`\`${agy}\` printed more than a model list can be`);
  });

  it('counts a list it cannot read as a failure, never as an empty list', async () => {
    const agy = path.join(dir, 'fake-agy');
    writeFileSync(agy, '#!/bin/sh\necho "Fetching available models..."\n');
    chmodSync(agy, 0o755);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = agy;
    const reads = await inRunner({ antigravity: listingJob((out) => parseAgyModels(out)) }).refresh();
    expect(reads.antigravity?.error).toBe(`\`${agy}\` listed no models it could read`);
    expect(readCatalog(opened.db).antigravity.models).toEqual([]);
  });

  it("records the command's own error when it fails", async () => {
    const agy = path.join(dir, 'fake-agy');
    writeFileSync(agy, '#!/bin/sh\necho "Please sign in first." >&2\nexit 3\n');
    chmodSync(agy, 0o755);
    process.env.EMBERLINE_ANTIGRAVITY_COMMAND = agy;
    const reads = await inRunner({ antigravity: listingJob((out) => parseAgyModels(out)) }).refresh();
    expect(reads.antigravity?.error).toBe(`\`${agy}\` exited with 3: Please sign in first`);
  });

  it('reads a picker in a probe terminal in the scratch folder, then removes it', async () => {
    const spawn = vi.spyOn(client, 'spawn');
    const kinds: string[] = [];
    const parse = (screens: string[]) => {
      return screens.join('\n').includes('Fable 5.1')
        ? [{ id: 'claude-fable-5-1', label: 'Fable 5.1', description: '' }]
        : [];
    };
    const d = inRunner({ claude: pickerJob(fakeScript(), parse) });
    const reads = d.refresh('claude');
    await vi.waitFor(async () => {
      const sessions = (await client.list()).sessions;
      kinds.push(...sessions.map((s) => s.meta.kind ?? ''));
      expect(sessions.length).toBe(1);
    });
    expect((await reads).claude).toMatchObject({ ok: true });
    expect(kinds).toContain(MODEL_PROBE_KIND);
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      file: 'bash',
      cwd: home,
      env: { CLAUDE_CODE_SANDBOXED: '1' },
      meta: { kind: MODEL_PROBE_KIND, noLog: '1' },
    });
    expect(existsSync(path.join(home, PROBE_DIR_NAME))).toBe(true);
    expect((await client.list()).sessions).toEqual([]);
    expect(readCatalog(opened.db).claude.models.map((m) => m.id)).toEqual(['claude-fable-5-1']);
    // Nothing was saved or submitted in the CLI.
    expect(
      existsSync(path.join(dir, 'fake.log')) ? readFileSync(path.join(dir, 'fake.log'), 'utf8') : '',
    ).toBe('');
  });

  const leftover = (kind = MODEL_PROBE_KIND) =>
    client.spawn({ file: '/bin/sh', args: ['-c', 'sleep 30'], cwd: dir, meta: { kind } });
  const sessionKinds = async () => (await client.list()).sessions.map((s) => s.meta.kind);

  it('removes probe terminals a previous core left behind before its first read', async () => {
    const probe = await leftover();
    const shell = await leftover('shell');
    ptyd.status = 'connecting';
    const remove = vi.spyOn(client, 'remove');
    const job = vi.fn(listed('a-1'));
    const d = inRunner({ antigravity: job });
    d.start();
    ptyd.connect();
    await vi.waitFor(() => expect(job).toHaveBeenCalledTimes(1));
    // The sweep ran before the read.
    expect(remove).toHaveBeenCalledWith(probe.id);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(job.mock.invocationCallOrder[0]!);
    const ids = (await client.list()).sessions.map((s) => s.id);
    expect(ids).not.toContain(probe.id);
    expect(ids).toContain(shell.id);
    await d.stop();
  });

  it('sweeps a leftover probe on a reconnect while no job runs', async () => {
    const d = inRunner({});
    d.start();
    await d.refresh();
    await leftover();
    expect(await sessionKinds()).toContain(MODEL_PROBE_KIND);
    ptyd.connect();
    await vi.waitFor(async () => expect(await sessionKinds()).not.toContain(MODEL_PROBE_KIND));
    await d.stop();
  });

  it("spares the running job's probe terminal when a reconnect sweeps", async () => {
    const script = fakeScript({ FAKE_PICKER_MODE: 'update' }, 30_000);
    const d = inRunner({ claude: pickerJob(script, () => []) });
    const reads = d.refresh('claude');
    await vi.waitFor(async () => expect(await sessionKinds()).toContain(MODEL_PROBE_KIND));
    await d.sweep();
    expect(await sessionKinds()).toContain(MODEL_PROBE_KIND);
    await d.stop();
    await reads;
    expect(await sessionKinds()).not.toContain(MODEL_PROBE_KIND);
  });

  it('kills and removes the probe terminal when the hard timeout fires', async () => {
    // A ptyd request that never answers (until its session is gone) is outside the reader's own
    // step times; only the hard timeout ends it.
    let removed!: () => void;
    const gone = new Promise<void>((resolve) => (removed = resolve));
    ptyd.client = {
      spawn: client.spawn.bind(client),
      write: client.write.bind(client),
      kill: client.kill.bind(client),
      remove: async (id: string) => {
        await client.remove(id);
        removed();
      },
      snapshot: () => gone.then(() => Promise.reject(new Error('session removed'))),
    } as never;
    const d = inRunner({ claude: pickerJob(fakeScript(), () => []) }, { timeoutMs: 2_000 });
    const reads = await d.refresh('claude');
    expect(reads.claude).toMatchObject({ ok: false, error: 'it did not finish within 2 s and was stopped' });
    expect((await client.list()).sessions).toEqual([]);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtydClient } from '@emberline/ptyd/client';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PickerError, type PickerScript, readPicker } from './picker.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-picker-cli.mjs', import.meta.url));
const DOWN = '\x1b[B';
const ESC = '\x1b';

let dir: string;
let logFile: string;
let server: PtydServer;
let client: PtydClient;
let writes: string[];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'picker-'));
  logFile = path.join(dir, 'fake.log');
  server = new PtydServer({ socketPath: path.join(dir, 'ptyd.sock') });
  await server.listen();
  client = await PtydClient.connect(server.socketPath);
  writes = [];
  const write = client.write.bind(client);
  vi.spyOn(client, 'write').mockImplementation((id: string, data: string) => {
    writes.push(data);
    return write(id, data);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  client.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function script(env: Record<string, string> = {}, stepTimeoutMs = 3_000): PickerScript {
  return {
    command: { file: process.execPath, args: [FAKE], env: { FAKE_PICKER_LOG: logFile, ...env } },
    ready: /^>\s*$/m,
    picker: /Select model/,
    // Also matches the group row once it is open (`▴ More models`), so a group is opened only once.
    groupRow: /More models/,
    cursorRow: /^\s*❯/,
    exit: '/exit',
    stepTimeoutMs,
  };
}

const fakeLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const sessions = async () => (await client.list()).sessions;

async function pickerError(promise: Promise<unknown>): Promise<PickerError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PickerError);
  return error as PickerError;
}

describe('the fake CLI', () => {
  it('records Enter on a model row and a submitted prompt, so an empty log means neither happened', async () => {
    const { id } = await client.spawn({
      file: process.execPath,
      args: [FAKE],
      cwd: dir,
      env: { FAKE_PICKER_LOG: logFile },
    });
    const screen = async () => (await client.snapshot(id, 0)).data;
    await expect.poll(screen).toMatch(/>/);
    await client.write(id, 'hello\r');
    await client.write(id, '/model\r');
    await expect.poll(screen).toMatch(/Select model/);
    await client.write(id, '\r');
    await expect.poll(fakeLog).toBe('PROMPT hello\nSAVED opus\n');
    await client.remove(id);
  });
});

describe('readPicker', () => {
  it('reads the picker, opens the collapsed group once, closes it and changes nothing', async () => {
    const { screens } = await readPicker(client, script(), { cwd: dir, deadlineMs: 30_000 });

    expect(screens).toHaveLength(2);
    expect(screens[0]).toContain('▾ More models');
    expect(screens[0]).toContain('2. Opus ✔');
    expect(screens[0]).not.toContain('Fable 5.1');
    expect(screens[1]).toMatch(/❯ ▴ More models/);
    expect(screens[1]).toContain('5. Fable 5.1');
    expect(screens[1]).toContain('6. Opus 4.1');
    // The cursor starts on Opus (row 2) and the group is two rows below Haiku (row 4): three Downs.
    expect(writes).toEqual(['/model', '\r', DOWN, DOWN, DOWN, '\r', ESC, '/exit', '\r']);
    expect(fakeLog()).toBe('');
    expect(await sessions()).toEqual([]);
  });

  it('keeps the columns of a picker laid out with cursor moves', async () => {
    const { screens } = await readPicker(client, script({ FAKE_PICKER_MODE: 'gaps' }), {
      cwd: dir,
      deadlineMs: 30_000,
    });
    expect(screens[0]).toContain(` ❯ ${'2. Opus ✔'.padEnd(28)}Opus 5.5 · Most capable for complex work`);
    expect(screens[1]).toContain(`   ${'5. Fable 5.1'.padEnd(28)}Fable 5.1 · Long-form writing`);
    expect(fakeLog()).toBe('');
  });

  it('waits for each key to take effect, not for any redraw, and still changes nothing', async () => {
    const { screens } = await readPicker(client, script({ FAKE_PICKER_MODE: 'noisy' }), {
      cwd: dir,
      deadlineMs: 30_000,
    });
    expect(screens).toHaveLength(2);
    expect(screens[0]).not.toContain('Fable 5.1');
    expect(screens[1]).toMatch(/❯ ▴ More models/);
    expect(screens[1]).toContain('5. Fable 5.1');
    expect(writes).toEqual(['/model', '\r', DOWN, DOWN, DOWN, '\r', ESC, '/exit', '\r']);
    expect(fakeLog()).toBe('');
    expect(await sessions()).toEqual([]);
  });

  it('fails at the ready step on a screen that is not the prompt, typing nothing', async () => {
    const error = await pickerError(
      readPicker(client, script({ FAKE_PICKER_MODE: 'update' }, 800), { cwd: dir, deadlineMs: 30_000 }),
    );
    expect(error.step).toBe('ready');
    expect(error.screenTail).toContain('Press Enter to update now.');
    expect(writes).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it('stops at the overall deadline', async () => {
    const started = Date.now();
    const error = await pickerError(
      readPicker(client, script({ FAKE_PICKER_MODE: 'update' }, 10_000), { cwd: dir, deadlineMs: 600 }),
    );
    expect(error.step).toBe('ready');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await sessions()).toEqual([]);
  });

  it('fails at the group step without pressing Enter when Down does not move the cursor', async () => {
    const error = await pickerError(
      readPicker(client, script({ FAKE_PICKER_MODE: 'stuck' }, 800), { cwd: dir, deadlineMs: 30_000 }),
    );
    expect(error.step).toBe('group');
    expect(error.screenTail).toContain('Select model');
    expect(writes).toEqual(['/model', '\r', DOWN]);
    expect(fakeLog()).toBe('');
    expect(await sessions()).toEqual([]);
  });

  it('fails at the group step without pressing Enter when the cursor never reaches the group', async () => {
    const error = await pickerError(
      readPicker(client, script({ FAKE_PICKER_MODE: 'skip' }), { cwd: dir, deadlineMs: 60_000 }),
    );
    expect(error.step).toBe('group');
    expect(writes.slice(0, 2)).toEqual(['/model', '\r']);
    expect(writes.slice(2)).toEqual(Array(40).fill(DOWN));
    expect(fakeLog()).toBe('');
    expect(await sessions()).toEqual([]);
  }, 30_000);
});

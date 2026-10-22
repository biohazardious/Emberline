import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  checkPush,
  MAX_COMMAND_LIST_BYTES,
  parseCommandList,
  PUSH_PROBE,
  readPushCommands,
  readPushRequest,
} from './receive-pack.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const list = (...lines: string[]) => Buffer.from(`${lines.map(pkt).join('')}0000PACK....`, 'latin1');
const plan = { ref: 'refs/heads/emberline/run-1', newOid: B, oldOid: A };

describe('the receive-pack command list', () => {
  it('one update of the planned ref to the planned commit passes, and the body is forwarded unchanged', async () => {
    const body = list(`${A} ${B} refs/heads/emberline/run-1\0 report-status side-band-64k agent=git/2\n`);
    expect(parseCommandList(body)).toEqual({
      commands: [{ oldOid: A, newOid: B, ref: 'refs/heads/emberline/run-1' }],
      length: body.indexOf('PACK'),
    });
    const out = await readPushCommands(Readable.from([body.subarray(0, 10), body.subarray(10)]), plan);
    const chunks: Buffer[] = [];
    for await (const chunk of out) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it.each([
    [
      'another ref',
      [`${A} ${B} refs/heads/main\0 report-status\n`],
      /may update only refs\/heads\/emberline\/run-1/,
    ],
    [
      'an extra ref',
      [`${A} ${B} refs/heads/emberline/run-1\0 report-status\n`, `${A} ${B} refs/heads/main\n`],
      /may update only/,
    ],
    ['a delete', [`${A} ${Z} refs/heads/emberline/run-1\0 report-status\n`], /Deleting a branch/],
    [
      'another commit',
      [`${A} ${A} refs/heads/emberline/run-1\0 report-status\n`],
      /only to the commit Emberline planned/,
    ],
    ['a tag', [`${Z} ${B} refs/tags/v1\0 report-status\n`], /may update only/],
    [
      'a shallow line',
      [`shallow ${A}`, `${A} ${B} refs/heads/emberline/run-1\0 report-status\n`],
      /Only branch updates/,
    ],
    ['a signed push', [`push-cert\0 report-status\n`], /Only branch updates/],
    ['nothing', [], /may update only/],
  ])('%s is refused', async (_name, lines, message) => {
    await expect(readPushCommands(Readable.from([list(...lines)]), plan)).rejects.toMatchObject({
      code: 'ref_refused',
      message: expect.stringMatching(message),
    });
  });

  it('an unfinished list waits, a malformed or endless one is refused', async () => {
    expect(
      parseCommandList(Buffer.from(pkt(`${A} ${B} refs/heads/x\0 caps\n`).slice(0, 20), 'latin1')),
    ).toBeNull();
    expect(() => parseCommandList(Buffer.from('zzzz', 'latin1'))).toThrow(/not a git command list/);
    await expect(
      readPushCommands(Readable.from([Buffer.from(pkt(`${A} ${B} refs/heads/x\0 caps\n`), 'latin1')]), plan),
    ).rejects.toMatchObject({ code: 'ref_refused' });
    const endless = Buffer.from(
      pkt(`${A} ${B} refs/heads/emberline/run-1\0 ${'x'.repeat(60_000)}\n`).repeat(3),
      'latin1',
    );
    expect(endless.length).toBeGreaterThan(MAX_COMMAND_LIST_BYTES);
    await expect(readPushCommands(Readable.from([endless]), plan)).rejects.toMatchObject({
      code: 'ref_refused',
    });
    expect(() => checkPush([], plan)).toThrow();
  });

  it("a lone flush is git's auth probe before a large push: recognised, never a push", async () => {
    expect(
      await readPushRequest(Readable.from([Buffer.from('00', 'latin1'), Buffer.from('00', 'latin1')]), plan),
    ).toBe(PUSH_PROBE);
    await expect(
      readPushCommands(Readable.from([Buffer.from('0000', 'latin1')]), plan),
    ).rejects.toMatchObject({ code: 'ref_refused' });
    // A flush with anything after it is no probe.
    await expect(
      readPushRequest(Readable.from([Buffer.from('0000', 'latin1'), Buffer.from('PACK', 'latin1')]), plan),
    ).rejects.toMatchObject({
      code: 'ref_refused',
    });
    const body = list(`${A} ${B} refs/heads/emberline/run-1\0 report-status\n`);
    expect(await readPushRequest(Readable.from([body]), plan)).not.toBe(PUSH_PROBE);
  });

  it("only git's own capabilities pass: push options (forge hooks act on them) and unknown ones are refused", async () => {
    const first = (caps: string) => list(`${A} ${B} refs/heads/emberline/run-1\0 ${caps}\n`);
    await expect(
      readPushCommands(Readable.from([first('report-status push-options agent=git/2')]), plan),
    ).rejects.toMatchObject({
      code: 'ref_refused',
      message: 'Push options are not passed on to the forge through Emberline.',
    });
    await expect(
      readPushCommands(Readable.from([first('report-status x-evil')]), plan),
    ).rejects.toMatchObject({
      code: 'ref_refused',
      message: expect.stringMatching(/capability Emberline does not pass on \(x-evil\)/),
    });
    const real = first(
      'report-status-v2 side-band-64k quiet atomic object-format=sha1 agent=git/2.47.1 session-id=abc',
    );
    await expect(readPushCommands(Readable.from([real]), plan)).resolves.toBeDefined();
  });

  it('a command list longer than 64 KB without a flush is refused', async () => {
    const long = Buffer.from(pkt(`${A} ${B} refs/heads/emberline/run-1\n`).repeat(1_000), 'latin1');
    expect(long.length).toBeGreaterThan(MAX_COMMAND_LIST_BYTES);
    await expect(readPushCommands(Readable.from([long]), plan)).rejects.toMatchObject({
      code: 'ref_refused',
      message: 'The push request has no command list Emberline can read.',
    });
  });

  it('the old value is bound too: only from the commit Emberline checked, or only a create for a new branch', async () => {
    // Fast-forward from the checked commit passes; any other old value (a force over other commits) does not.
    expect(() => checkPush([{ oldOid: A, newOid: B, ref: plan.ref }], plan)).not.toThrow();
    const C = 'c'.repeat(40);
    await expect(
      readPushCommands(Readable.from([list(`${C} ${B} refs/heads/emberline/run-1\0 report-status\n`)]), plan),
    ).rejects.toMatchObject({
      code: 'ref_refused',
      message:
        'This push may update refs/heads/emberline/run-1 only from the commit Emberline checked (aaaaaaaaaaaa).',
    });
    await expect(
      readPushCommands(Readable.from([list(`${Z} ${B} refs/heads/emberline/run-1\0 report-status\n`)]), plan),
    ).rejects.toMatchObject({
      code: 'ref_refused',
    });
    // A new branch: the plan's old value is the zero id, and only a create passes.
    const create = { ...plan, oldOid: Z };
    expect(() => checkPush([{ oldOid: Z, newOid: B, ref: plan.ref }], create)).not.toThrow();
    expect(() => checkPush([{ oldOid: A, newOid: B, ref: plan.ref }], create)).toThrow(
      'This push may only create refs/heads/emberline/run-1; the forge already has it.',
    );
  });

  it('a stop signal ends the wait for a command list', async () => {
    const stop = new AbortController();
    const source = new Readable({ read() {} });
    source.push(
      Buffer.from(pkt(`${A} ${B} refs/heads/emberline/run-1\0 report-status\n`).slice(0, 30), 'latin1'),
    );
    const reading = readPushRequest(source, plan, stop.signal);
    stop.abort();
    await expect(reading).rejects.toMatchObject({
      code: 'ref_refused',
      message: 'The push request did not send its command list in time.',
    });
  });
});

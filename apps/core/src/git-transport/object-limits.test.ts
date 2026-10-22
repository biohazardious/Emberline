import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OBJECT_LIMITS,
  MAX_INFLATED_BYTES,
  MAX_OBJECT_BYTES,
  ObjectBudget,
} from './object-limits.js';

const KB = 1024;
const MB = 1024 * KB;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'objlimits-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const loose = (header: string, content: Buffer) =>
  deflateSync(Buffer.concat([Buffer.from(`${header}\0`), content]));

/** One pack entry: git's type/size header, then (for deltas) the base reference, then zlib data. */
function entry(type: number, size: number, data: Buffer, ref?: Buffer): Buffer {
  const head: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    head.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  head.push(byte);
  return Buffer.concat([Buffer.from(head), ref ?? Buffer.alloc(0), deflateSync(data)]);
}
/** git's OFS_DELTA distance encoding. */
function ofs(distance: number): Buffer {
  const out = [distance & 0x7f];
  let n = distance >>> 7;
  while (n > 0) {
    n -= 1;
    out.unshift(0x80 | (n & 0x7f));
    n >>>= 7;
  }
  return Buffer.from(out);
}
const varint = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
function packOf(entries: Buffer[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
/** A base blob and an OFS_DELTA on it with the given delta bytes. */
function deltaPack(delta: Buffer): Buffer {
  const base = entry(3, 3, Buffer.from('abc'));
  return packOf([base, entry(6, delta.length, delta, ofs(base.length))]);
}

describe('limits', () => {
  it('are 64 MB per object and 1 GB per operation', () => {
    expect(MAX_OBJECT_BYTES).toBe(64 * MB);
    expect(MAX_INFLATED_BYTES).toBe(1024 * MB);
    expect(DEFAULT_OBJECT_LIMITS).toMatchObject({ maxObjectBytes: 64 * MB, maxInflatedBytes: 1024 * MB });
  });
});

describe('loose objects', () => {
  it('passes a normal object and counts it', async () => {
    const budget = new ObjectBudget('push');
    await budget.checkLoose(loose('blob 5', Buffer.from('hello')));
    expect(budget.inflated).toBe(5);
  });

  it('refuses from the header alone when the object is larger than the limit', async () => {
    const budget = new ObjectBudget('push', { maxObjectBytes: MB });
    // The content does not matter: the header decides before anything is inflated in full.
    await expect(budget.checkLoose(loose(`blob ${2 * MB}`, Buffer.from('x')))).rejects.toMatchObject({
      code: 'too_large',
      message: 'A file in this push is larger than 1 MB. Push it from a terminal instead.',
    });
  });

  it('a header that understates the content is refused after at most its own size', async () => {
    const budget = new ObjectBudget('fetch', { maxObjectBytes: MB });
    await expect(budget.checkLoose(loose('blob 10', Buffer.alloc(512 * KB)))).rejects.toMatchObject({
      code: 'protocol',
    });
    await expect(budget.checkLoose(deflateSync(Buffer.from('no header at all')))).rejects.toMatchObject({
      code: 'protocol',
    });
  });

  it('caps the total of one operation', async () => {
    const budget = new ObjectBudget('fetch', { maxInflatedBytes: MB });
    await budget.checkLoose(loose(`blob ${600 * KB}`, Buffer.alloc(600 * KB)));
    await expect(
      budget.checkLoose(loose(`blob ${600 * KB}`, Buffer.alloc(600 * KB, 1))),
    ).rejects.toMatchObject({
      code: 'too_large',
      message: 'This fetch needs more than 1 MB of git objects in memory. Fetch it from a terminal instead.',
    });
  });
});

describe('packs', () => {
  /** A real pack from git with deltas (similar files), as sent by a server or kept in a repository. */
  function gitPack(): { pack: Buffer; idx: Buffer } {
    const repo = path.join(dir, 'r');
    execFileSync('git', ['init', '-q', repo]);
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join('');
    for (const [i, variant] of ['', 'changed\n', 'changed again\n'].entries()) {
      writeFileSync(path.join(repo, 'f.txt'), `${variant}${text}`);
      execFileSync('git', ['-C', repo, 'add', 'f.txt']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e',
        'commit',
        '-q',
        '-m',
        `c${i}`,
      ]);
    }
    execFileSync('git', ['-C', repo, 'repack', '-adq']);
    const packDir = path.join(repo, '.git', 'objects', 'pack');
    const name = readdirSync(packDir).find((f) => f.endsWith('.pack'))!;
    return {
      pack: readFileSync(path.join(packDir, name)),
      idx: readFileSync(path.join(packDir, name.replace(/pack$/, 'idx'))),
    };
  }

  it("git's own packs pass, received and stored", async () => {
    const { pack, idx } = gitPack();
    const received = new ObjectBudget('fetch');
    await received.checkReceivedPack(pack);
    expect(received.inflated).toBeGreaterThan(3 * 4000 * 8);
    const stored = new ObjectBudget('push');
    await stored.checkStoredPack(pack, idx);
    expect(stored.inflated).toBe(received.inflated);
  });

  it('an object over the limit is refused, received or stored', async () => {
    const { pack, idx } = gitPack();
    await expect(
      new ObjectBudget('fetch', { maxObjectBytes: 1000 }).checkReceivedPack(pack),
    ).rejects.toMatchObject({
      code: 'too_large',
      message: 'A file in this fetch is larger than 1000 bytes. Fetch it from a terminal instead.',
    });
    await expect(
      new ObjectBudget('push', { maxObjectBytes: 1000 }).checkStoredPack(pack, idx),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(
      new ObjectBudget('clone', { maxInflatedBytes: 1000 }).checkReceivedPack(pack),
    ).rejects.toMatchObject({
      code: 'too_large',
      message:
        'This clone needs more than 1000 bytes of git objects in memory. Clone it from a terminal instead.',
    });
  });

  it('an entry whose header understates its data is refused', async () => {
    const pack = packOf([entry(3, 10, Buffer.alloc(100 * KB))]);
    await expect(new ObjectBudget('fetch').checkReceivedPack(pack)).rejects.toMatchObject({
      code: 'protocol',
    });
  });

  it('a delta whose result is over the limit is refused before it is applied', async () => {
    // Source size 3, result size 2 MB: one copy op of 64 KB repeated would build it.
    const delta = Buffer.concat([varint(3), varint(2 * MB), Buffer.alloc(32, 0x80)]);
    await expect(
      new ObjectBudget('fetch', { maxObjectBytes: MB }).checkReceivedPack(deltaPack(delta)),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('a delta that builds more than it says, reads past its base, or uses opcode 0 is refused', async () => {
    const say = (target: number, ops: number[]) =>
      deltaPack(Buffer.concat([varint(3), varint(target), Buffer.from(ops)]));
    // 0x80: copy 64 KB from offset 0 of a 3-byte base.
    for (const pack of [say(3, [0x90, 3, 0x90, 3]), say(70000, [0x80]), say(1, [0x00, 0x01, 0x61])]) {
      await expect(new ObjectBudget('fetch').checkReceivedPack(pack)).rejects.toMatchObject({
        code: 'protocol',
      });
    }
    // Copy the 3 base bytes (0x90 = copy with one size byte): fine.
    await new ObjectBudget('fetch').checkReceivedPack(say(3, [0x90, 3]));
  });

  it('a delta with more steps than the limit is refused', async () => {
    const delta = Buffer.concat([
      varint(3),
      varint(5),
      Buffer.from([1, 0x61, 1, 0x62, 1, 0x63, 1, 0x64, 1, 0x65]),
    ]);
    await expect(
      new ObjectBudget('push', { maxDeltaOps: 4 }).checkReceivedPack(deltaPack(delta)),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    await new ObjectBudget('push', { maxDeltaOps: 5 }).checkReceivedPack(deltaPack(delta));
  });

  it('a delta base outside the pack is refused', async () => {
    const pack = packOf([
      entry(6, 4, Buffer.concat([varint(3), varint(1), Buffer.from([1, 0x61])]), ofs(5000)),
    ]);
    await expect(new ObjectBudget('fetch').checkReceivedPack(pack)).rejects.toMatchObject({
      code: 'protocol',
    });
  });
});

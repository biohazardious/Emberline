/**
 * Bounds on what isomorphic-git inflates in core. It inflates every object whole and synchronously
 * (pako), checks sizes only afterwards, and builds delta results from their op lists, so a few-MB
 * loose object or pack entry could otherwise take core to gigabytes and stall its event loop.
 * Before isomorphic-git sees any object, Emberline checks it here with Node's zlib, never producing
 * more than the object's own declared size (+1 byte):
 * - a loose object: its `<type> <size>` header first (from a short prefix), then a bounded inflate
 *   that must give exactly that size;
 * - a pack (received from a server, or one of the repository's that isomorphic-git loads): every
 *   entry it can reach (each entry in order for a received pack; every offset its index names for a
 *   stored one; every OFS_DELTA base), bounded the same way; a delta's op list is walked so that it
 *   builds exactly its declared result, reads only inside its base and has at most MAX_DELTA_OPS steps.
 * Each object and delta result is at most MAX_OBJECT_BYTES, and the results of one operation add up
 * to at most MAX_INFLATED_BYTES. Large inflates run on the thread pool; small ones yield regularly.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { GitTransportError } from './http.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** One object (file, tree, commit, tag) or delta result. */
export const MAX_OBJECT_BYTES = 64 * MB;
/** Everything one push, fetch or clone unpacks. */
export const MAX_INFLATED_BYTES = 1 * GB;
/** isomorphic-git keeps one small buffer per delta step until the result is built. */
export const MAX_DELTA_OPS = 2_000_000;

export interface ObjectLimits {
  maxObjectBytes: number;
  maxInflatedBytes: number;
  maxDeltaOps: number;
}

export const DEFAULT_OBJECT_LIMITS: ObjectLimits = {
  maxObjectBytes: MAX_OBJECT_BYTES,
  maxInflatedBytes: MAX_INFLATED_BYTES,
  maxDeltaOps: MAX_DELTA_OPS,
};

export type ObjectOperation = 'push' | 'fetch' | 'clone';

/** Inflates up to this size on the event loop; larger ones go to the thread pool. */
const SYNC_INFLATE_BYTES = MB;
const YIELD_AFTER_MS = 15;
const MAX_DELTA_DEPTH = 4096;
/** Compressed bytes inflated to read a loose object's header (at most ~1000x as many come out). */
const HEADER_PREFIX_BYTES = 512;

type Inflated = { buffer: Buffer; engine: { bytesWritten: number } };
const inflateAsync = promisify(zlib.inflate) as unknown as (
  data: Buffer,
  options: zlib.ZlibOptions,
) => Promise<Inflated>;

function sizeText(n: number): string {
  if (n >= GB && n % GB === 0) return `${n / GB} GB`;
  if (n >= MB && n % MB === 0) return `${n / MB} MB`;
  if (n >= KB && n % KB === 0) return `${n / KB} KB`;
  return `${n} bytes`;
}

const VERB: Record<ObjectOperation, string> = { push: 'Push', fetch: 'Fetch', clone: 'Clone' };
const SUBJECT: Record<ObjectOperation, string> = {
  push: 'this push',
  fetch: 'this fetch',
  clone: 'this repository',
};

export class ObjectBudget {
  /** Bytes of objects (and delta results) this operation unpacks. */
  inflated = 0;
  private readonly limits: ObjectLimits;
  private lastYield = Date.now();

  constructor(
    readonly operation: ObjectOperation,
    limits: Partial<ObjectLimits> = {},
  ) {
    this.limits = { ...DEFAULT_OBJECT_LIMITS, ...limits };
  }

  /** A loose object (`objects/xx/…`, zlib of `<type> <size>\0<content>`). `count: false` for a re-read. */
  async checkLoose(deflated: Buffer, options: { count?: boolean } = {}): Promise<void> {
    let prefix: Buffer;
    try {
      prefix = zlib.inflateSync(deflated.subarray(0, HEADER_PREFIX_BYTES), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
    } catch {
      throw this.damaged('not a valid zlib stream');
    }
    const nul = prefix.indexOf(0);
    const header =
      nul > 0 && nul <= 32
        ? /^(?:blob|tree|commit|tag) (0|[1-9]\d{0,15})$/.exec(prefix.toString('latin1', 0, nul))
        : null;
    if (!header) throw this.damaged('no object header');
    const declared = Number(header[1]);
    this.assertObjectSize(declared);
    await this.inflateExactly(deflated, nul + 1 + declared);
    if (options.count !== false) this.count(declared);
  }

  /** A pack a server sent: every entry, in order, before isomorphic-git indexes it. */
  async checkReceivedPack(pack: Buffer): Promise<void> {
    const count = this.packHeader(pack);
    const memo = new Map<number, PackEntry>();
    let at = 12;
    for (let i = 0; i < count; i++) at = (await this.scanAt(pack, at, memo, 0)).end;
    if (at !== pack.length - 20) throw this.damaged('data after its last object');
  }

  /** One of the repository's packs: every object its index names, and their delta bases. */
  async checkStoredPack(pack: Buffer, idx: Buffer): Promise<void> {
    this.packHeader(pack);
    const memo = new Map<number, PackEntry>();
    for (const offset of this.indexOffsets(idx)) await this.scanAt(pack, offset, memo, 0);
  }

  private packHeader(pack: Buffer): number {
    if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw this.damaged('not a git pack');
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw this.damaged(`pack version ${version}`);
    return pack.readUInt32BE(8);
  }

  /** Pack index v2: the offset of every object. */
  private indexOffsets(idx: Buffer): number[] {
    if (idx.length < 8 + 1024 + 40 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
      throw this.damaged('a pack index Emberline cannot read');
    }
    const n = idx.readUInt32BE(8 + 255 * 4);
    const table = 8 + 1024 + n * 24;
    const large = table + n * 4;
    if (idx.length < large + 40) throw this.damaged('a truncated pack index');
    const offsets: number[] = [];
    for (let i = 0; i < n; i++) {
      const small = idx.readUInt32BE(table + i * 4);
      if (small < 0x80000000) {
        offsets.push(small);
        continue;
      }
      const at = large + (small & 0x7fffffff) * 8;
      if (at + 8 > idx.length - 40) throw this.damaged('a truncated pack index');
      offsets.push(Number(idx.readBigUInt64BE(at)));
    }
    return offsets;
  }

  private async scanAt(
    pack: Buffer,
    at: number,
    memo: Map<number, PackEntry>,
    depth: number,
  ): Promise<PackEntry> {
    const known = memo.get(at);
    if (known) return known;
    if (depth > MAX_DELTA_DEPTH) throw this.damaged(`a delta chain deeper than ${MAX_DELTA_DEPTH}`);
    const limit = pack.length - 20;
    if (!Number.isSafeInteger(at) || at < 12 || at >= limit) throw this.damaged('an object outside the pack');
    let pos = at;
    let byte = pack[pos++]!;
    const type = (byte >> 4) & 7;
    let declared = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= limit || shift > 46) throw this.damaged('a broken object header');
      byte = pack[pos++]!;
      declared += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (![1, 2, 3, 4, 6, 7].includes(type)) throw this.damaged(`object type ${type}`);
    this.assertObjectSize(declared);
    let baseSize: number | null = null;
    if (type === 6) {
      byte = pack[pos++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        if (pos >= limit || distance > 2 ** 40) throw this.damaged('a broken delta base offset');
        byte = pack[pos++]!;
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      const base = at - distance;
      if (base < 12 || base >= at) throw this.damaged('a delta base outside the pack');
      baseSize = (await this.scanAt(pack, base, memo, depth + 1)).size;
    } else if (type === 7) {
      pos += 20; // the base's object id: in this pack or in the repository, both checked
    }
    if (pos >= limit) throw this.damaged('a truncated object');
    const { bytes, consumed } = await this.inflateExactly(pack.subarray(pos, limit), declared);
    const size = type >= 6 ? this.checkDelta(bytes, baseSize) : declared;
    const entry = { size, end: pos + consumed };
    memo.set(at, entry);
    this.count(size);
    return entry;
  }

  /** The size of what a delta builds; it must build exactly that, from inside its base, in few enough steps. */
  private checkDelta(delta: Buffer, baseSize: number | null): number {
    let pos = 0;
    const readSize = () => {
      let n = 0;
      let shift = 0;
      let b: number;
      do {
        if (pos >= delta.length || shift > 46) throw this.damaged('a broken delta header');
        b = delta[pos++]!;
        n += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      return n;
    };
    const source = readSize();
    const target = readSize();
    if (baseSize !== null && source !== baseSize) throw this.damaged('a delta for a base of another size');
    this.assertObjectSize(target);
    let built = 0;
    let ops = 0;
    while (pos < delta.length) {
      if (++ops > this.limits.maxDeltaOps) {
        throw new GitTransportError(
          'too_large',
          `A file in ${SUBJECT[this.operation]} is stored as a delta of more than ${this.limits.maxDeltaOps} steps. ${VERB[this.operation]} it from a terminal instead.`,
        );
      }
      const op = delta[pos++]!;
      if (op & 0x80) {
        let offset = 0;
        let length = 0;
        for (let i = 0; i < 4; i++) {
          if (!(op & (1 << i))) continue;
          if (pos >= delta.length) throw this.damaged('a truncated delta');
          offset += delta[pos++]! * 2 ** (8 * i);
        }
        for (let i = 0; i < 3; i++) {
          if (!(op & (0x10 << i))) continue;
          if (pos >= delta.length) throw this.damaged('a truncated delta');
          length += delta[pos++]! * 2 ** (8 * i);
        }
        if (length === 0) length = 0x10000;
        if (offset + length > source) throw this.damaged('a delta that reads past its base');
        built += length;
      } else if (op === 0) {
        throw this.damaged('delta opcode 0');
      } else {
        if (pos + op > delta.length) throw this.damaged('a truncated delta');
        pos += op;
        built += op;
      }
      if (built > target) throw this.damaged('a delta that builds more than it says');
    }
    if (built !== target) throw this.damaged('a delta that builds less than it says');
    return target;
  }

  /** Inflates the zlib stream at the start of `data` to exactly `expected` bytes, never producing more than one extra. */
  private async inflateExactly(data: Buffer, expected: number): Promise<{ bytes: Buffer; consumed: number }> {
    const options = { maxOutputLength: expected + 1, info: true } as zlib.ZlibOptions;
    let result: Inflated;
    try {
      result =
        expected <= SYNC_INFLATE_BYTES
          ? (zlib.inflateSync(data, options) as unknown as Inflated)
          : await inflateAsync(data, options);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw this.damaged('more data than its header says');
      throw this.damaged('not a valid zlib stream');
    }
    if (result.buffer.length !== expected) {
      throw this.damaged(`${result.buffer.length} bytes where its header says ${expected}`);
    }
    if (Date.now() - this.lastYield > YIELD_AFTER_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      this.lastYield = Date.now();
    }
    return { bytes: result.buffer, consumed: result.engine.bytesWritten };
  }

  private assertObjectSize(n: number): void {
    if (n > this.limits.maxObjectBytes) {
      throw new GitTransportError(
        'too_large',
        `A file in ${SUBJECT[this.operation]} is larger than ${sizeText(this.limits.maxObjectBytes)}. ${VERB[this.operation]} it from a terminal instead.`,
      );
    }
  }

  private count(n: number): void {
    this.inflated += n;
    if (this.inflated > this.limits.maxInflatedBytes) {
      throw new GitTransportError(
        'too_large',
        `This ${this.operation} needs more than ${sizeText(this.limits.maxInflatedBytes)} of git objects in memory. ${VERB[this.operation]} it from a terminal instead.`,
      );
    }
  }

  private damaged(detail: string): GitTransportError {
    return new GitTransportError(
      'protocol',
      `A git object in ${SUBJECT[this.operation]} is damaged (${detail}); Emberline stops there.`,
    );
  }
}

interface PackEntry {
  /** What the entry unpacks to (a delta: its result). */
  size: number;
  /** Where its compressed data ends. */
  end: number;
}

/**
 * Length-prefixed JSON framing: [uint32 BE byte length][UTF-8 JSON].
 */

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameError extends Error {
  override name = 'FrameError';
}

export function encodeFrame(message: unknown, maxBytes = MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) throw new FrameError(`frame of ${body.length} bytes exceeds ${maxBytes}`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder; feed it raw socket chunks, get back complete messages. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  /** @throws {FrameError} on oversized frames or invalid JSON; the connection should be dropped. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maxBytes) throw new FrameError(`frame of ${length} bytes exceeds ${this.maxBytes}`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body.toString('utf8')));
      } catch (error) {
        throw new FrameError(`invalid JSON frame: ${(error as Error).message}`);
      }
    }
    return messages;
  }
}

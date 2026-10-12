import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameError } from './framing.js';

describe('framing', () => {
  it('round-trips a message', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame({ hello: 'wörld' }))).toEqual([{ hello: 'wörld' }]);
  });

  it('handles frames split across chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ n: 1 });
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, 7))).toEqual([]);
    expect(decoder.push(frame.subarray(7))).toEqual([{ n: 1 }]);
  });

  it('handles multiple frames in one chunk', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([encodeFrame(1), encodeFrame('two'), encodeFrame([3])]);
    expect(decoder.push(chunk)).toEqual([1, 'two', [3]]);
  });

  it('rejects oversized frames', () => {
    const decoder = new FrameDecoder(8);
    expect(() => decoder.push(encodeFrame('a very long string'))).toThrow(FrameError);
    expect(() => encodeFrame('a very long string', 8)).toThrow(FrameError);
  });

  it('rejects invalid JSON', () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from('{nope', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    expect(() => decoder.push(Buffer.concat([header, body]))).toThrow(FrameError);
  });
});

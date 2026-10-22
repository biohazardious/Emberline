import { describe, expect, it, vi } from 'vitest';
import { sendBounded } from './routes/ws-send.js';

const fake = (bufferedAmount: number, readyState = 1) => ({
  OPEN: 1,
  readyState,
  bufferedAmount,
  send: vi.fn(),
  close: vi.fn(),
});

describe('sendBounded', () => {
  it('sends while the backlog is under the cap', () => {
    const s = fake(10);
    expect(sendBounded(s as never, { a: 1 }, 100)).toBe(true);
    expect(s.send).toHaveBeenCalledWith('{"a":1}');
    expect(s.close).not.toHaveBeenCalled();
  });

  it('closes a socket whose backlog is over the cap instead of sending', () => {
    const s = fake(101);
    expect(sendBounded(s as never, { a: 1 }, 100)).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('ignores sockets that are not open', () => {
    const s = fake(0, 3);
    expect(sendBounded(s as never, {}, 100)).toBe(false);
    expect(s.close).not.toHaveBeenCalled();
  });
});

describe('attachTerminal pre-ready buffers', () => {
  it('closes the socket when output piles up before the snapshot is sent', async () => {
    const { EventEmitter } = await import('node:events');
    const { attachTerminal } = await import('./routes/terminals.js');
    const viewer = Object.assign(new EventEmitter(), {
      attach: () => new Promise(() => undefined),
      close: vi.fn(),
    });
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    });
    attachTerminal(socket as never, 's1', { openViewer: async () => viewer } as never, () => undefined);
    await new Promise((r) => setTimeout(r, 10));

    viewer.emit('output', 's1', 'x'.repeat(600 * 1024));
    expect(socket.close).not.toHaveBeenCalled();
    viewer.emit('output', 's1', 'x'.repeat(600 * 1024));
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('closes the socket when input piles up before the snapshot is sent', async () => {
    const { EventEmitter } = await import('node:events');
    const { attachTerminal } = await import('./routes/terminals.js');
    const viewer = Object.assign(new EventEmitter(), {
      attach: () => new Promise(() => undefined),
      close: vi.fn(),
    });
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    });
    attachTerminal(socket as never, 's1', { openViewer: async () => viewer } as never, () => undefined);
    const input = JSON.stringify({ type: 'input', data: 'y'.repeat(60 * 1024) });
    for (let i = 0; i < 10; i++) socket.emit('message', input);
    expect(socket.close).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) socket.emit('message', input);
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
  });
});

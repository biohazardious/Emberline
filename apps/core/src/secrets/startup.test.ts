import { describe, expect, it, vi } from 'vitest';
import { SecretsKeyError } from './box.js';
import { exitOnSecretsKeyError } from './startup.js';

const io = () => {
  const calls: string[] = [];
  return {
    calls,
    write: vi.fn((text: string) => void calls.push(`write:${text}`)),
    closeDb: vi.fn(() => void calls.push('closeDb')),
    exit: vi.fn((code: number) => void calls.push(`exit:${code}`)),
  };
};

describe('exitOnSecretsKeyError', () => {
  it('writes the message and the detail, closes the database, then exits 1', () => {
    const o = io();
    const error = new SecretsKeyError('settings notifications.config could not be decrypted', {
      keyLost: true,
    });
    exitOnSecretsKeyError(error, o);
    expect(o.calls).toEqual([
      `write:${error.message}\nsettings notifications.config could not be decrypted\n`,
      'closeDb',
      'exit:1',
    ]);
    expect(error.message).toContain('EMBERLINE_FORGET_SECRETS');
  });

  it('rethrows any other error without writing, closing or exiting', () => {
    const o = io();
    const boom = new Error('disk full');
    expect(() => exitOnSecretsKeyError(boom, o)).toThrow(boom);
    expect(o.calls).toEqual([]);
  });
});

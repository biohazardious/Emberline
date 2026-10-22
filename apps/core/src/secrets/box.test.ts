import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSealed, openSecret, openWith, sealSecret, sealWith, SEALED_PREFIX } from './box.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
describe('secret box', () => {
  it('round-trips and never repeats a nonce', () => {
    const a = sealWith(k1, 'sk-ant-1');
    const b = sealWith(k1, 'sk-ant-1');
    expect(a.startsWith(SEALED_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(openWith(k1, a)).toBe('sk-ant-1');
  });
  it('refuses another key and a changed byte', () => {
    const a = sealWith(k1, 'x');
    expect(() => openWith(k2, a)).toThrow();
    const raw = Buffer.from(a.slice(SEALED_PREFIX.length), 'base64url');
    raw[20] = raw[20]! ^ 1;
    expect(() => openWith(k1, SEALED_PREFIX + raw.toString('base64url'))).toThrow();
  });
  it('passes plaintext through on read and never seals twice', () => {
    expect(openSecret('plain')).toBe('plain');
    const sealed = sealSecret('t');
    expect(isSealed(sealed)).toBe(true);
    expect(sealSecret(sealed)).toBe(sealed);
  });
  it('seals text that only looks sealed, so it reads back as typed', () => {
    const typed = `${SEALED_PREFIX}pasted-by-hand`;
    const stored = sealSecret(typed);
    expect(stored).not.toBe(typed);
    expect(openSecret(stored)).toBe(typed);
  });
  it('refuses a truncated value instead of reading it as plaintext', () => {
    expect(() => openSecret(`${SEALED_PREFIX}AAAA`)).toThrow();
    expect(() => openSecret(SEALED_PREFIX)).toThrow();
  });
});

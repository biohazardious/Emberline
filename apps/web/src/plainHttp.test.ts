import { describe, expect, it } from 'vitest';
import { isPlainHttpOnNetwork } from './plainHttp';

describe('isPlainHttpOnNetwork', () => {
  it.each([
    ['http:', '192.168.1.16', true],
    ['http:', 'truenas.local', true],
    ['https:', 'truenas.local', false],
    ['http:', 'localhost', false],
    ['http:', '127.0.0.1', false],
    ['http:', '[::1]', false],
    ['http:', '::1', false],
  ])('%s //%s -> %s', (protocol, hostname, expected) => {
    expect(isPlainHttpOnNetwork(protocol, hostname)).toBe(expected);
  });
});

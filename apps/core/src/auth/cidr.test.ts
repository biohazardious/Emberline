import { describe, expect, it } from 'vitest';
import { blockListOf, catchAllRanges, cidrParts, parseCidrList } from './cidr.js';

describe('EMBERLINE_CONTAINER_NETWORKS entries', () => {
  it('reads IPv4 and IPv6 CIDR ranges', () => {
    expect(cidrParts('100.64.0.0/10')).toEqual({ address: '100.64.0.0', prefix: 10, family: 'ipv4' });
    expect(cidrParts('2001:DB8::/32')).toEqual({ address: '2001:DB8::', prefix: 32, family: 'ipv6' });
    expect(cidrParts('0.0.0.0/0')).toEqual({ address: '0.0.0.0', prefix: 0, family: 'ipv4' });
  });

  it('refuses anything that is not a CIDR range', () => {
    for (const bad of [
      '',
      '10.0.0.0',
      '10.0.0.0/',
      '/8',
      '10.0.0.0/33',
      '2001:db8::/129',
      'fe80::1%eth0/64',
      'host/8',
      '10.0.0.0/8/9',
      '10.0.0.0 /8',
      '10.0.0.0/-1',
      '10.0.0.0/8x',
    ]) {
      expect(cidrParts(bad), bad).toBeNull();
    }
  });

  it('keeps the valid entries of a list and names the others', () => {
    expect(parseCidrList(' 100.64.0.0/10 , nope,,2001:db8::/32, 10.0.0.0/33 ')).toEqual({
      valid: ['100.64.0.0/10', '2001:db8::/32'],
      invalid: ['nope', '10.0.0.0/33'],
    });
    expect(parseCidrList('')).toEqual({ valid: [], invalid: [] });
  });

  it('builds a block list of the valid ranges only', () => {
    const list = blockListOf(['100.64.0.0/10', 'bogus', '2001:db8::/32']);
    expect(list.check('100.100.1.1', 'ipv4')).toBe(true);
    expect(list.check('100.128.0.1', 'ipv4')).toBe(false);
    expect(list.check('2001:db8:5::1', 'ipv6')).toBe(true);
  });

  it('names the ranges that take in every address (prefix 0), whatever address they are written with', () => {
    expect(
      catchAllRanges(['100.64.0.0/10', '0.0.0.0/0', '::/0', '10.1.2.3/00', '2001:DB8::/0', '0.0.0.0/1']),
    ).toEqual(['0.0.0.0/0', '::/0', '10.1.2.3/00', '2001:DB8::/0']);
    expect(catchAllRanges(['100.64.0.0/10', 'bogus/0'])).toEqual([]);
  });
});

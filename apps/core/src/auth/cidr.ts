import { BlockList, isIP } from 'node:net';

/** Address, prefix and family of a CIDR range; null when it is not one (no prefix, out of range, a zone id). */
export function cidrParts(cidr: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const m = /^([^/%\s]+)\/(\d{1,3})$/.exec(cidr);
  if (!m) return null;
  const address = m[1]!;
  const version = isIP(address);
  if (version === 0) return null;
  const prefix = Number(m[2]);
  if (prefix > (version === 4 ? 32 : 128)) return null;
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** A comma-separated CIDR list (`EMBERLINE_CONTAINER_NETWORKS`): the ranges, and the entries that are not one. */
export function parseCidrList(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(',')) {
    const cidr = entry.trim();
    if (!cidr) continue;
    (cidrParts(cidr) ? valid : invalid).push(cidr);
  }
  return { valid, invalid };
}

/** A {@link BlockList} of the CIDR ranges; entries that are not one are skipped. */
export function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parts = cidrParts(cidr);
    if (parts) list.addSubnet(parts.address, parts.prefix, parts.family);
  }
  return list;
}

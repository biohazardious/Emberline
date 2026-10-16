const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the page is served over plain HTTP from a host other than this machine. */
export function isPlainHttpOnNetwork(protocol: string, hostname: string): boolean {
  return protocol === 'http:' && !LOOPBACK.has(hostname.toLowerCase());
}

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { normalizeIp } from './sessions.js';

/** How often the container host names are resolved again (containers get new addresses on restart). */
export const CONTAINER_ADDRESSES_REFRESH_MS = 60_000;
/** A request waits at most this long for the first resolution. */
const FIRST_RESOLVE_WAIT_MS = 2_000;

export interface ContainerAddressesOptions {
  /** All addresses of a host name; throws when it does not resolve. */
  lookup?: (host: string) => Promise<string[]>;
  /** 0: no periodic refresh (tests call {@link ContainerAddresses.refresh}). */
  refreshMs?: number;
  /** Core's own networks as CIDRs (`172.18.0.2/16`); by default those of its non-loopback interfaces. */
  localNetworks?: () => string[];
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Lookup errors that mean the name is gone (its container was removed); any other keeps the last answer. */
const GONE = new Set(['ENOTFOUND', 'ENODATA']);

const PRIVATE = (() => {
  const b = new BlockList();
  b.addSubnet('10.0.0.0', 8, 'ipv4');
  b.addSubnet('172.16.0.0', 12, 'ipv4');
  b.addSubnet('192.168.0.0', 16, 'ipv4');
  b.addSubnet('fc00::', 7, 'ipv6');
  return b;
})();

const LOOPBACK = (() => {
  const b = new BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4');
  b.addAddress('::1', 'ipv6');
  return b;
})();

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** An answer that can be one of Emberline's containers: loopback, or private and on one of core's own networks. */
export function containerAnswer(ip: string, networks: BlockList): boolean {
  if (isIP(ip) === 0) return false;
  const f = family(ip);
  return LOOPBACK.check(ip, f) || (PRIVATE.check(ip, f) && networks.check(ip, f));
}

const defaultNetworks = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((i) => (i && i.cidr && !i.internal ? [i.cidr] : []));

/** A {@link BlockList} of CIDRs; malformed entries are skipped. */
function networksOf(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    const bits = Number(prefix);
    if (!address || isIP(address) === 0 || !Number.isInteger(bits)) continue;
    try {
      list.addSubnet(address, bits, family(address));
    } catch {
      // A prefix out of range for the family: not a network.
    }
  }
  return list;
}

/**
 * The addresses of Emberline's own containers (compose services `runner` and `docker`), resolved by
 * name and refreshed periodically. Only answers that can be a container next to core count: loopback,
 * or a private address on one of core's own networks, so a LAN host that happens to be called
 * `docker` or `runner` is neither trusted nor refused. A name that is gone (`ENOTFOUND`, `ENODATA`:
 * the engine was removed) drops its addresses; any other failure (`EAI_AGAIN`, a container
 * restarting) keeps the last known ones. With `network_mode: host` the LAN is core's own network,
 * and the explicit host settings (`EMBERLINE_CONTAINER_HOSTS`, `EMBERLINE_RUNNER_HOSTS`) decide.
 */
export class ContainerAddresses {
  private readonly byHost = new Map<string, Set<string>>();
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly localNetworks: () => string[];
  private readonly first: Promise<void>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly hosts: string[],
    options: ContainerAddressesOptions = {},
  ) {
    this.lookup = options.lookup ?? defaultLookup;
    this.localNetworks = options.localNetworks ?? defaultNetworks;
    const refreshMs = options.refreshMs ?? CONTAINER_ADDRESSES_REFRESH_MS;
    this.first = hosts.length > 0 && refreshMs > 0 ? this.refresh() : Promise.resolve();
    if (hosts.length > 0 && refreshMs > 0) {
      this.timer = setInterval(() => void this.refresh(), refreshMs);
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    const networks = networksOf(this.localNetworks());
    await Promise.all(
      this.hosts.map(async (host) => {
        try {
          const answers = (await this.lookup(host)).map(normalizeIp);
          this.byHost.set(host, new Set(answers.filter((ip) => containerAnswer(ip, networks))));
        } catch (error) {
          // Gone (the engine was removed): forget it. Otherwise (a container restarting, DNS slow): keep what was known.
          if (GONE.has((error as NodeJS.ErrnoException).code ?? '')) this.byHost.delete(host);
        }
      }),
    );
  }

  /** Whether `ip` is one of the containers' addresses (after the first resolution, bounded). */
  async has(ip: string | undefined): Promise<boolean> {
    if (this.hosts.length === 0 || !ip) return false;
    await Promise.race([this.first, new Promise((resolve) => setTimeout(resolve, FIRST_RESOLVE_WAIT_MS).unref())]);
    const wanted = normalizeIp(ip);
    for (const set of this.byHost.values()) if (set.has(wanted)) return true;
    return false;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

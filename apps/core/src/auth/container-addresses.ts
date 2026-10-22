import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { blockListOf } from './cidr.js';
import { normalizeIp } from './sessions.js';

/** How often the container host names are resolved again (containers get new addresses on restart). */
export const CONTAINER_ADDRESSES_REFRESH_MS = 60_000;
/** On the git gateway a miss resolves the names again at most this often (a restarted runner has a new address). */
export const MISS_REFRESH_MS = 5_000;
/** A request waits at most this long for the first resolution. */
const FIRST_RESOLVE_WAIT_MS = 2_000;

export interface ContainerAddressesOptions {
  /** All addresses of a host name; throws when it does not resolve. */
  lookup?: (host: string) => Promise<string[]>;
  /** 0: no periodic refresh (tests call {@link ContainerAddresses.refresh}). */
  refreshMs?: number;
  /** Core's own networks as CIDRs (`172.18.0.2/16`); by default those of its non-loopback interfaces. */
  localNetworks?: () => string[];
  /**
   * EMBERLINE_CONTAINER_NETWORKS: CIDR ranges that count besides the private ones (a 100.64/10 or
   * public IPv6 Docker pool). An answer must still be on one of core's own networks.
   */
  containerNetworks?: readonly string[];
  /** Clock for the gateway's miss refresh (tests). */
  now?: () => number;
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Lookup errors that mean the name has no container now (removed, or stopped or restarting: Docker's
 * DNS answers ENOTFOUND for those too); any other keeps the last answer.
 */
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

const NO_EXTRA = new BlockList();

/**
 * An answer that can be one of Emberline's containers: loopback, or private (or in `extra`, from
 * EMBERLINE_CONTAINER_NETWORKS) and on one of core's own networks.
 */
export function containerAnswer(ip: string, networks: BlockList, extra: BlockList = NO_EXTRA): boolean {
  if (isIP(ip) === 0) return false;
  const f = family(ip);
  return LOOPBACK.check(ip, f) || ((PRIVATE.check(ip, f) || extra.check(ip, f)) && networks.check(ip, f));
}

const defaultNetworks = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((i) => (i && i.cidr && !i.internal ? [i.cidr] : []));

/**
 * The addresses of Emberline's own containers (compose services `runner` and `docker`), resolved by
 * name and refreshed periodically. Only answers that can be a container next to core count: loopback,
 * or a private address on one of core's own networks, so a LAN host that happens to be called
 * `docker` or `runner` is neither trusted nor refused. A name that does not resolve (`ENOTFOUND`,
 * `ENODATA`: its container was removed, or is stopped or restarting) drops its addresses until a
 * later refresh resolves it again; any other failure (`EAI_AGAIN`, slow DNS) keeps the last known
 * ones. With `network_mode: host`, macvlan or ipvlan, the LAN is core's own network: a LAN host
 * answering to a configured name whose container does not exist (`docker` while the engine is off)
 * is then taken for that container. EMBERLINE_CONTAINER_NETWORKS widens the private ranges, never
 * core's own networks.
 */
export class ContainerAddresses {
  private readonly byHost = new Map<string, Set<string>>();
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly localNetworks: () => string[];
  private readonly first: Promise<void>;
  private timer: NodeJS.Timeout | undefined;
  private readonly extra: BlockList;
  private readonly now: () => number;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly hosts: string[],
    options: ContainerAddressesOptions = {},
  ) {
    this.lookup = options.lookup ?? defaultLookup;
    this.localNetworks = options.localNetworks ?? defaultNetworks;
    const refreshMs = options.refreshMs ?? CONTAINER_ADDRESSES_REFRESH_MS;
    this.extra = blockListOf(options.containerNetworks ?? []);
    this.now = options.now ?? Date.now;
    this.first = hosts.length > 0 && refreshMs > 0 ? this.refresh() : Promise.resolve();
    if (hosts.length > 0 && refreshMs > 0) {
      this.timer = setInterval(() => void this.refresh(), refreshMs);
      this.timer.unref();
    }
  }

  /** Core's own networks; none when they cannot be listed (a sandbox refusing it): only loopback counts then. */
  private ownNetworks(): BlockList {
    try {
      return blockListOf(this.localNetworks());
    } catch {
      return blockListOf([]);
    }
  }

  async refresh(): Promise<void> {
    this.lastRefreshAt = this.now();
    const pass = this.resolveAll();
    this.inFlight = pass;
    try {
      await pass;
    } finally {
      if (this.inFlight === pass) this.inFlight = null;
    }
  }

  private async resolveAll(): Promise<void> {
    const networks = this.ownNetworks();
    await Promise.all(
      this.hosts.map(async (host) => {
        try {
          const answers = (await this.lookup(host)).map(normalizeIp);
          this.byHost.set(host, new Set(answers.filter((ip) => containerAnswer(ip, networks, this.extra))));
        } catch (error) {
          // Not resolvable (removed, or stopped or restarting: Docker's DNS has no answer for it then): forget
          // it until it resolves again. Otherwise (EAI_AGAIN, DNS slow): keep what was known.
          if (GONE.has((error as NodeJS.ErrnoException).code ?? '')) this.byHost.delete(host);
        }
      }),
    );
  }

  /**
   * The git gateway's check. A miss may be a runner that restarted with a new address, so the names
   * are resolved again, at most once per {@link MISS_REFRESH_MS}; a miss meanwhile waits for a
   * resolution in flight. The cookie check uses {@link has}: a stranger's cookie never costs a lookup.
   */
  async hasOrRefresh(ip: string | undefined): Promise<boolean> {
    if (await this.has(ip)) return true;
    if (this.hosts.length === 0 || !ip) return false;
    if (this.now() - this.lastRefreshAt >= MISS_REFRESH_MS) await this.refresh();
    else if (this.inFlight) await this.inFlight;
    else return false;
    return this.has(ip);
  }

  /** Whether `ip` is one of the containers' addresses (after the first resolution, bounded). */
  async has(ip: string | undefined): Promise<boolean> {
    if (this.hosts.length === 0 || !ip) return false;
    await Promise.race([
      this.first,
      new Promise((resolve) => setTimeout(resolve, FIRST_RESOLVE_WAIT_MS).unref()),
    ]);
    const wanted = normalizeIp(ip);
    for (const set of this.byHost.values()) if (set.has(wanted)) return true;
    return false;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

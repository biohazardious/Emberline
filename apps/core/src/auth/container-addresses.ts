import { lookup as dnsLookup } from 'node:dns/promises';
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
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * The addresses of Emberline's own containers (compose services `runner` and `docker`), resolved by
 * name and refreshed periodically. A host that does not resolve (the Docker engine is off) adds
 * nothing; a failed refresh keeps that host's last known addresses.
 */
export class ContainerAddresses {
  private readonly byHost = new Map<string, Set<string>>();
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly first: Promise<void>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly hosts: string[],
    options: ContainerAddressesOptions = {},
  ) {
    this.lookup = options.lookup ?? defaultLookup;
    const refreshMs = options.refreshMs ?? CONTAINER_ADDRESSES_REFRESH_MS;
    this.first = hosts.length > 0 && refreshMs > 0 ? this.refresh() : Promise.resolve();
    if (hosts.length > 0 && refreshMs > 0) {
      this.timer = setInterval(() => void this.refresh(), refreshMs);
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    await Promise.all(
      this.hosts.map(async (host) => {
        try {
          this.byHost.set(host, new Set((await this.lookup(host)).map(normalizeIp)));
        } catch {
          // Not resolvable now (engine off, container restarting): keep what was known.
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

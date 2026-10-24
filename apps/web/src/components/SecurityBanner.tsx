import { useState } from 'react';
import { isPlainHttpOnNetwork } from '../plainHttp';

const DISMISSED_KEY = 'emberline.plainHttpBannerDismissed';
const SECURITY_URL = 'https://github.com/biohazardious/Emberline#security';

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Warns once per browser when Emberline is used over plain HTTP from another machine. */
export function SecurityBanner({ floating = false }: { floating?: boolean }) {
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (dismissed || !isPlainHttpOnNetwork(location.protocol, location.hostname)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // ignore storage errors
    }
  };

  return (
    <div
      className={`banner banner-warn security-banner${floating ? ' security-banner-floating' : ''}`}
      role="status"
    >
      <span>
        You are using Emberline over plain HTTP on the network. Passwords and session cookies travel
        unencrypted; use a VPN or a TLS reverse proxy.{' '}
        <a href={SECURITY_URL} target="_blank" rel="noreferrer">
          Security notes
        </a>
      </span>
      <button className="btn btn-ghost btn-sm" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

const PTRACE_URL =
  'https://github.com/biohazardious/Emberline/blob/main/SECURITY.md#the-hosts-ptrace-setting';

/**
 * Shown while the runner's host lets any process trace another of its user (Yama `ptrace_scope` 0,
 * or no Yama): agents share the runner's user with its own service. Not dismissible: it stays until
 * the host is fixed.
 */
export function RunnerTraceBanner({ unrestricted }: { unrestricted: boolean | undefined }) {
  if (!unrestricted) return null;
  return (
    <div className="banner banner-warn security-banner" role="status">
      <span>
        The Docker host lets any program trace another program of the same user, so a coding agent could take
        over the runner&apos;s own service and every command Emberline runs there. Set{' '}
        <code>kernel.yama.ptrace_scope=1</code> on the Docker host.{' '}
        <a href={PTRACE_URL} target="_blank" rel="noreferrer">
          How
        </a>
      </span>
    </div>
  );
}

/**
 * Shown while the runner image is older than core (`runnerOutdated`): core then starts no agent and
 * runs no command in the runner (fail closed) until the runner is updated.
 */
export function RunnerSecurityUpdateBanner({ outdated }: { outdated: boolean | undefined }) {
  if (!outdated) return null;
  return (
    <div className="banner banner-error security-banner" role="alert">
      <span>
        <strong>Security update required: update the runner image.</strong> Until it is updated, Emberline
        starts no agent and runs no command in the runner (git, checks, merges, previews). From source,
        run <code>make up</code>; with the published images, <code>docker compose pull &amp;&amp; docker compose up -d</code>.
        Agents that were already running keep running: you can watch and stop them.
      </span>
    </div>
  );
}

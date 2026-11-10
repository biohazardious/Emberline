import { UPGRADE_NOTES_URL } from '@emberline/protocol';
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

/**
 * Shown while the runner is current but does not say it is secured (`runnerNotSecured`): its service
 * does not run apart from the coding agents. Core then starts nothing in it.
 */
export function RunnerNotSecuredBanner({ notSecured }: { notSecured: boolean | undefined }) {
  if (!notSecured) return null;
  return (
    <div className="banner banner-error security-banner" role="alert">
      <span>
        <strong>Runner not secured.</strong> The runner&apos;s service does not run apart from the coding
        agents, so an agent could reach it, and Emberline starts no agent and runs no command in the runner.
        Restart the runner (<code>make up</code>, or <code>docker compose up -d</code>) and see why in its log
        (<code>docker compose logs runner</code>). Agents that were already running keep running: you can
        watch and stop them.
      </span>
    </div>
  );
}

/**
 * Shown while the compose file has no `ops` service (`opsMissing`), or it does not answer: core runs
 * its own commands there, and starts nothing anywhere until it answers.
 */
export function OpsMissingBanner({ missing }: { missing: boolean | undefined }) {
  if (!missing) return null;
  return (
    <div className="banner banner-error security-banner" role="alert">
      <span>
        <strong>
          Update the compose file: the <code>ops</code> service is missing.
        </strong>{' '}
        Emberline runs its own commands (git, merges, the Docker CLI) in it, and until it answers Emberline
        starts no agent and runs no command. Agents that were already running keep running: you can watch and
        stop them.{' '}
        <a href={UPGRADE_NOTES_URL} target="_blank" rel="noreferrer">
          Upgrade notes
        </a>
      </span>
    </div>
  );
}

/** Shown while core has not reached the runner for longer than a restart takes (`runnerProblem`). */
export function RunnerNotAnsweringBanner({ problem }: { problem: string | null | undefined }) {
  if (problem !== 'not_answering') return null;
  return (
    <div className="banner banner-warn" role="status">
      The runner has not answered for a while. See why with <code>docker compose logs runner</code>. A runner
      started as another user (<code>user:</code> in the compose file) stops at once, and its log says so:
      remove <code>user:</code> and start it again.
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
        starts no agent and runs no command in the runner (git, checks, merges, previews). From source, run{' '}
        <code>make up</code>; with the published images,{' '}
        <code>docker compose pull &amp;&amp; docker compose up -d</code>. Agents that were already running
        keep running: you can watch and stop them.
      </span>
    </div>
  );
}

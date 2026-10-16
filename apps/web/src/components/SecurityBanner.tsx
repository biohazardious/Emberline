import { useState } from 'react';
import { isPlainHttpOnNetwork } from '../plainHttp';

const DISMISSED_KEY = 'emberline.plainHttpBannerDismissed';
const SECURITY_URL = 'https://github.com/biohazardious/emberline#security';

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Warns once per browser when Emberline is used over plain HTTP from another machine. */
export function SecurityBanner() {
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
    <div className="banner banner-warn security-banner" role="status">
      <span>
        You are using Emberline over plain HTTP on the network. Passwords and session cookies travel unencrypted; use
        a VPN or a TLS reverse proxy.{' '}
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

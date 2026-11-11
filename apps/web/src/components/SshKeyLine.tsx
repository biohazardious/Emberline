import { type ReactNode, useState } from 'react';
import { copyText } from '../clipboard';
import { CopyFallback } from './CopyFallback';

/**
 * A public key's OpenSSH line, with Copy and any other actions beside it (New key, Delete). A copy
 * the browser blocks (plain HTTP) shows the line in a field to copy by hand.
 */
export function SshKeyLine({
  publicKey,
  copyLabel = 'Copy public key',
  children,
}: {
  publicKey: string;
  copyLabel?: string;
  /** More buttons in the same row, after Copy. */
  children?: ReactNode;
}) {
  // The line copied (or to copy by hand): a new key (New key) shows neither for the old one.
  const [copied, setCopied] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const copy = async () => {
    setCopied(null);
    const ok = await copyText(publicKey);
    setCopied(ok ? publicKey : null);
    setManual(ok ? null : publicKey);
  };
  return (
    <div className="ssh-key-line-block">
      <code className="ssh-key-line mono">{publicKey}</code>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          {copyLabel}
        </button>
        {children}
      </div>
      <p className="muted small" role="status">
        {copied === publicKey ? 'Copied.' : ''}
      </p>
      {manual === publicKey && (
        <CopyFallback text={publicKey} what="public key" onClose={() => setManual(null)} />
      )}
    </div>
  );
}

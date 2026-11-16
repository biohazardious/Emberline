import { MIN_PASSWORD_LENGTH, type SessionIssued } from '@emberline/protocol';
import { LoaderCircle, LogOut, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { PasswordField, StrengthMeter, useAuth } from '../auth';
import { changingKey, setSessionKey, signOut } from '../sessionKey';
import './settings/settings-panels.css';
import { HelpHint } from './ui/HelpHint';

/** Change the admin password; every other session (browser, device) is signed out. */
export function AccountPanel() {
  const { logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      // Auth checks that come back signed out meanwhile wait for the new key.
      await changingKey(async () => {
        const issued = await api<SessionIssued>('/api/auth/password', 'POST', {
          currentPassword: current,
          newPassword: next,
        });
        setSessionKey(issued.sessionKey);
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 403
          ? 'The current password is not correct.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut(() => api('/api/auth/logout', 'POST'));
      await logout();
      window.dispatchEvent(new Event('emberline:unauthorized'));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <section className="panel settings-panel" aria-labelledby="account-title">
      <header className="settings-panel-head">
        <div className="settings-panel-title-group">
          <div className="settings-panel-heading-row">
            <h2 id="account-title">Account</h2>
            <HelpHint topic="password rules">
              Minimum {MIN_PASSWORD_LENGTH} characters. Changing it signs out every other browser and device.
              Forgot it? Run <code>make reset-password</code> on the server.
            </HelpHint>
          </div>
          <p className="muted">Password and session.</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={signingOut || busy}
            onClick={() => void handleSignOut()}
          >
            <LogOut className="icon" aria-hidden="true" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      <form className="form account-form" onSubmit={(e) => void submit(e)}>
        {/* Single-user app: a fixed username lets password managers file the credential. */}
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <PasswordField
          id="account-current"
          label="Current password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PasswordField
          id="account-new"
          label="New password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          describedBy="account-strength"
        />
        <StrengthMeter password={next} id="account-strength" />
        <PasswordField
          id="account-confirm"
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        {mismatch && <small className="field-warn">The new passwords do not match yet.</small>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="banner banner-ok" role="status">
            <ShieldCheck className="icon" aria-hidden="true" /> Password changed. Other sessions were signed
            out.
          </p>
        )}
        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !current || mismatch || next.length < MIN_PASSWORD_LENGTH}
          >
            {busy ? (
              <>
                <LoaderCircle className="icon icon-spin" aria-hidden="true" /> Saving…
              </>
            ) : (
              'Change password'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

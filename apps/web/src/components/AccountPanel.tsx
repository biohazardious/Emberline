import { MIN_PASSWORD_LENGTH } from '@emberline/protocol';
import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { PasswordField, StrengthMeter } from '../auth';

/** Change the admin password; every other session (browser, device) is signed out. */
export function AccountPanel() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
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
      await api('/api/auth/password', 'POST', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 403 ? 'The current password is not correct.' : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="account-title">
      <header className="panel-head">
        <div>
          <h2 id="account-title">
            <KeyRound className="icon" aria-hidden /> Admin password
          </h2>
          <p className="muted">
            Changing it signs out every other browser and device. Forgot it? Run <code>make reset-password</code> on
            the server.
          </p>
        </div>
      </header>
      <form className="form" style={{ maxWidth: 420 }} onSubmit={(e) => void submit(e)}>
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
          label="Confirm new password"
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
            <ShieldCheck className="icon" aria-hidden /> Password changed. Other sessions were signed out.
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
                <LoaderCircle className="icon icon-spin" aria-hidden /> Saving…
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

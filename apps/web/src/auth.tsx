import { type AuthState, MIN_PASSWORD_LENGTH } from '@emberline/protocol';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, errorMessage } from './api';

interface AuthContextValue {
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({ logout: async () => {} });
export const useAuth = () => useContext(AuthContext);

/** Renders first-run setup, login, or the app depending on auth state. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setState(await api<AuthState>('/api/auth/state'));
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => void refresh();
    window.addEventListener('emberline:unauthorized', onUnauthorized);
    return () => window.removeEventListener('emberline:unauthorized', onUnauthorized);
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', 'POST');
    await refresh();
  }, [refresh]);

  if (error) {
    return (
      <AuthShell title="Core unreachable">
        <p className="muted">{error}</p>
        <button id="retry-auth" className="btn btn-primary" onClick={() => void refresh()}>
          Retry
        </button>
      </AuthShell>
    );
  }
  if (!state) return <div className="splash" aria-busy="true" />;
  if (state.setupRequired) return <SetupForm onDone={refresh} />;
  if (!state.authenticated) return <LoginForm onDone={refresh} />;
  return <AuthContext.Provider value={{ logout }}>{children}</AuthContext.Provider>;
}

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="glow" aria-hidden="true" />
      <section className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Emberline</span>
        </div>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function SetupForm({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await api('/api/auth/setup', 'POST', { password });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome — first-run setup">
      <div className="notice-box">
        <strong>One installation = one user = your own Claude subscription.</strong>
        <span>
          Emberline runs the official Claude Code CLI on this server with your own login. It has no account sharing
          or rotation. Emberline is not affiliated with or endorsed by Anthropic.
        </span>
      </div>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Admin password</span>
          <input
            id="setup-password"
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <small className="muted">At least {MIN_PASSWORD_LENGTH} characters.</small>
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            id="setup-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button id="setup-submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Create password & continue'}
        </button>
      </form>
    </AuthShell>
  );
}

function LoginForm({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/login', 'POST', { password });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Password</span>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button id="login-submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

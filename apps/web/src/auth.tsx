import { type AuthState, MIN_PASSWORD_LENGTH } from '@emberline/protocol';
import {
  Bot,
  Check,
  Copy,
  Eye,
  EyeOff,
  GitMerge,
  Gauge,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import { api, ApiRequestError, errorMessage } from './api';
import { BrandLogo } from './components/BrandLogo';

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
      <AuthLayout title="Can't reach Emberline" subtitle="The core service did not answer.">
        <p className="auth-error" role="alert">
          <TriangleAlert className="icon" aria-hidden /> {error}
        </p>
        <button id="retry-auth" className="btn btn-primary auth-submit" onClick={() => void refresh()}>
          <RefreshCw className="icon" aria-hidden /> Try again
        </button>
      </AuthLayout>
    );
  }
  if (!state) return <div className="splash" aria-busy="true" />;
  if (state.setupRequired) return <SetupForm onDone={refresh} />;
  if (!state.authenticated) return <LoginForm onDone={refresh} />;
  return <AuthContext.Provider value={{ logout }}>{children}</AuthContext.Provider>;
}

const FEATURES = [
  { icon: Bot, title: 'Many agents, one control room', text: 'Claude Code, Antigravity and more run side by side.' },
  { icon: GitMerge, title: 'Every change lands through git', text: 'Worktrees, reviews and merges you can follow.' },
  { icon: ShieldCheck, title: 'Agents stay in their sandbox', text: 'Workspace code runs in the runner, never in core.' },
  { icon: Gauge, title: 'Quotas under control', text: 'Usage limits, budgets and a scheduler that waits for resets.' },
];

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <aside className="auth-brand" aria-label="About Emberline">
        <div className="auth-brand-inner">
          <div className="auth-logo">
            <BrandLogo size={40} />
            <span>Emberline</span>
          </div>
          <p className="auth-tagline">The self-hosted control room for your AI coding agents.</p>
          <ul className="auth-features">
            {FEATURES.map(({ icon: Icon, title: featureTitle, text }) => (
              <li key={featureTitle}>
                <span className="auth-feature-icon">
                  <Icon className="icon" aria-hidden />
                </span>
                <span>
                  <strong>{featureTitle}</strong>
                  <span>{text}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="auth-footnote">
            Runs on your server with your own subscriptions. Not affiliated with Anthropic or Google.
          </p>
        </div>
      </aside>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-logo">
            <BrandLogo size={30} />
            <span>Emberline</span>
          </div>
          <header>
            <h1>{title}</h1>
            {subtitle && <p className="auth-subtitle">{subtitle}</p>}
          </header>
          {children}
        </div>
      </section>
    </main>
  );
}

/** Password input with a show/hide toggle and a Caps Lock warning. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  minLength,
  hint,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  minLength?: number;
  hint?: ReactNode;
  describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const hintId = useId();
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="password-input">
        <input
          id={id}
          className="input"
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          minLength={minLength}
          required
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onKeyUp={onKey}
          onBlur={() => setCapsLock(false)}
          aria-describedby={[hint ? hintId : null, describedBy].filter(Boolean).join(' ') || undefined}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="icon" aria-hidden /> : <Eye className="icon" aria-hidden />}
        </button>
      </span>
      {capsLock && (
        <small className="field-warn" role="status">
          <TriangleAlert className="icon" aria-hidden /> Caps Lock is on
        </small>
      )}
      {hint && (
        <small id={hintId} className="muted">
          {hint}
        </small>
      )}
    </label>
  );
}

/** 0–4 from length and character variety; good enough to steer people away from weak choices. */
export function passwordScore(password: string): number {
  if (password.length < MIN_PASSWORD_LENGTH) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 1;
  if (password.length >= 14) score += 1;
  if (password.length >= 20) score += 1;
  if (classes >= 3) score += 1;
  if (/^(.)\1+$/.test(password) || /^(?:0123456789|password|qwerty)/i.test(password)) score = 1;
  return Math.min(4, score);
}

const STRENGTH = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

export function StrengthMeter({ password, id }: { password: string; id?: string }) {
  const score = passwordScore(password);
  return (
    <div className={`strength strength-${score}`} id={id} aria-live="polite">
      <div className="strength-bars" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= score ? 'on' : ''} />
        ))}
      </div>
      <span className="strength-label">
        {password ? STRENGTH[score] : `At least ${MIN_PASSWORD_LENGTH} characters`}
      </span>
    </div>
  );
}

/** A random password without look-alike characters, from the browser's CSPRNG. */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs HTTPS or localhost; the text stays selectable.
    }
  };
  return (
    <button type="button" className="icon-btn" onClick={() => void copy()} aria-label={label} title={label}>
      {copied ? <Check className="icon" aria-hidden /> : <Copy className="icon" aria-hidden />}
    </button>
  );
}

function SetupForm({ onDone }: { onDone: () => Promise<void> }) {
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;

  const generate = () => {
    const next = generatePassword();
    setGenerated(next);
    setPassword(next);
    setConfirm(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/auth/setup', 'POST', { password, setupToken: setupToken.trim() });
      await onDone();
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 403
          ? 'That setup token is not valid. Copy it again from the core log.'
          : errorMessage(e),
      );
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Set up Emberline" subtitle="Claim this installation and choose the admin password.">
      <form className="form auth-form" onSubmit={(e) => void submit(e)}>
        {/* Single-user app: a fixed username lets password managers file the credential. */}
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <section className="auth-step">
          <span className="auth-step-n">1</span>
          <div>
            <label className="field" htmlFor="setup-token">
              <span>Setup token</span>
              <input
                id="setup-token"
                className="input mono"
                autoComplete="off"
                spellCheck={false}
                required
                autoFocus
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="Paste the token from the core log"
              />
            </label>
            <p className="auth-help">
              Core prints a one-time token on its first start, so only someone with access to the server can claim
              it. Find it with:
            </p>
            <div className="auth-command">
              <code>make logs | grep "setup token"</code>
              <CopyButton text={'make logs | grep "setup token"'} label="Copy command" />
            </div>
          </div>
        </section>

        <section className="auth-step">
          <span className="auth-step-n">2</span>
          <div className="auth-step-body">
            <PasswordField
              id="setup-password"
              label="Admin password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setGenerated(undefined);
              }}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              describedBy="setup-strength"
            />
            <StrengthMeter password={password} id="setup-strength" />
            <PasswordField
              id="setup-confirm"
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
            {mismatch && (
              <small className="field-warn" role="status">
                The passwords do not match yet.
              </small>
            )}
            <button type="button" className="btn btn-ghost btn-sm auth-generate" onClick={generate}>
              <WandSparkles className="icon" aria-hidden /> Generate a strong password
            </button>
            {generated && (
              <div className="auth-generated" role="status">
                <span>
                  <KeyRound className="icon" aria-hidden /> Save this in your password manager now:
                </span>
                <div className="auth-command">
                  <code>{generated}</code>
                  <CopyButton text={generated} label="Copy password" />
                </div>
              </div>
            )}
          </div>
        </section>

        {error && (
          <p className="auth-error" role="alert">
            <TriangleAlert className="icon" aria-hidden /> {error}
          </p>
        )}
        <button
          id="setup-submit"
          className="btn btn-primary auth-submit"
          disabled={busy || mismatch || password.length < MIN_PASSWORD_LENGTH || !setupToken.trim()}
        >
          {busy ? (
            <>
              <LoaderCircle className="icon icon-spin" aria-hidden /> Saving…
            </>
          ) : (
            'Create password & continue'
          )}
        </button>
      </form>
    </AuthLayout>
  );
}

function LoginForm({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showReset, setShowReset] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/auth/login', 'POST', { password });
      await onDone();
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 401
          ? 'That password is not correct.'
          : e instanceof ApiRequestError && e.status === 429
            ? `Too many attempts: ${e.message.replace(/^too many failed attempts, /, '')}.`
            : errorMessage(e),
      );
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your Emberline control room.">
      <form className="form auth-form" onSubmit={(e) => void submit(e)}>
        {/* Single-user app: a fixed username lets password managers file the credential. */}
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <PasswordField
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
        />
        {error && (
          <p className="auth-error" role="alert">
            <TriangleAlert className="icon" aria-hidden /> {error}
          </p>
        )}
        <button id="login-submit" className="btn btn-primary auth-submit" disabled={busy || !password}>
          {busy ? (
            <>
              <LoaderCircle className="icon icon-spin" aria-hidden /> Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </button>
        <button type="button" className="auth-link" onClick={() => setShowReset((v) => !v)} aria-expanded={showReset}>
          Forgot your password?
        </button>
        {showReset && (
          <div className="auth-help-box">
            <p>On the server, run:</p>
            <div className="auth-command">
              <code>make reset-password</code>
              <CopyButton text="make reset-password" label="Copy command" />
            </div>
            <p>
              It clears the password (projects and runs are kept), restarts core and prints a new setup token. Then
              reload this page and set a new password.
            </p>
          </div>
        )}
      </form>
    </AuthLayout>
  );
}

import { type FormEvent, useEffect, useState } from 'react';
import type { NotificationProvider, NotificationSettings, TestNotificationResponse } from '@emberline/protocol';
import { api, errorMessage } from '../api';

export function NotificationsPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<NotificationProvider>('ntfy');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [onRateLimited, setOnRateLimited] = useState(true);
  const [onQuotaResumed, setOnQuotaResumed] = useState(true);
  const [onWaitingInput, setOnWaitingInput] = useState(true);
  const [onRunFinished, setOnRunFinished] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<NotificationSettings>('/api/notifications')
      .then((res) => {
        setSettings(res);
        setEnabled(res.enabled);
        setProvider(res.provider);
        setUrl(res.url);
        setToken(res.token ?? '');
        setOnRateLimited(res.onRateLimited);
        setOnQuotaResumed(res.onQuotaResumed);
        setOnWaitingInput(res.onWaitingInput);
        setOnRunFinished(res.onRunFinished);
      })
      .catch(() => undefined);
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const updated = await api<NotificationSettings>('/api/notifications', 'PATCH', {
        enabled,
        provider,
        url: url.trim(),
        token: token.trim() ? token.trim() : null,
        onRateLimited,
        onQuotaResumed,
        onWaitingInput,
        onRunFinished,
      });
      setSettings(updated);
      setNotice('Notification settings saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      const res = await api<TestNotificationResponse>('/api/notifications/test', 'POST', {});
      if (res.ok) {
        setNotice(`Test notification delivered (HTTP ${res.status ?? 200}).`);
      } else {
        setError(`Test notification failed: ${res.error ?? 'unknown error'}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="notifications-title">
      <header className="panel-head">
        <div>
          <h2 id="notifications-title">Notifications (ntfy / Webhook)</h2>
          <p className="muted">
            Push alerts when Claude hits a usage limit, auto-resumes after reset, or waits for your input.
          </p>
        </div>
        <div className="actions">
          <span className={`badge mono${settings?.enabled ? ' badge-soft' : ''}`}>
            {settings?.enabled ? `${settings.provider.toUpperCase()} ON` : 'OFF'}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Configure'}
          </button>
        </div>
      </header>

      {open && (
        <form className="form" onSubmit={(e) => void save(e)}>
          <div className="form-row">
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enable push notifications
            </label>

            <div className="segmented" role="radiogroup" aria-label="Notification provider">
              <button
                type="button"
                role="radio"
                aria-checked={provider === 'ntfy'}
                className={provider === 'ntfy' ? 'active' : ''}
                onClick={() => setProvider('ntfy')}
              >
                ntfy.sh
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={provider === 'webhook'}
                className={provider === 'webhook' ? 'active' : ''}
                onClick={() => setProvider('webhook')}
              >
                Webhook (Discord / Slack / JSON)
              </button>
            </div>
          </div>

          <div className="form-row">
            <input
              type="url"
              className="input"
              placeholder={
                provider === 'ntfy'
                  ? 'https://ntfy.sh/your-secret-emberline-topic'
                  : 'https://discord.com/api/webhooks/... or custom webhook URL'
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Optional Bearer token (private ntfy / webhook)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ maxWidth: '260px' }}
            />
          </div>

          <div className="form-row" style={{ gap: '14px', flexWrap: 'wrap' }}>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={onRateLimited}
                onChange={(e) => setOnRateLimited(e.target.checked)}
              />
              Quota limit reached
            </label>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={onQuotaResumed}
                onChange={(e) => setOnQuotaResumed(e.target.checked)}
              />
              Quota reset & auto-resumed
            </label>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={onWaitingInput}
                onChange={(e) => setOnWaitingInput(e.target.checked)}
              />
              Agent waiting on you
            </label>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={onRunFinished}
                onChange={(e) => setOnRunFinished(e.target.checked)}
              />
              Run completed / failed
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save Settings'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null || !url.trim()}
              onClick={() => void sendTest()}
            >
              {busy === 'test' ? 'Sending…' : 'Send Test'}
            </button>
          </div>

          {notice && <p className="muted small mono">{notice}</p>}
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </section>
  );
}

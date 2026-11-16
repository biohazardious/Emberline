import type {
  NotificationProvider,
  NotificationSettingsView,
  TestNotificationResponse,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import './settings/settings-panels.css';
import { Switch } from './ui/Switch';

export function NotificationsPanel() {
  const [settings, setSettings] = useState<NotificationSettingsView | null>(null);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<NotificationProvider>('ntfy');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [onRateLimited, setOnRateLimited] = useState(true);
  const [onQuotaResumed, setOnQuotaResumed] = useState(true);
  const [onWaitingInput, setOnWaitingInput] = useState(true);
  const [onRunFinished, setOnRunFinished] = useState(false);
  const [onGitEvents, setOnGitEvents] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<NotificationSettingsView>('/api/notifications')
      .then((res) => {
        setSettings(res);
        setEnabled(res.enabled);
        setProvider(res.provider);
        setUrl(res.url);
        setOnRateLimited(res.onRateLimited);
        setOnQuotaResumed(res.onQuotaResumed);
        setOnWaitingInput(res.onWaitingInput);
        setOnRunFinished(res.onRunFinished);
        setOnGitEvents(res.onGitEvents);
      })
      .catch(() => undefined);
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const updated = await api<NotificationSettingsView>('/api/notifications', 'PATCH', {
        enabled,
        provider,
        url: url.trim(),
        // The stored token is never sent back, so a blank field keeps it.
        ...(token.trim() ? { token: token.trim() } : {}),
        onRateLimited,
        onQuotaResumed,
        onWaitingInput,
        onRunFinished,
        onGitEvents,
      });
      setSettings(updated);
      setToken('');
      setOpen(false);
      setNotice('Notification settings saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const clearToken = async () => {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const updated = await api<NotificationSettingsView>('/api/notifications', 'PATCH', { token: null });
      setSettings(updated);
      setToken('');
      setNotice('Notification token cleared.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeWebhook = async () => {
    if (!window.confirm('Remove this webhook?')) return;
    setBusy('remove');
    setError(null);
    setNotice(null);
    try {
      const updated = await api<NotificationSettingsView>('/api/notifications', 'PATCH', {
        enabled: false,
        url: '',
        token: null,
      });
      setSettings(updated);
      setEnabled(false);
      setUrl('');
      setToken('');
      setOpen(false);
      setNotice('Webhook removed.');
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

  const hasWebhook = Boolean(settings?.url?.trim());

  return (
    <section className="panel settings-panel" aria-labelledby="notifications-title">
      <header className="settings-panel-head">
        <div className="settings-panel-title-group">
          <div className="settings-panel-heading-row">
            <h2 id="notifications-title">Webhooks</h2>
          </div>
          <p className="muted">Push alerts via ntfy.sh or webhook.</p>
        </div>
        <div className="actions">
          <span className={`badge mono${settings?.enabled ? ' badge-soft' : ''}`}>
            {settings?.enabled ? `${settings.provider.toUpperCase()} ON` : 'NOTIFY OFF'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Cancel' : hasWebhook ? 'Configure' : 'Add webhook'}
          </button>
        </div>
      </header>

      {hasWebhook && !open && settings && (
        <ul className="forge-account-list">
          <li className="forge-account-row">
            <div className="forge-account-main">
              <span className="badge badge-soft">{settings.provider === 'ntfy' ? 'ntfy.sh' : 'Webhook'}</span>
              <span className="mono">{settings.url}</span>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void sendTest()}
              >
                {busy === 'test' ? 'Sending…' : 'Test'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost danger"
                disabled={busy !== null}
                onClick={() => void removeWebhook()}
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
      )}

      {open && (
        <form className="form settings-subform" onSubmit={(e) => void save(e)}>
          <div className="form-row">
            <Switch checked={enabled} onChange={setEnabled} label="Enable push notifications" />

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
                Webhook
              </button>
            </div>
          </div>

          <div className="form-row">
            <input
              type="url"
              className="input"
              aria-label="Webhook URL"
              placeholder={
                provider === 'ntfy'
                  ? 'https://ntfy.sh/your-secret-emberline-topic'
                  : 'https://discord.com/api/webhooks/… or custom webhook URL'
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              type="password"
              autoComplete="new-password"
              className="input settings-token-input"
              aria-label="Webhook bearer token"
              placeholder={
                settings?.tokenConfigured ? 'Token set (leave blank to keep)' : 'Optional Bearer token'
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            {settings?.tokenConfigured && (
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                onClick={() => void clearToken()}
                disabled={busy !== null}
              >
                Remove token
              </button>
            )}
          </div>

          <div className="settings-checkbox-grid">
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
              Quota reset
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
              Run finished
            </label>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={onGitEvents}
                onChange={(e) => setOnGitEvents(e.target.checked)}
              />
              Git sync or release
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save webhook'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null || !url.trim()}
              onClick={() => void sendTest()}
            >
              {busy === 'test' ? 'Sending…' : 'Test webhook'}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <p className="muted small mono" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

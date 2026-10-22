/**
 * Which `settings` rows hold secrets, and where in their JSON value. Each entry maps a value's
 * secret strings with `f` (seal or open) and leaves everything else as it is.
 */
import { openSecret, sealSecret } from './box.js';

type Fn = (s: string) => string;

const fields =
  (...names: string[]) =>
  (v: unknown, f: Fn): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    for (const n of names) if (typeof out[n] === 'string' && out[n]) out[n] = f(out[n] as string);
    return out;
  };

/** The values of every MCP server's `env` (the API still shows them; only the stored copy is sealed). */
const mcpEnv = (v: unknown, f: Fn): unknown => {
  if (!v || typeof v !== 'object' || !Array.isArray((v as { mcpServers?: unknown }).mcpServers)) return v;
  const s = v as { mcpServers: Array<{ env?: Record<string, unknown> } | null> };
  return {
    ...s,
    mcpServers: s.mcpServers.map((m) =>
      m?.env && typeof m.env === 'object' && !Array.isArray(m.env)
        ? {
            ...m,
            env: Object.fromEntries(
              Object.entries(m.env).map(([k, x]) => [k, typeof x === 'string' && x ? f(x) : x]),
            ),
          }
        : m,
    ),
  };
};

export const SECRET_SETTINGS: Record<string, (v: unknown, f: Fn) => unknown> = {
  'factory.providerKeys': fields('anthropicApiKey', 'openaiApiKey', 'geminiApiKey'),
  'notifications.config': fields('token'),
  'updates.config': fields('githubToken'),
  'forge.config': fields('token'),
  'demo.tokenSecret': (v, f) => (typeof v === 'string' && v ? f(v) : v),
  'factory.settings': mcpEnv,
};

export const sealSetting = (key: string, v: unknown): unknown =>
  SECRET_SETTINGS[key] ? SECRET_SETTINGS[key](v, sealSecret) : v;

export const openSetting = (key: string, v: unknown): unknown =>
  SECRET_SETTINGS[key] ? SECRET_SETTINGS[key](v, openSecret) : v;

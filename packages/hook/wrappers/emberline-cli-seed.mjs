#!/usr/bin/env node
/**
 * Usage: emberline-cli-seed.mjs <agent>
 *
 * Merges the config entries that pre-answer a CLI's first-run questions into the runner's home
 * before an Emberline run starts it: questions an unattended run can never answer (folder trust,
 * update offers, auth-method pickers). Only missing values are added; the user's own choices and
 * every other key are kept. Files that cannot be parsed are left alone. Writes are atomic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.HOME || os.homedir();
const agent = process.argv[2];

/** Reads a JSON (or JSONC with leading `//` comment lines) file: { head, data }, or null if unusable. */
function read(file) {
  if (!fs.existsSync(file)) return { head: '', data: {} };
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let i = 0;
    while (i < lines.length && /^\s*(\/\/.*)?$/.test(lines[i])) i++;
    const head = lines.slice(0, i).join('\n');
    const body = lines.slice(i).join('\n').trim();
    const data = body ? JSON.parse(body) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return { head: head ? `${head}\n` : '', data };
  } catch {
    return null;
  }
}

function write(file, head, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.emberline-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${head}${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Sets `value` at `keys` unless something is already there. Returns whether it changed. */
function ensure(data, keys, value) {
  let node = data;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      if (node[key] !== undefined) return false;
      node[key] = {};
    }
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (node[last] !== undefined) return false;
  node[last] = value;
  return true;
}

function seed(file, apply) {
  const current = read(file);
  if (!current) return;
  if (apply(current.data)) write(file, current.head, current.data);
}

if (agent === 'gemini' || agent === 'antigravity') {
  // Gemini CLI (also the agy fallback): no update offers; with an API key and no auth choice yet,
  // skip the "how would you like to authenticate?" picker.
  seed(path.join(home, '.gemini', 'settings.json'), (data) => {
    let changed = ensure(data, ['general', 'enableAutoUpdate'], false);
    changed = ensure(data, ['general', 'enableAutoUpdateNotification'], false) || changed;
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      changed = ensure(data, ['security', 'auth', 'selectedType'], 'gemini-api-key') || changed;
    }
    return changed;
  });
}

if (agent === 'copilot') {
  // Copilot asks to trust every new folder; all workspaces and run worktrees live under /workspaces.
  seed(path.join(home, '.copilot', 'config.json'), (data) => {
    const folders = Array.isArray(data.trustedFolders) ? data.trustedFolders : [];
    if (folders.includes('/workspaces')) return false;
    data.trustedFolders = [...folders, '/workspaces'];
    return true;
  });
  seed(path.join(home, '.copilot', 'settings.json'), (data) => {
    let changed = ensure(data, ['banner'], 'never');
    changed = ensure(data, ['showTipsOnStartup'], false) || changed;
    return ensure(data, ['autoUpdate'], false) || changed;
  });
}

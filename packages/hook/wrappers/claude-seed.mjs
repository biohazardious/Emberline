#!/usr/bin/env node
/**
 * Pre-answers Claude Code's one-time dialogs in ~/.claude.json right before an Emberline run starts.
 * These live only in that file (settings and env cannot turn them off), and each would otherwise
 * wait in the run's terminal for a keypress nobody gives: the onboarding screen of an API-key-only
 * install, the "use this API key?" question (default "No"), the effort and auto-mode nudges, the
 * resume screens, LSP plugin offers and the Claude in Chrome offer.
 *
 * Only missing keys are added and nothing is removed. The file is replaced atomically, so Claude Code
 * (which re-reads it before writing) keeps its own changes; a file that cannot be parsed is left alone.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const home = process.env.HOME || homedir();
const file = path.join(home, '.claude.json');

let config = {};
if (existsSync(file)) {
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) process.exit(0);
}

let changed = false;
const ensure = (key, value) => {
  if (config[key] !== value) {
    config[key] = value;
    changed = true;
  }
};

const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
const signedIn =
  existsSync(path.join(home, '.claude', '.credentials.json')) || Boolean(config.oauthAccount) || apiKey !== '';
// Without credentials the onboarding is where the user logs in; never skip it then.
if (signedIn) ensure('hasCompletedOnboarding', true);

ensure('resumeReturnDismissed', true);
// Claude in Chrome: its onboarding and its "use my browser?" offer (shown when the account has the
// extension somewhere). An answer the user already gave is kept.
ensure('hasCompletedClaudeInChromeOnboarding', true);
if (config.claudeInChromeDefaultEnabled === undefined) ensure('claudeInChromeDefaultEnabled', false);
ensure('lspRecommendationDisabled', true);
ensure('hasSeenEffortMediumNudge', true);
ensure('hasSeenAutoDefaultNudge', true);
ensure('hasSeenAutoModeOutsideReadPrompt', true);
const byModel = config.hasSeenEffortMediumNudgeByModel && typeof config.hasSeenEffortMediumNudgeByModel === 'object'
  ? config.hasSeenEffortMediumNudgeByModel
  : {};
for (const model of ['claude-opus-5', 'claude-fable-5-1']) {
  if (byModel[model] !== true) {
    byModel[model] = true;
    changed = true;
  }
}
config.hasSeenEffortMediumNudgeByModel = byModel;

// The key Emberline injects from Settings is the user's own choice: approve it (Claude Code keys the
// answer by the key's last 20 characters).
if (apiKey !== '') {
  const tail = apiKey.slice(-20);
  const responses = config.customApiKeyResponses && typeof config.customApiKeyResponses === 'object'
    ? config.customApiKeyResponses
    : {};
  const approved = Array.isArray(responses.approved) ? responses.approved : [];
  const rejected = Array.isArray(responses.rejected) ? responses.rejected : [];
  if (!approved.includes(tail) || rejected.includes(tail)) {
    config.customApiKeyResponses = {
      ...responses,
      approved: approved.includes(tail) ? approved : [...approved, tail],
      rejected: rejected.filter((t) => t !== tail),
    };
    changed = true;
  }
}

if (changed) {
  const tmp = `${file}.emberline-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

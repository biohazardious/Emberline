import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  localCommandCanceller,
  localCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
} from './command-exec.js';
import { installSecretsKey } from './secrets/box.js';

setCommandExecutor(localCommandExecutor);
setCommandCanceller(localCommandCanceller);
// Core installs the key at start (secrets/startup.ts); every test gets its own random one.
installSecretsKey(randomBytes(32));

/*
 * Tests run commands in-process, so they inherit the environment of whatever runs vitest. Inside an
 * Emberline runner that is an agent's own run: its Docker engine and its signed-in Claude would leak
 * into "engine off" and "not signed in" cases. Each test starts from neither; a test that needs one
 * sets it itself.
 */
for (const name of [
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'EMBERLINE_COMPOSE_PROJECT',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]) {
  delete process.env[name];
}
process.env.EMBERLINE_RUNNER_HOME = mkdtempSync(path.join(tmpdir(), 'emberline-runner-home-'));

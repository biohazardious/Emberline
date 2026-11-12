import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  localCommandCanceller,
  localCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
} from './command-exec.js';
import { installSecretsKey } from './secrets/box.js';

// The suite often runs inside an Emberline runner, whose own run, Docker engine and provider
// logins must not leak into what a test sees or into the commands it spawns.
const INHERITED_ENV = [
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_CONTEXT',
  'EMBERLINE_COMPOSE_PROJECT',
  'EMBERLINE_RUN_ID',
  'EMBERLINE_HOOK_TOKEN',
  'EMBERLINE_CORE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];
for (const name of INHERITED_ENV) delete process.env[name];
// Core reads the runner's home (CLI logins) and tools volume; tests that need them create their own.
const absent = path.join(tmpdir(), `emberline-test-absent-${process.pid}`);
process.env.EMBERLINE_RUNNER_HOME = path.join(absent, 'home');
process.env.EMBERLINE_TOOLS_DIR = path.join(absent, 'ai-tools');

setCommandExecutor(localCommandExecutor);
setCommandCanceller(localCommandCanceller);
// Core installs the key at start (secrets/startup.ts); every test gets its own random one.
installSecretsKey(randomBytes(32));

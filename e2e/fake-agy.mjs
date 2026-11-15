#!/usr/bin/env node
/**
 * A stand-in for `agy` in the e2e stack: answers `agy [--log-file X] models` with the format the real CLI
 * prints (a progress line, then tab-separated id and label). FAKE_AGY_MODELS names another list file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--log-file') args.splice(0, 2);
if (args[0] !== 'models') {
  console.error(`fake-agy: only "models" is supported, got "${args.join(' ')}"`);
  process.exit(2);
}
const file =
  process.env.FAKE_AGY_MODELS ??
  (existsSync('/e2e-fixtures/agy-models.txt') ? '/e2e-fixtures/agy-models.txt' : undefined) ??
  fileURLToPath(new URL('../apps/core/src/models/fixtures/agy-models.txt', import.meta.url));
process.stdout.write(readFileSync(file, 'utf8'));

/**
 * `node dist/reset-password.js` (used by `make reset-password`): removes the admin password and
 * every session, so the next core start prints a new one-time setup token and the web UI shows
 * first-run setup again. Projects, runs and settings are kept.
 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { sessions, settings } from './db/schema.js';

const config = loadConfig();
const { db, close } = openDb(path.join(config.dataDir, 'emberline.db'));
db.delete(settings).where(eq(settings.key, 'auth.passwordHash')).run();
db.delete(sessions).run();
close();
process.stdout.write('Password and sessions removed. Restart core to get a new setup token.\n');

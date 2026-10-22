import { randomBytes } from 'node:crypto';
import { localCommandCanceller, localCommandExecutor, setCommandCanceller, setCommandExecutor } from './command-exec.js';
import { installSecretsKey } from './secrets/box.js';

setCommandExecutor(localCommandExecutor);
setCommandCanceller(localCommandCanceller);
// Core installs the key at start (secrets/startup.ts); every test gets its own random one.
installSecretsKey(randomBytes(32));

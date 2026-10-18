import { localCommandCanceller, localCommandExecutor, setCommandCanceller, setCommandExecutor } from './command-exec.js';

setCommandExecutor(localCommandExecutor);
setCommandCanceller(localCommandCanceller);

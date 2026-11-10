/**
 * Starting a process as another user. In the runner ptyd runs as a user of its own and starts every
 * session and command as the agents' user (`node`), or as a service user (`browser`), so no agent ever
 * runs as ptyd. `setpriv` changes the user and groups, then execs the command in place (same pid, same
 * process group): the command gets that user's own groups (node keeps dialout for USB) and no
 * capabilities at all. ptyd's capabilities are ambient, and a change between two users that are not
 * root keeps ambient capabilities, so they are cleared explicitly, with the inheritable and bounding
 * sets.
 *
 * ptyd's own capabilities (the runner's entrypoint) are exactly these: setuid and setgid to change
 * user, setpcap to empty the bounding set, kill to signal what it started (timeouts, cancel, kill),
 * chown to give a session its terminal.
 */

import { readFileSync, statSync } from 'node:fs';

const SETPRIV = '/usr/bin/setpriv';
const ENV = '/usr/bin/env';

/** The argv that runs what follows it as `user`, with that user's groups and no capabilities. */
export function dropArgs(user: string): string[] {
  return [
    SETPRIV,
    `--reuid=${user}`,
    `--regid=${user}`,
    '--init-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--',
  ];
}

/**
 * `file args` started in `cwd` as `user`; unchanged without a user (the dev stack, an ops ptyd). With
 * a user the directory is entered after the drop (`env --chdir`, started from `/`): an agent's
 * directory may be one only the agents' user can enter. `file` must not contain `=` then (env would
 * take it for a variable): {@link droppableFile}.
 */
export function wrapForUser(
  file: string,
  args: string[],
  user: string | undefined,
  cwd: string,
): { file: string; args: string[]; cwd: string } {
  if (user === undefined) return { file, args, cwd };
  const [setpriv = SETPRIV, ...options] = dropArgs(user);
  return { file: setpriv, args: [...options, ENV, `--chdir=${cwd}`, '--', file, ...args], cwd: '/' };
}

/** Whether `file` can be started through `env` as itself (a name with `=` would be a variable). */
export function droppableFile(file: string): boolean {
  return !file.includes('=');
}

/** The uid of `user` in a passwd file, or undefined when it has none. */
export function lookupUid(user: string, file = '/etc/passwd'): number | undefined {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [name, , uid] = line.split(':');
      if (name === user && uid !== undefined && /^\d+$/.test(uid)) return Number(uid);
    }
  } catch {
    // No passwd file: no such user.
  }
  return undefined;
}

/**
 * Why a command cannot start in `cwd`, or null. Only a directory that is missing (or not one) is
 * refused here: ptyd may not be allowed to enter an agent's directory (EACCES) while the user the
 * command runs as is, and that is found out after the drop.
 */
export function cwdProblem(cwd: string): string | null {
  try {
    return statSync(cwd).isDirectory() ? null : `cwd does not exist: ${cwd}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? `cwd does not exist: ${cwd}` : null;
  }
}

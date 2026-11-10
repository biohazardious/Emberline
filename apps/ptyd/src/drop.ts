/**
 * Starting a process as another user. In the runner ptyd runs as a user of its own and starts every
 * session and command as the agents' user (`node`), or as a service user (`browser`), so no agent ever
 * runs as ptyd. `setpriv` changes the user and groups, then execs the command in place (same pid, same
 * process group): the command gets that user's own groups (node keeps dialout for USB) and no
 * capabilities at all. ptyd's capabilities are ambient, and a change between two users that are not
 * root keeps ambient capabilities, so they are cleared explicitly, with the inheritable and bounding
 * sets.
 */

const SETPRIV = '/usr/bin/setpriv';

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

/** `file args` run as `user`; unchanged without a user (the dev stack, an ops ptyd). */
export function wrapForUser(
  file: string,
  args: string[],
  user: string | undefined,
): { file: string; args: string[] } {
  if (user === undefined) return { file, args };
  const [setpriv = SETPRIV, ...options] = dropArgs(user);
  return { file: setpriv, args: [...options, file, ...args] };
}

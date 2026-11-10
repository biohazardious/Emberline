#!/bin/bash
#
# The runner's entrypoint. It starts as root only to make the directories of the runner's services,
# each owned by its service's user, then runs ptyd as its own user (ptyd) with just the capabilities
# it needs to start sessions and commands as the agents' user (node) and the browser daemon as
# browser. No agent ever runs as ptyd, and the directory of ptyd's socket is never theirs: only
# ptyd and the group emberline-core (core's user, in the core image) may reach the socket.
#
# Only the image's own binaries, by path, and bash's builtins: the runner's PATH starts with
# /opt/ai-tools/bin (the runner-tools volume, which agents can write), and ptyd must never be a
# planted `node`. Every step root takes in a volume follows no link: the volumes hold what agents
# (or an older Emberline's agents) left there.
set -e

TOOLS_DIR="${EMBERLINE_TOOLS_DIR:-/opt/ai-tools}"
# Fixed paths, whatever the environment says: core finds ptyd's socket here (the ptyd-socket volume).
RUN_DIR=/run/emberline
SOCKET_DIR="$RUN_DIR/ptyd"
SOCKET="$SOCKET_DIR/ptyd.sock"
LOG_DIR=/var/log/emberline
PTYD=(/usr/local/bin/node /opt/emberline/ptyd/dist/main.js)
# Exactly ptyd's capabilities (apps/ptyd/src/drop.ts): setuid and setgid to change user, setpcap to
# empty the bounding set of what it starts, kill to signal it, chown to give a session its terminal.
PTYD_CAPS=-all,+setuid,+setgid,+setpcap,+kill,+chown
TOOLS_DIRS=("${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx")

fail() {
  echo "runner: $1; stopping" >&2
  exit 1
}

# Started as another user (a compose file that sets `user:`): ptyd cannot run under a user of its own,
# and the socket directory is not this user's to listen in. The runner stops; core waits for it.
[ "$EUID" = 0 ] || fail "started as uid ${EUID}, not root: ptyd cannot run under its own user. Remove \`user:\` from the runner service"

HOME=/home/node /usr/bin/setpriv --reuid=node --regid=node --init-groups --inh-caps=-all \
  /usr/bin/mkdir -p "${TOOLS_DIRS[@]}" 2>/dev/null || true

# The ptyd-socket volume (shared with core) is root's; each service gets a directory of its own in it,
# made afresh on every start: a link or file left in its place is removed, never followed.
[ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ] || fail "${RUN_DIR} is not a directory"
/usr/bin/chown -h root:root "$RUN_DIR"
/usr/bin/chmod 0755 "$RUN_DIR"
# Emberline 0.6.x kept ptyd's socket and the browser daemon's files beside each other in it.
/usr/bin/rm -rf -- "$RUN_DIR"/{ptyd.sock,browser-daemon.mjs,playwright-hook.cjs,browser.sock,browser-tabs.json,browser-tabs.json.tmp,agent-browser-events.jsonl}
/usr/bin/rm -rf -- "$SOCKET_DIR" "$RUN_DIR/browser" "$RUN_DIR/agent-events"
# ptyd's: setgid, so its socket gets the group emberline-core (ptyd makes it 0660).
/usr/bin/mkdir -m 0750 -- "$SOCKET_DIR"
/usr/bin/chown -h ptyd:emberline-core "$SOCKET_DIR"
/usr/bin/chmod 2750 "$SOCKET_DIR"
# The browser daemon's socket and state.
/usr/bin/mkdir -m 0755 -- "$RUN_DIR/browser"
/usr/bin/chown -h browser:browser "$RUN_DIR/browser"
# What the agents' Playwright hook reports to the browser daemon.
/usr/bin/mkdir -m 0755 -- "$RUN_DIR/agent-events"
/usr/bin/chown -h node:node "$RUN_DIR/agent-events"

# The mount point of the ops service's socket volume (same image): only core and ops mount it, so in
# the runner it is an empty directory, removed. A volume mounted there stops the runner.
if [ -e /run/emberline-ops ] || [ -L /run/emberline-ops ]; then
  /usr/bin/rmdir -- /run/emberline-ops 2>/dev/null ||
    fail "/run/emberline-ops is mounted in the runner: only core and ops may mount the ops-socket volume"
fi

# ptyd's session logs (the runner-logs volume), the runner user's before 0.7.0: ptyd's only. Links in
# it are re-owned themselves, never what they point at.
[ -d "$LOG_DIR" ] && [ ! -L "$LOG_DIR" ] || fail "${LOG_DIR} is not a directory"
/usr/bin/chown -hR ptyd:ptyd -- "$LOG_DIR"
/usr/bin/chmod 0700 -- "$LOG_DIR"

# `docker stop` reaches ptyd itself: setpriv execs it in this process's place.
HOME=/home/node \
  EMBERLINE_PTYD_MODE=runner \
  EMBERLINE_PTYD_SOCKET="$SOCKET" \
  EMBERLINE_PTYD_LOG_DIR="$LOG_DIR" \
  EMBERLINE_PTYD_DROP_TO=node \
  EMBERLINE_PTYD_SERVICE_USERS=browser \
  EMBERLINE_PTYD_REQUIRE_ISOLATION=1 \
  exec /usr/bin/setpriv --reuid=ptyd --regid=ptyd --init-groups \
  --inh-caps="$PTYD_CAPS" --ambient-caps="$PTYD_CAPS" --bounding-set="$PTYD_CAPS" \
  -- "${PTYD[@]}"

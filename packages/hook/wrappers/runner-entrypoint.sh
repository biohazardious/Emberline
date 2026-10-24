#!/bin/bash
#
# The runner's entrypoint. It starts as root only to lock ptyd's socket in place, and runs ptyd as
# the runner user (node), with the same environment as before; every agent is one of ptyd's
# children, so agents run as node too.
#
# Only the image's own binaries, by path, and bash's builtins: the runner's PATH starts with
# /opt/ai-tools/bin (the runner-tools volume, which agents can write), and ptyd must never be a
# planted `node`. Every step root takes in a volume follows no link: the volumes hold what agents
# (or an older Emberline's agents) left there.
set -e

TOOLS_DIR="${EMBERLINE_TOOLS_DIR:-/opt/ai-tools}"
SOCKET="${EMBERLINE_PTYD_SOCKET:-/run/emberline/ptyd.sock}"
RUN_DIR="${SOCKET%/*}"
PTYD=(/usr/local/bin/node /opt/emberline/ptyd/dist/main.js)

if [ "$EUID" != 0 ]; then
  # Started as another user (a compose file that sets `user:`): the socket cannot be locked, so
  # Emberline treats this runner as not secured and starts nothing in it (see SECURITY.md).
  echo "runner: started as uid $EUID, not root: the runner's service socket cannot be locked, and Emberline will start nothing in this runner. Remove \`user:\` from the runner service." >&2
  /usr/bin/mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true
  exec "${PTYD[@]}"
fi

AS_NODE=(/usr/bin/setpriv --reuid=node --regid=node --init-groups --inh-caps=-all)

fail() {
  echo "runner: $1; stopping" >&2
  [ -n "${ptyd:-}" ] && kill -TERM "$ptyd" 2>/dev/null && wait "$ptyd"
  exit 1
}

HOME=/home/node "${AS_NODE[@]}" /usr/bin/mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true

# ptyd's socket directory (the ptyd-socket volume, shared with core) is root's, except while ptyd
# binds: agents share ptyd's user, so in a directory of theirs they could remove the socket and listen
# in its place, and core would take them for ptyd. Nothing starts in that window: ptyd refuses spawn
# and exec until the directory is locked again (EMBERLINE_PTYD_REQUIRE_LOCK), and core waits for it.
[ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ] || fail "${RUN_DIR} is not a directory"
/usr/bin/chown -h root:root "$RUN_DIR"
/usr/bin/chmod 0755 "$RUN_DIR"
# Removing a link removes the link, never what it points at. The browser daemon's script, socket and
# state, and the Playwright hook, live in browser/, which is the runner user's; it is made afresh on
# every start (the daemon rewrites all of it), so a link or file left in its place is never followed.
# Emberline before 0.6.1 kept these files beside the socket.
/usr/bin/rm -f -- "$SOCKET" "$RUN_DIR"/{browser-daemon.mjs,playwright-hook.cjs,browser.sock,browser-tabs.json,browser-tabs.json.tmp,agent-browser-events.jsonl}
/usr/bin/rm -rf -- "$RUN_DIR/browser"
/usr/bin/mkdir -m 0755 -- "$RUN_DIR/browser"
/usr/bin/chown -h node:node "$RUN_DIR/browser"
/usr/bin/chown -h node:node "$RUN_DIR"

# ptyd says when it listens, and which socket is its own, on a pipe only root can open.
start_dir="$(/usr/bin/mktemp -d /run/emberline-start.XXXXXXXX)"
/usr/bin/mkfifo -m 0600 "$start_dir/ready"
# A simple command, not a function: `$!` is then ptyd itself (setpriv execs it), not a subshell. The
# pipe is opened by this shell's child while it is still root, then inherited as fd 3.
EMBERLINE_PTYD_REQUIRE_LOCK=1 EMBERLINE_PTYD_READY_FD=3 HOME=/home/node "${AS_NODE[@]}" "${PTYD[@]}" 3>"$start_dir/ready" &
ptyd=$!
# `docker stop` reaches this shell (docker-init passes signals to its child); ptyd shuts down itself.
trap 'kill -TERM "$ptyd" 2>/dev/null' TERM INT HUP

set +e
exec 4<"$start_dir/ready"
/usr/bin/rm -rf -- "$start_dir"
read -r -t 60 -u 4 word dev ino
exec 4<&-
[ "$word" = ready ] || fail "ptyd did not start listening"

# Lock only ptyd's own socket: a socket (not a link), with the device and inode ptyd bound.
is_ptyds_socket() { [ "$(/usr/bin/stat -c '%d %i %F' -- "$SOCKET" 2>/dev/null)" = "$dev $ino socket" ]; }
is_ptyds_socket || fail "${SOCKET} is not the socket ptyd bound"
/usr/bin/chown -h root:root "$RUN_DIR" && /usr/bin/chmod 0755 "$RUN_DIR" || fail "could not lock ${RUN_DIR}"
# Checked again with the directory root's: nothing can change the socket any more.
is_ptyds_socket || fail "${SOCKET} changed while ${RUN_DIR} was locked"
echo "runner: ${RUN_DIR} locked; ptyd may start sessions" >&2

# A signal ends `wait` early (the trap passes it on): wait again until ptyd has exited.
while :; do
  wait "$ptyd"
  status=$?
  kill -0 "$ptyd" 2>/dev/null || exit "$status"
done

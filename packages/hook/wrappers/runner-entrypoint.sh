#!/bin/bash
#
# The runner's entrypoint. It starts as root only to lock ptyd's socket in place, and runs ptyd as
# the runner user (node), with the same environment as before; every agent is one of ptyd's
# children, so agents run as node too.
#
# Only the image's own binaries, by path, and bash's builtins: the runner's PATH starts with
# /opt/ai-tools/bin (the runner-tools volume, which agents can write), and ptyd must never be a
# planted `node`.
set -e

TOOLS_DIR="${EMBERLINE_TOOLS_DIR:-/opt/ai-tools}"
SOCKET="${EMBERLINE_PTYD_SOCKET:-/run/emberline/ptyd.sock}"
RUN_DIR="${SOCKET%/*}"
PTYD=(/usr/local/bin/node /opt/emberline/ptyd/dist/main.js)

if [ "$EUID" != 0 ]; then
  # Started as another user (a compose file that sets `user:`): nothing can be locked.
  /usr/bin/mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true
  exec "${PTYD[@]}"
fi

AS_NODE=(/usr/bin/setpriv --reuid=node --regid=node --init-groups --inh-caps=-all)

HOME=/home/node "${AS_NODE[@]}" /usr/bin/mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true

# ptyd's socket directory (the ptyd-socket volume, shared with core) is the runner user's while ptyd
# binds, when no agent runs yet, and root's from then on: agents share ptyd's user, so in a directory
# of theirs they could remove the socket and listen in its place, and core would take them for ptyd.
# The browser daemon's script, socket and state, and the Playwright hook, live in browser/, which
# stays the runner user's (Emberline before 0.6.1 kept them beside the socket).
/usr/bin/rm -f -- "$SOCKET" "$RUN_DIR"/{browser-daemon.mjs,playwright-hook.cjs,browser.sock,browser-tabs.json,browser-tabs.json.tmp,agent-browser-events.jsonl}
/usr/bin/install -d -o node -g node -m 0755 "$RUN_DIR/browser"
/usr/bin/chown node:node "$RUN_DIR"
/usr/bin/chmod 0755 "$RUN_DIR"

# A simple command, not a function: `$!` is then ptyd itself (setpriv execs it), not a subshell.
HOME=/home/node "${AS_NODE[@]}" "${PTYD[@]}" &
ptyd=$!
# `docker stop` reaches this shell (docker-init passes signals to its child); ptyd shuts down itself.
trap 'kill -TERM "$ptyd" 2>/dev/null' TERM INT HUP

set +e
until [ -S "$SOCKET" ]; do
  if ! kill -0 "$ptyd" 2>/dev/null; then
    wait "$ptyd"
    exit $?
  fi
  /usr/bin/sleep 0.05
done
/usr/bin/chown root:root "$RUN_DIR" && /usr/bin/chmod 0755 "$RUN_DIR" || {
  echo "runner: could not lock ${RUN_DIR}; stopping" >&2
  kill -TERM "$ptyd"
  wait "$ptyd"
  exit 1
}

# A signal ends `wait` early (the trap passes it on): wait again until ptyd has exited.
while :; do
  wait "$ptyd"
  status=$?
  kill -0 "$ptyd" 2>/dev/null || exit "$status"
done

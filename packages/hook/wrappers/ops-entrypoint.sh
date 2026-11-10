#!/bin/bash
#
# The ops service's entrypoint (the runner image, `user: node` in the compose file). Its ptyd runs
# core's own commands (git with the hardening, the Docker CLI, probes) as node, so files it writes in
# /workspaces are owned as the agents' are. Agents have no process in this container and cannot reach
# its socket (the ops-socket volume, mounted only by core and ops). It keeps no session logs.
#
# Only the image's own binaries, by path (see runner-entrypoint.sh).
set -e

unset EMBERLINE_PTYD_LOG_DIR EMBERLINE_PTYD_DROP_TO EMBERLINE_PTYD_SERVICE_USERS EMBERLINE_PTYD_REQUIRE_ISOLATION
export EMBERLINE_PTYD_MODE=ops EMBERLINE_PTYD_SOCKET=/run/emberline-ops/ptyd.sock
PTYD=(/usr/local/bin/node /opt/emberline/ptyd/dist/main.js)

if [ "$EUID" = 0 ]; then
  # Started without `user: node`: everything ops starts would be root's. Run as node, with no
  # capabilities, as the compose file means it to.
  echo "ops: started as root; running as node (set \`user: node\` for the ops service)" >&2
  HOME=/home/node exec /usr/bin/setpriv --reuid=node --regid=node --init-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "${PTYD[@]}"
fi
exec "${PTYD[@]}"

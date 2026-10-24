#!/bin/bash
#
# The runner's healthcheck. Healthy only once ptyd listens and its socket's directory is locked: a
# real directory of root's (0755), with a socket (not a link) at the path. Core waits for this before
# it starts. Only the image's own binaries, by path, and bash's builtins (see runner-entrypoint.sh).
# A runner started as another user cannot be locked: it is healthy once ptyd listens, and Emberline
# then says it is not secured and starts nothing in it.
SOCKET="${EMBERLINE_PTYD_SOCKET:-/run/emberline/ptyd.sock}"
RUN_DIR="${SOCKET%/*}"
[ -S "$SOCKET" ] && [ ! -L "$SOCKET" ] || exit 1
[ "$EUID" != 0 ] && exit 0
[ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ] && [ "$(/usr/bin/stat -c '%u %a' -- "$RUN_DIR")" = "0 755" ]

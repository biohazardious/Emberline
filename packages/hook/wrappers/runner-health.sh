#!/bin/bash
#
# The healthcheck of the runner, and with `ops` of the ops service (same image).
#
# Runner: healthy once ptyd answers on its socket and says it is secured (it runs as its own user and
# its drop to the agents' user works); core waits for this before it starts. The healthcheck runs as
# root, so it may connect. A runner started as another user (`user:` in a compose file) cannot be
# secured: it is healthy once ptyd answers, and Emberline then says it is not secured and starts
# nothing in it.
# Ops: healthy once its ptyd answers.
#
# Only the image's own binaries, by path, and bash's builtins (see runner-entrypoint.sh); started from
# `/`, never from a directory agents can write.
cd / || exit 1
if [ "${1:-}" = ops ]; then
  SOCKET=/run/emberline-ops/ptyd.sock
  NEED_SECURED=0
else
  SOCKET=/run/emberline/ptyd/ptyd.sock
  NEED_SECURED=$([ "$EUID" = 0 ] && echo 1 || echo 0)
fi
[ -S "$SOCKET" ] && [ ! -L "$SOCKET" ] || exit 1
exec /usr/local/bin/node --input-type=module -e '
  setTimeout(() => process.exit(1), 2500).unref();
  const { PtydClient } = await import("/opt/emberline/ptyd/dist/client.js");
  const [socket, needSecured] = process.argv.slice(1);
  const client = await PtydClient.connect(socket);
  const hello = await client.hello();
  client.close();
  process.exit(needSecured !== "1" || hello.secured === true ? 0 : 1);
' "$SOCKET" "$NEED_SECURED"

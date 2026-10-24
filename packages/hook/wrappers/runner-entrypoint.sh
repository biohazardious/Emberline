#!/bin/bash
set -e

# Only the image's own binaries, by path: the runner's PATH starts with /opt/ai-tools/bin (the
# runner-tools volume, which agents can write), and ptyd must never be a planted `node`.
TOOLS_DIR="${EMBERLINE_TOOLS_DIR:-/opt/ai-tools}"
/usr/bin/mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true

exec /usr/local/bin/node /opt/emberline/ptyd/dist/main.js

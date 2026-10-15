#!/usr/bin/env bash
set -e

TOOLS_DIR="${EMBERLINE_TOOLS_DIR:-/opt/ai-tools}"
mkdir -p "${TOOLS_DIR}/bin" "${TOOLS_DIR}/npm/bin" "${TOOLS_DIR}/ npm/lib" "${TOOLS_DIR}/pipx" 2>/dev/null || true
rm -rf "${TOOLS_DIR}/ npm" 2>/dev/null || true
mkdir -p "${TOOLS_DIR}/npm/lib" 2>/dev/null || true

exec node /opt/emberline/ptyd/dist/main.js

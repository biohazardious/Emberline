# Emberline images. Everything (dev, test, build, run) happens in containers;
# the host only needs Docker.
#
# Architecture:
#   - Base OS: Ubuntu 26.04 LTS (Resolute Raccoon) + Node.js 24 LTS
#   - Zero hardcoded AI CLIs in the image. All AI agent CLIs (Claude Code,
#     Google Antigravity, Gemini CLI, OpenAI Codex, GitHub Copilot, Aider, etc.)
#     are dynamically installed and updated at runtime inside the persistent
#     `runner-tools` volume (/opt/ai-tools) via the UI Toolchain Manager or
#     automatic startup bootstrap.
#
# Targets:
#   dev     toolbox used by compose.dev.yaml (source bind-mounted, deps in volumes)
#   check   lint + typecheck + test inside the build (used by CI: `make ci`)
#   core    production core (API + static web UI)
#   runner  generic Ubuntu 26.04 LTS runner (ptyd + emberline-hook + /opt/ai-tools volume)

ARG UBUNTU_VERSION=26.04
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.15.0

# ---------------------------------------------------------------------------
# node_dist: Official Node.js 24 LTS binary distribution
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS node_dist

# ---------------------------------------------------------------------------
# ubuntu_node: Ubuntu 26.04 LTS + Node.js 24 LTS + UID 1000 `node` user
# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS ubuntu_node
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node_dist /usr/local /usr/local
RUN groupmod -n node ubuntu \
  && usermod -l node -d /home/node -m ubuntu \
  && mkdir -p /home/node /opt/ai-tools/bin /opt/ai-tools/npm/bin /opt/ai-tools/npm/lib /opt/ai-tools/pipx \
  && chown -R node:node /home/node /opt/ai-tools

# ---------------------------------------------------------------------------
# base: Node 24 LTS + pnpm + native C++ toolchain (node-pty & better-sqlite3)
# ---------------------------------------------------------------------------
FROM ubuntu_node AS base
ARG PNPM_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates bash curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION}
# Keep the pnpm store at a fixed path so it can be a volume / cache mount.
ENV npm_config_store_dir=/pnpm-store

# ---------------------------------------------------------------------------
# dev: source is bind-mounted at /workspace; every node_modules dir is a named
# volume (see compose.dev.yaml) so nothing is installed on the host.
# The directories are pre-created here so the volumes inherit `node` ownership.
# ---------------------------------------------------------------------------
FROM base AS dev
RUN mkdir -p /pnpm-store /run/emberline /data /workspaces \
    /workspace/node_modules \
    /workspace/apps/core/node_modules \
    /workspace/apps/web/node_modules \
    /workspace/apps/ptyd/node_modules \
    /workspace/packages/protocol/node_modules \
    /workspace/packages/adapter-sdk/node_modules \
    /workspace/packages/adapter-claude/node_modules \
    /workspace/packages/hook/node_modules \
  && chown -R node:node /pnpm-store /run/emberline /data /workspaces /workspace
USER node
WORKDIR /workspace
CMD ["bash"]

# ---------------------------------------------------------------------------
# build: install from the lockfile, compile everything, produce pruned bundles
# ---------------------------------------------------------------------------
FROM base AS build
ENV CI=true
WORKDIR /src
# Manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/web/package.json apps/web/
COPY apps/ptyd/package.json apps/ptyd/
COPY packages/protocol/package.json packages/protocol/
COPY packages/adapter-sdk/package.json packages/adapter-sdk/
COPY packages/adapter-claude/package.json packages/adapter-claude/
COPY packages/hook/package.json packages/hook/
RUN --mount=type=cache,id=emberline-pnpm,target=/pnpm-store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN --mount=type=cache,id=emberline-pnpm,target=/pnpm-store \
  pnpm --filter @emberline/core deploy --prod --legacy /out/core \
  && pnpm --filter @emberline/ptyd deploy --prod --legacy /out/ptyd \
  && pnpm --filter @emberline/hook deploy --prod --legacy /out/hook

# ---------------------------------------------------------------------------
# check: CI gate
# ---------------------------------------------------------------------------
FROM build AS check
RUN pnpm lint && pnpm typecheck && pnpm test

# ---------------------------------------------------------------------------
# runtime base (Ubuntu 26.04 LTS + Node 24 LTS + shared tool paths)
# ---------------------------------------------------------------------------
FROM ubuntu_node AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client python3 python3-venv pipx make curl bash \
  && rm -rf /var/lib/apt/lists/*
ENV EMBERLINE_TOOLS_DIR=/opt/ai-tools \
    NPM_CONFIG_PREFIX=/opt/ai-tools/npm \
    PIPX_HOME=/opt/ai-tools/pipx \
    PIPX_BIN_DIR=/opt/ai-tools/bin \
    PATH="/opt/emberline/wrappers:/opt/ai-tools/bin:/opt/ai-tools/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------
FROM runtime AS core
# Core never executes anything from /opt/ai-tools: the runner (and its agents) can write that
# volume, while core holds the database, tokens and API keys. System paths only.
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NPM_CONFIG_PREFIX=/usr/local
ENV NODE_ENV=production \
    EMBERLINE_HOST=0.0.0.0 \
    EMBERLINE_PORT=7420 \
    EMBERLINE_WEB_DIR=/app/public \
    EMBERLINE_DATA_DIR=/data \
    EMBERLINE_PTYD_SOCKET=/run/emberline/ptyd.sock
WORKDIR /app
COPY --from=build --chown=node:node /out/core ./
COPY --from=build --chown=node:node /src/apps/web/dist ./public
RUN mkdir -p /run/emberline /data /workspaces /opt/ai-tools \
  && chown -R node:node /run/emberline /data /workspaces /opt/ai-tools
USER node
EXPOSE 7420
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7420/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# runner: Generic Ubuntu 26.04 LTS developer environment.
# AI CLIs are installed dynamically into the persistent /opt/ai-tools volume.
# ---------------------------------------------------------------------------
FROM runtime AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash less procps openssh-client \
    build-essential pkg-config cmake \
    golang-go rustc cargo \
    python3-pip python3-venv python3-pytest pipx \
    ripgrep fd-find sqlite3 curl wget jq zip unzip xz-utils \
  && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb \
  && ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium \
  && rm -rf /var/lib/apt/lists/*
# Headless browser MCP server wired by adapter-claude (`playwright-mcp`). Installed into /usr/local,
# not the runner-tools volume, so it is versioned with the image and cannot be shadowed by a stale volume.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
RUN npm install -g --prefix /usr/local --no-fund --no-audit @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && test -x /usr/local/bin/playwright-mcp
ENV SHELL=/bin/bash \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    EMBERLINE_PTYD_SOCKET=/run/emberline/ptyd.sock \
    EMBERLINE_PTYD_LOG_DIR=/var/log/emberline
COPY --from=build /out/ptyd /opt/emberline/ptyd
COPY --from=build /out/hook /opt/emberline/hook
RUN chmod +x /opt/emberline/hook/dist/main.js \
  && ln -sf /opt/emberline/hook/dist/main.js /usr/local/bin/emberline-hook \
  && mkdir -p /opt/emberline/wrappers \
  && cp /opt/emberline/hook/wrappers/* /opt/emberline/wrappers/ \
  && chmod +x /opt/emberline/wrappers/* \
  && ln -sf /opt/emberline/wrappers/agy /opt/emberline/wrappers/antigravity \
  && mkdir -p /run/emberline /var/log/emberline /workspaces /opt/ai-tools/bin /opt/ai-tools/npm/bin /opt/ai-tools/pipx \
  && chown -R node:node /run/emberline /var/log/emberline /workspaces /opt/ai-tools
USER node
WORKDIR /workspaces
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD test -S /run/emberline/ptyd.sock
CMD ["/opt/emberline/wrappers/runner-entrypoint.sh"]

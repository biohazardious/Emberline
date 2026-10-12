# syntax=docker/dockerfile:1.7
#
# Emberline images. Everything (dev, test, build, run) happens in containers;
# the host only needs Docker.
#
# Targets:
#   dev     toolbox used by compose.dev.yaml (source bind-mounted, deps in volumes)
#   check   lint + typecheck + test inside the build (used by CI: `make ci`)
#   core    production core (API + static web UI)
#   runner  production runner (ptyd + pinned Claude Code CLI + emberline-hook)

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.15.0

# ---------------------------------------------------------------------------
# base: Node + pnpm + native toolchain (node-pty is compiled from source)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates bash \
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
# runtime base (no compilers)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------
FROM runtime AS core
ENV NODE_ENV=production \
    EMBERLINE_HOST=0.0.0.0 \
    EMBERLINE_PORT=7420 \
    EMBERLINE_WEB_DIR=/app/public \
    EMBERLINE_DATA_DIR=/data \
    EMBERLINE_PTYD_SOCKET=/run/emberline/ptyd.sock
WORKDIR /app
COPY --from=build --chown=node:node /out/core ./
COPY --from=build --chown=node:node /src/apps/web/dist ./public
RUN mkdir -p /run/emberline /data /workspaces && chown node:node /run/emberline /data /workspaces
USER node
EXPOSE 7420
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7420/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# runner: hosts agent sessions. Restarted rarely; core can restart freely.
# ---------------------------------------------------------------------------
FROM runtime AS runner
# Pinned on purpose (PROJECT.md §3.4). Bump via .env / build arg after a canary run.
ARG CLAUDE_CODE_VERSION=2.1.296
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash less procps openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1 \
    SHELL=/bin/bash \
    EMBERLINE_PTYD_SOCKET=/run/emberline/ptyd.sock \
    EMBERLINE_PTYD_LOG_DIR=/var/log/emberline
COPY --from=build /out/ptyd /opt/emberline/ptyd
COPY --from=build /out/hook /opt/emberline/hook
RUN chmod +x /opt/emberline/hook/dist/main.js \
  && ln -s /opt/emberline/hook/dist/main.js /usr/local/bin/emberline-hook \
  && mkdir -p /run/emberline /var/log/emberline /workspaces \
  && chown node:node /run/emberline /var/log/emberline /workspaces
USER node
WORKDIR /workspaces
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD test -S /run/emberline/ptyd.sock
CMD ["node", "/opt/emberline/ptyd/dist/main.js"]

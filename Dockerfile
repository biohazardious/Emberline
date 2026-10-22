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
#   runner  generic Ubuntu 26.04 LTS runner (ptyd + emberline-hook + emberline-mcp + /opt/ai-tools volume)

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
# apt: retry flaky mirrors (Launchpad answered 503s) and never wait forever on a dead connection.
RUN printf '%s\n' 'Acquire::Retries "5";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
    > /etc/apt/apt.conf.d/80-emberline-retries

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
FROM ubuntu_node AS core
# Core holds the database, tokens and API keys and executes nothing from a workspace: git, builds,
# tests and agent CLIs all run in the runner via ptyd (apps/core/src/command-exec.ts).
# With a forge account the runner's git goes through core's git gateway (/api/internal/git/), which adds the
# token and streams the data; of a push it reads only the command list (branch and commit), and core
# still runs no git and parses no git objects. So the image
# carries no git, ssh, compilers or language toolchains, and nothing from /opt/ai-tools is on PATH.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    EMBERLINE_TOOLS_DIR=/opt/ai-tools
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
# Besides the usual toolchains: xvfb for desktop apps without a display (Electron, Tauri, Flutter),
# webkit2gtk/GTK/clang/ninja for Tauri and Flutter Linux builds, and the runtime libraries of
# Espressif's ESP32 QEMU (`emberline-sdk install esp-qemu`). Agents have no root to add these later.
#
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    bash less procps openssh-client \
    build-essential pkg-config cmake \
    golang-go rustc cargo \
    python3-pip python3-venv python3-pytest pipx \
    ripgrep fd-find sqlite3 wget jq zip unzip xz-utils \
    xvfb xauth \
    libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev libdbus-1-dev libxdo-dev file \
    clang ninja-build libgtk-3-dev \
    libsdl2-2.0-0 libslirp0 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
# Chromium (open source, not Google Chrome) for the agents' headless browser. Ubuntu ships it only as a
# snap (cannot run in a container), so it comes from the xtradeb PPA; apt pinning takes nothing else from
# it. When Launchpad fails after retries, Playwright's pinned Chromium build (Chrome for Testing, checksum
# taken at pin time) is used instead. CHROMIUM_SOURCE=ppa|playwright forces one source (to test each path).
# The build cache keeps whichever source won until this layer is rebuilt.
ARG XTRADEB_SIGNER_FINGERPRINT=5301FA4FD93244FBC6F6149982BB6851C64F6880
ARG CHROMIUM_SOURCE=auto
ARG PLAYWRIGHT_CHROMIUM_VERSION=155.0.8059.12
ARG PLAYWRIGHT_CHROMIUM_SHA256_AMD64=a24546e0e6c763bf864861ce50498f38783663e24cd2af2a16798c25dc3a9489
ARG PLAYWRIGHT_CHROMIUM_SHA256_ARM64=bf94336ee2e3edb1279da28a74a744958ba10741e5994351610bc19028482b0b
RUN set -eu; \
  case "$CHROMIUM_SOURCE" in auto|ppa|playwright) ;; *) echo "CHROMIUM_SOURCE must be auto, ppa or playwright" >&2; exit 1 ;; esac; \
  retry() { n=1; until "$@"; do \
      [ "$n" -ge 4 ] && return 1; \
      echo "chromium: attempt $n of 4 failed, retrying in $((n * 20))s" >&2; sleep $((n * 20)); n=$((n + 1)); \
    done; }; \
  drop_chromium() { apt-get purge -y chromium chromium-common chromium-sandbox chromium-l10n >/dev/null 2>&1 || true; }; \
  real_chromium() { \
    v="$(dpkg-query -W -f='${Version}' chromium 2>/dev/null)" || return 1; \
    case "$v" in *snap*) echo "chromium: $v is Ubuntu's snap stub, not the PPA build" >&2; return 1 ;; esac; \
    chromium --version 2>/dev/null | grep -Eq '^Chromium [0-9]+\.'; }; \
  ppa_attempt() { \
    drop_chromium; \
    curl -fsSL --connect-timeout 20 --max-time 120 \
      "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${XTRADEB_SIGNER_FINGERPRINT}" \
      -o /usr/share/keyrings/xtradeb-apps.asc \
    && apt-get update --error-on=any \
    && apt-get install -y --no-install-recommends chromium \
    && real_chromium; }; \
  playwright_install() { \
    rm -f /etc/apt/sources.list.d/xtradeb-apps.sources /etc/apt/preferences.d/xtradeb-chromium; drop_chromium; \
    case "$(dpkg --print-architecture)" in \
      amd64) plat=linux64; sha="$PLAYWRIGHT_CHROMIUM_SHA256_AMD64" ;; \
      arm64) plat=linux-arm64; sha="$PLAYWRIGHT_CHROMIUM_SHA256_ARM64" ;; \
      *) echo "no Playwright Chromium for $(dpkg --print-architecture)" >&2; return 1 ;; \
    esac; \
    [ -n "$sha" ] || { echo "chromium: no pinned sha256 for chrome-$plat.zip" >&2; return 1; }; \
    retry apt-get update || return 1; \
    apt-get install -y --no-install-recommends unzip libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 libdbus-1-3 \
      libglib2.0-0t64 libx11-6 libxcb1 libxext6 || { echo "chromium: installing the runtime libraries failed" >&2; return 1; }; \
    tmp="$(mktemp -d)" || { echo "chromium: mktemp failed" >&2; return 1; }; \
    curl -fsSL --proto '=https' --proto-redir '=https' --retry 5 --retry-all-errors --connect-timeout 20 --max-time 900 -o "$tmp/chrome.zip" \
      "https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/${plat}/chrome-${plat}.zip" \
      || { echo "chromium: downloading chrome-${plat}.zip failed" >&2; return 1; }; \
    echo "$sha  $tmp/chrome.zip" | sha256sum -c - || { echo "chromium: sha256 mismatch for chrome-${plat}.zip" >&2; return 1; }; \
    rm -rf /opt/chromium && mkdir -p /opt/chromium && unzip -q "$tmp/chrome.zip" -d /opt/chromium \
      || { echo "chromium: unpacking chrome-${plat}.zip failed" >&2; return 1; }; \
    rm -rf "$tmp"; \
    ln -sf "/opt/chromium/chrome-${plat}/chrome" /usr/bin/chromium || return 1; \
    if ldd "/opt/chromium/chrome-${plat}/chrome" | grep 'not found' >&2; then echo "chromium: missing shared libraries (see above)" >&2; return 1; fi; }; \
  src=; \
  if [ "$CHROMIUM_SOURCE" != playwright ]; then \
    . /etc/os-release; \
    printf 'Types: deb\nURIs: https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu\nSuites: %s\nComponents: main\nSigned-By: /usr/share/keyrings/xtradeb-apps.asc\n' "$VERSION_CODENAME" \
      > /etc/apt/sources.list.d/xtradeb-apps.sources; \
    printf 'Package: *\nPin: release o=LP-PPA-xtradeb-apps\nPin-Priority: -1\n\nPackage: chromium chromium-common chromium-sandbox chromium-l10n\nPin: release o=LP-PPA-xtradeb-apps\nPin-Priority: 700\n' \
      > /etc/apt/preferences.d/xtradeb-chromium; \
    if retry ppa_attempt; then src=ppa; \
    elif [ "$CHROMIUM_SOURCE" = ppa ]; then echo "chromium: the PPA failed 4 times (CHROMIUM_SOURCE=ppa)" >&2; exit 1; \
    else echo "chromium: the PPA failed 4 times; using Playwright's pinned build" >&2; fi; \
  fi; \
  if [ -z "$src" ]; then playwright_install || exit 1; src=playwright; fi; \
  mkdir -p /opt/emberline && echo "$src" > /opt/emberline/chromium-source; \
  rm -rf /var/lib/apt/lists/*; \
  echo "chromium source: $src"; \
  chromium --version
# Headless browser MCP server wired by adapter-claude (`playwright-mcp`). Installed into /usr/local,
# not the runner-tools volume, so it is versioned with the image and cannot be shadowed by a stale volume.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
RUN npm install -g --prefix /usr/local --no-fund --no-audit @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && test -x /usr/local/bin/playwright-mcp
# Docker CLI with the compose and buildx plugins, for the isolated engine (compose service
# `docker`, on by default). The runner has no daemon and never sees the host's socket: core sets
# DOCKER_HOST per run while the sidecar answers. Static binaries at exact versions; change a version together with its
# checksums (docker/compose and docker/buildx publish theirs; the CLI tarball's were taken at pin time).
# Compose >= 2.24 is required for `!override` (compose previews); compose v5 builds through buildx.
ARG DOCKER_CLI_VERSION=29.8.2
ARG DOCKER_COMPOSE_VERSION=5.6.0
ARG DOCKER_BUILDX_VERSION=0.37.2
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x86_64; goarch=amd64; \
      cli_sha=995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f; \
      compose_sha=40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a; \
      buildx_sha=982ca20490b45ed1ec8d99795974d3d874a358f75938c9c237305010e6b7e548 ;; \
    arm64) arch=aarch64; goarch=arm64; \
      cli_sha=76a624e4a8e5da654d1150e808175125efb5a6f1b6aa1cbd9caee18f51047a50; \
      compose_sha=733ec76717ceb59052a9609b9dadfb523b2df8eab57a54212872d10a58078ea2; \
      buildx_sha=efa38cb7aa7db2dbb9ad049b00b0a9737f66f033626177b5a4e845184ad7ab29 ;; \
    *) echo "no pinned Docker CLI for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  tmp="$(mktemp -d)"; \
  curl -fsSL -o "$tmp/docker.tgz" "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
  curl -fsSL -o "$tmp/docker-compose" "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${arch}"; \
  curl -fsSL -o "$tmp/docker-buildx" "https://github.com/docker/buildx/releases/download/v${DOCKER_BUILDX_VERSION}/buildx-v${DOCKER_BUILDX_VERSION}.linux-${goarch}"; \
  printf '%s  %s\n' "$cli_sha" "$tmp/docker.tgz" "$compose_sha" "$tmp/docker-compose" "$buildx_sha" "$tmp/docker-buildx" | sha256sum -c -; \
  tar -xzf "$tmp/docker.tgz" -C "$tmp" docker/docker; \
  install -m 0755 "$tmp/docker/docker" /usr/local/bin/docker; \
  install -d /usr/local/lib/docker/cli-plugins; \
  install -m 0755 "$tmp/docker-compose" "$tmp/docker-buildx" /usr/local/lib/docker/cli-plugins/; \
  rm -rf "$tmp"; \
  docker --version; docker compose version; docker buildx version
# SDKs that `emberline-sdk` installs into the runner-tools volume, at fixed paths.
ENV JAVA_HOME=/opt/ai-tools/sdk/jdk \
    ANDROID_HOME=/opt/ai-tools/sdk/android \
    ANDROID_SDK_ROOT=/opt/ai-tools/sdk/android \
    PATH="/opt/emberline/wrappers:/opt/ai-tools/bin:/opt/ai-tools/npm/bin:/opt/ai-tools/sdk/jdk/bin:/opt/ai-tools/sdk/android/cmdline-tools/latest/bin:/opt/ai-tools/sdk/android/platform-tools:/opt/ai-tools/sdk/flutter/bin:/opt/ai-tools/sdk/esp-qemu/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV SHELL=/bin/bash \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    EMBERLINE_PTYD_SOCKET=/run/emberline/ptyd.sock \
    EMBERLINE_PTYD_LOG_DIR=/var/log/emberline
COPY --from=build /out/ptyd /opt/emberline/ptyd
COPY --from=build /out/hook /opt/emberline/hook
RUN chmod +x /opt/emberline/hook/dist/main.js /opt/emberline/hook/dist/mcp.js \
  && ln -sf /opt/emberline/hook/dist/main.js /usr/local/bin/emberline-hook \
  && ln -sf /opt/emberline/hook/dist/mcp.js /usr/local/bin/emberline-mcp \
  && mkdir -p /opt/emberline/wrappers \
  && cp /opt/emberline/hook/wrappers/* /opt/emberline/wrappers/ \
  && chmod +x /opt/emberline/wrappers/* \
  && ln -sf /opt/emberline/wrappers/agy /opt/emberline/wrappers/antigravity \
  && mkdir -p /run/emberline /var/log/emberline /workspaces /opt/ai-tools/bin /opt/ai-tools/npm/bin /opt/ai-tools/pipx /opt/ai-tools/sdk \
  && chown -R node:node /run/emberline /var/log/emberline /workspaces /opt/ai-tools
USER node
WORKDIR /workspaces
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD test -S /run/emberline/ptyd.sock
CMD ["/opt/emberline/wrappers/runner-entrypoint.sh"]

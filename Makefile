# Emberline task runner. The host only needs Docker (+ make).
DEV  := docker compose -f compose.dev.yaml
PROD := docker compose
E2E  := docker compose -p emberline-e2e -f compose.yaml -f e2e/compose.e2e.yaml
RUN  := $(DEV) run --rm tools

.DEFAULT_GOAL := help
.PHONY: help dev dev-down install lock shell test lint typecheck build format check attach db-generate ci e2e backup reset-password up down logs upgrade-core claude-login clean

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

# --- development -----------------------------------------------------------

dev: ## Start ptyd + core + web dev servers (http://localhost:5173)
	$(DEV) up --build ptyd core web

dev-down: ## Stop dev servers
	$(DEV) down

install: ## Install deps from the lockfile into the dev volumes
	$(DEV) run --rm install

lock: ## Update pnpm-lock.yaml after editing a package.json
	$(DEV) run --rm install pnpm install --no-frozen-lockfile

shell: ## Shell inside the dev toolbox
	$(RUN) bash

test lint typecheck build format: ## Run the pnpm script of the same name
	$(RUN) pnpm $@

check: ## format check + lint + typecheck + test + build
	$(RUN) sh -c "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"

db-generate: ## Generate a Drizzle migration after editing apps/core/src/db/schema.ts
	$(RUN) pnpm --filter @emberline/core db:generate

attach: ## Interactive shell inside the dev ptyd (Ctrl-] detaches)
	$(DEV) exec ptyd pnpm --filter @emberline/ptyd attach

ci: ## CI gate: lint/typecheck/test inside an image build
	docker build --target check -t emberline/check:local .

e2e: ## End-to-end smoke test on an isolated core + runner stack (port 7498, removed afterwards)
	@set -e; ws=$$(mktemp -d); chmod 777 $$ws; \
	export EMBERLINE_WORKSPACES_HOST_DIR=$$ws; \
	if [ -z "$(E2E_PREBUILT)" ]; then \
	  docker build -q --target core -t emberline/core:e2e . >/dev/null; \
	  docker build -q --target runner -t emberline/runner:e2e . >/dev/null; \
	fi; \
	$(E2E) up -d --wait; \
	status=0; docker run --rm --network emberline-e2e_default -v "$$PWD/e2e:/e2e:ro" emberline/core:e2e \
	  node /e2e/smoke.mjs http://core:7420 || status=$$?; \
	[ $$status -eq 0 ] || $(E2E) logs --tail 80; \
	$(E2E) down -v >/dev/null 2>&1; rm -rf $$ws 2>/dev/null || true; exit $$status

# --- production stack ------------------------------------------------------

up: ## Build and start core + runner + the Docker engine (off with EMBERLINE_DOCKER_ENGINE=0 in .env)
	$(PROD) up -d --build

down: ## Stop core + runner + the Docker engine
	$(PROD) down

logs: ## Follow logs
	$(PROD) logs -f

upgrade-core: ## Rebuild/restart core only (and create a missing Docker engine); agents keep running. Not enough when the release notes say so (0.6.1 does): use `make up`
	@[ -n "$$($(PROD) ps -aq docker)" ] || $(PROD) up -d --no-deps docker
	$(PROD) up -d --build --no-deps core

reset-password: ## Forgot the admin password: clear it, restart core, then use the setup token from the log
	$(PROD) exec -T core node dist/reset-password.js
	$(PROD) up -d --no-deps --force-recreate core
	@sleep 5; $(PROD) logs core 2>&1 | grep -o 'First-run setup token: [^ ]*' | tail -1

backup: ## Consistent SQLite snapshot (VACUUM INTO) in the data volume, copied to ./backups/
	@set -e; file=$$($(PROD) exec -T core node dist/backup.js); \
	mkdir -p backups; $(PROD) cp "core:$$file" "backups/$$(basename $$file)"; \
	echo "backup: backups/$$(basename $$file) (also kept in the data volume)"

claude-login: ## One-time `claude login` inside the runner (Anthropic OAuth credentials)
	$(PROD) exec -u node runner claude login

gemini-login: ## Google login (Code Assist Standard/Enterprise only) via `gemini` inside the runner
	$(PROD) exec -u node runner gemini

agy-login: ## Interactive Antigravity / Google OAuth login (`agy login`) inside the runner
	$(PROD) exec -u node runner agy login

codex-login: ## Interactive OpenAI ChatGPT/Codex OAuth login (`codex login`) inside the runner
	$(PROD) exec -u node runner codex login

copilot-login: ## Interactive GitHub Copilot CLI login (`copilot login`) inside the runner
	$(PROD) exec -u node runner copilot login

clean: ## Remove dev containers and volumes (node_modules, pnpm store)
	$(DEV) down -v --remove-orphans

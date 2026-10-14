# Emberline task runner. The host only needs Docker (+ make).
DEV  := docker compose -f compose.dev.yaml
PROD := docker compose
RUN  := $(DEV) run --rm tools

.DEFAULT_GOAL := help
.PHONY: help dev dev-down install lock shell test lint typecheck build format check attach db-generate ci up down logs upgrade-core claude-login clean

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

check: ## lint + typecheck + test + build
	$(RUN) sh -c "pnpm lint && pnpm typecheck && pnpm test && pnpm build"

db-generate: ## Generate a Drizzle migration after editing apps/core/src/db/schema.ts
	$(RUN) pnpm --filter @emberline/core db:generate

attach: ## Interactive shell inside the dev ptyd (Ctrl-] detaches)
	$(DEV) exec ptyd pnpm --filter @emberline/ptyd attach

ci: ## CI gate: lint/typecheck/test inside an image build
	docker build --target check -t emberline/check:local .

# --- production stack ------------------------------------------------------

up: ## Build and start core + runner
	$(PROD) up -d --build

down: ## Stop core + runner
	$(PROD) down

logs: ## Follow logs
	$(PROD) logs -f

upgrade-core: ## Rebuild/restart core only; running agents in the runner are untouched
	$(PROD) up -d --build --no-deps core

claude-login: ## One-time `claude login` inside the runner (Anthropic OAuth credentials)
	$(PROD) exec runner claude login

gemini-login: ## Interactive Google OAuth login (`gemini`) inside the runner (no API key needed)
	$(PROD) exec runner gemini

agy-login: ## Interactive Antigravity / Google OAuth login (`agy login`) inside the runner
	$(PROD) exec runner agy login

codex-login: ## Interactive OpenAI ChatGPT/Codex OAuth login (`codex login`) inside the runner
	$(PROD) exec runner codex login

copilot-login: ## Interactive GitHub Copilot CLI login (`copilot login`) inside the runner
	$(PROD) exec runner copilot login

clean: ## Remove dev containers and volumes (node_modules, pnpm store)
	$(DEV) down -v --remove-orphans

.PHONY: help setup up down restart build logs ps shell db-shell migrate generate clean

BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m

.DEFAULT_GOAL := help

help: ## Show this help message
	@echo "$(BLUE)TopupApi - Makefile Commands$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-16s$(NC) %s\n", $$1, $$2}'

setup: ## Create .env.production from .env.example (first run only)
	@if [ ! -f .env.production ]; then \
		cp .env.example .env.production; \
		echo "$(GREEN).env.production created.$(NC) Edit it, then 'make up'."; \
	else \
		echo ".env.production already exists."; \
	fi

up: setup ## Build + start everything in the background
	docker compose up -d --build

down: ## Stop everything (volume preserved)
	docker compose down

restart: ## Restart all services
	docker compose restart

build: ## Rebuild the app image (no cache)
	docker compose build --no-cache

logs: ## Tail logs from all services
	docker compose logs -f --tail=100

ps: ## Show service status
	docker compose ps

shell: ## Open a shell inside the running app container
	docker compose exec app sh

db-shell: ## Open a psql shell inside the running postgres container
	docker compose exec postgres psql -U $${POSTGRES_USER:-postgres} -d $${POSTGRES_DB:-topupApiDB}

migrate: ## Apply pending Prisma migrations against the running database
	docker compose exec app npx prisma migrate deploy

generate: ## Create a new Prisma migration from schema changes (local dev only)
	npx prisma migrate dev

clean: ## Stop everything and DELETE the database volume
	docker compose down -v

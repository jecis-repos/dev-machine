import { writeFile } from "node:fs/promises";
import { loadRegistry } from "./registry.js";
import { BASE_DIR, DOMAIN_SUFFIX, HOSTS_UPDATE_ENABLED, MAKEFILE_PATH, PROJECT_SUBDIR, instanceHostname } from "../config.js";
import type { Instance } from "../types.js";

export function instanceTargets(inst: Instance): string {
  const p = inst.prefix;
  const label = inst.display_name;
  const dir = `${BASE_DIR}/${p}`;
  return `
# --- ${label} (${p}) ---

.PHONY: ${p}-shell ${p}-logs ${p}-composer ${p}-artisan ${p}-migrate ${p}-seed ${p}-fresh ${p}-optimize ${p}-test ${p}-npm ${p}-vite ${p}-restore ${p}-dump

${p}-shell: ## Shell into ${label} container
\t$(DC) exec $(${p.toUpperCase()}) bash

${p}-logs: ## Tail ${label} app logs
\t$(DC) logs -f $(${p.toUpperCase()})

${p}-composer: ## Install ${label} composer deps
\t$(DC) exec $(${p.toUpperCase()}) composer install --no-interaction

${p}-artisan: ## Run artisan command in ${label} (usage: make ${p}-artisan cmd="migrate")
\t$(DC) exec $(${p.toUpperCase()}) php artisan $(cmd)

${p}-migrate: ## Run ${label} migrations
\t$(DC) exec $(${p.toUpperCase()}) php artisan migrate --force

${p}-seed: ## Seed ${label} database
\t$(DC) exec $(${p.toUpperCase()}) php artisan db:seed

${p}-fresh: ## Fresh migrate + seed ${label}
\t$(DC) exec $(${p.toUpperCase()}) php artisan migrate:fresh --seed

${p}-optimize: ## Cache views, routes, config for ${label}
\t@$(foreach cmd,$(OPTIMIZE_CMDS),$(DC) exec --user sail $(${p.toUpperCase()}) php artisan $(cmd);)
\t@echo "${label} optimized."

${p}-test: ## Run ${label} tests
\t$(DC) exec $(${p.toUpperCase()}) php artisan test

${p}-npm: ## Install ${label} Node dependencies
\tcd ${dir}/${PROJECT_SUBDIR} && npm install

${p}-vite: ## Start ${label} Vite dev server (port ${inst.vite_port})
\tcd ${dir}/${PROJECT_SUBDIR} && npx vite --port ${inst.vite_port}

${p}-restore: ## Restore ${label} database from dump + create admin
\t@echo "Dropping and recreating ${inst.db_name}..."
\t$(DC) exec pgsql dropdb -U sail --if-exists ${inst.db_name}
\t$(DC) exec pgsql createdb -U sail ${inst.db_name}
\t@echo "Copying dump into container..."
\t$(DC) cp ${p}-db.dump pgsql:/tmp/${p}-db.dump
\t@echo "Restoring ${p}-db.dump (this may take a few minutes)..."
\t$(DC) exec pgsql pg_restore -U sail -d ${inst.db_name} --no-owner --no-acl -j 4 /tmp/${p}-db.dump
\t$(DC) exec pgsql rm /tmp/${p}-db.dump
\t@echo "Running pending migrations..."
\t$(DC) exec $(${p.toUpperCase()}) php artisan migrate --force
\t@echo "Creating admin user..."
\t$(DC) exec $(${p.toUpperCase()}) php artisan tinker --execute="$$(cat $(ADMIN_SCRIPT))"
\t@echo "${label} restore complete."

${p}-dump: ## Dump current ${label} database to ${p}-db.dump
\t$(DC) exec -T pgsql pg_dump -U sail -Fc -Z 6 ${inst.db_name} > ${p}-db.dump
\t@ls -lh ${p}-db.dump`;
}

export async function regenerateMakefile(): Promise<void> {
  const registry = await loadRegistry();
  const instances = registry.instances;

  const serviceVars = instances.map((i: Instance) => `${i.prefix.toUpperCase()} := ${i.prefix}-app`).join("\n");

  const allNames = instances.map((i: Instance) => i.prefix);
  const restoreAll = allNames.map((n: string) => `${n}-restore`).join(" ");
  const dumpAll = allNames.map((n: string) => `${n}-dump`).join(" ");
  const optimizeAll = allNames.map((n: string) => `${n}-optimize`).join(" ");
  const optimizeClearCmds = instances
    .map((i: Instance) => {
      const v = i.prefix.toUpperCase();
      return `\t$(DC) exec --user sail $(${v}) php artisan optimize:clear`;
    })
    .join("\n");

  const perInstance = instances.map(instanceTargets).join("\n");

  const hostnames = instances.map((i: Instance) => instanceHostname(i.prefix)).join(" ");
  const hostsCheck = instances[0]?.prefix ? instanceHostname(instances[0].prefix) : `app.${DOMAIN_SUFFIX}`;

  const hostsTarget = HOSTS_UPDATE_ENABLED
    ? `hosts: ## Add ${DOMAIN_SUFFIX} entries to /etc/hosts
\t@if ! grep -q "${hostsCheck}" /etc/hosts; then \\
\t\techo "127.0.0.1 ${hostnames}" | sudo tee -a /etc/hosts; \\
\t\techo "Added host entries to /etc/hosts"; \\
\telse \\
\t\techo "Hosts entries already exist"; \\
\tfi`
    : `hosts: ## Hosts update disabled
\t@echo "DEVMACHINE_DISABLE_HOSTS_UPDATE=true -> skipping /etc/hosts updates"`;

  const makefile = `.DEFAULT_GOAL := help
SHELL := /bin/bash

DC := docker compose
${serviceVars}

OPTIMIZE_CMDS := view:cache route:cache config:cache event:cache
ADMIN_SCRIPT := scripts/create-admin.php

# --- Lifecycle ---

.PHONY: up down build rebuild ps logs

up: ## Start all services
\t$(DC) up -d

down: ## Stop all services
\t$(DC) down

build: ## Build app image
\t$(DC) build ${instances[0]?.prefix ?? "app"}-app

rebuild: ## Force rebuild app image (no cache)
\t$(DC) build --no-cache ${instances[0]?.prefix ?? "app"}-app

ps: ## Show running containers
\t$(DC) ps

logs: ## Tail logs for all services
\t$(DC) logs -f
${perInstance}

# --- Aggregate Targets ---

.PHONY: restore-all dump-all optimize optimize-clear

restore-all: ${restoreAll} ## Restore all databases from dumps

dump-all: ${dumpAll} ## Dump all databases

optimize: ${optimizeAll} ## Optimize all projects

optimize-clear: ## Clear all caches on all projects
${optimizeClearCmds}
\t@echo "All caches cleared."

# --- Setup ---

.PHONY: certs hosts install fresh clean

certs: ## Generate mkcert TLS certificates
\tbash scripts/generate-certs.sh

${hostsTarget}

install: certs hosts build up ## Full first-time setup
\t@echo "Waiting for services to become healthy..."
\t@sleep 5
\t@echo "Installing Node dependencies..."
${instances.map((i: Instance) => `\tcd ${BASE_DIR}/${i.prefix}/${PROJECT_SUBDIR} && npm install`).join("\n")}
\t@echo "Installing PHP dependencies..."
${instances.map((i: Instance) => `\t$(DC) exec $(${i.prefix.toUpperCase()}) composer install --no-interaction`).join("\n")}
\t@echo "Generating APP_KEYs..."
${instances.map((i: Instance) => `\t$(DC) exec $(${i.prefix.toUpperCase()}) php artisan key:generate --force`).join("\n")}
\t@echo "Building frontend assets..."
${instances.map((i: Instance) => `\tcd ${BASE_DIR}/${i.prefix}/${PROJECT_SUBDIR} && npx vite build`).join("\n")}
\t@echo "Running migrations..."
${instances.map((i: Instance) => `\t$(DC) exec $(${i.prefix.toUpperCase()}) php artisan migrate --force`).join("\n")}
\t@echo ""
\t@echo "Setup complete! Start Vite dev servers in separate terminals:"
${instances.map((i: Instance) => `\t@echo "  make ${i.prefix}-vite   (port ${i.vite_port})"`).join("\n")}
\t@echo ""
\t@echo "Then open:"
${instances.map((i: Instance) => `\t@echo "  https://${instanceHostname(i.prefix)}"`).join("\n")}
\t@echo "  http://localhost:8026  (Mailpit)"

fresh: down ## Nuke everything and rebuild
\t$(DC) down -v
\t$(MAKE) install

clean: ## Remove volumes and built images
\t$(DC) down -v --rmi local

# --- Help ---

.PHONY: help

help: ## Show this help
\t@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \\
\t\tawk 'BEGIN {FS = ":.*?## "}; {printf "  \\033[36m%-16s\\033[0m %s\\n", $$1, $$2}'
`;

  await writeFile(MAKEFILE_PATH, makefile, "utf-8");
}

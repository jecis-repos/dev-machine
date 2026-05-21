# dev-machine

One-command multi-project local dev environment manager with a terminal UI dashboard.

Point it at a git repo, run `npm run tui`, and get a full-screen terminal dashboard that provisions, monitors, and manages Docker-based dev instances -- each with its own subdomain, database, and container stack.

## What it does

- **Spins up isolated dev instances from any git branch** -- each gets its own Docker container, PostgreSQL database, Redis store, Caddy reverse proxy entry, and local HTTPS subdomain.
- **Provides a real-time TUI dashboard** -- monitor CPU, memory, and disk usage; watch job queues execute; browse activity logs; and control instances without leaving the terminal.
- **Exposes an MCP server** for AI tool integration -- Claude and other LLM agents can create, update, inspect, and tear down dev environments programmatically.
- **Handles the entire lifecycle** -- from `git clone` through dependency install, database migration, and certificate generation to cleanup and backup/restore.

## Quick start

```bash
git clone https://github.com/jecis-repos/dev-machine.git
cd dev-machine
npm install
```

Create a `.env` file (or export environment variables) with your workspace path:

```bash
DEVMACHINE_BASE_DIR=/path/to/your/workspace
```

Launch the TUI:

```bash
npm run tui
```

On first launch, a setup wizard walks you through prerequisites (Docker, mkcert, git) and initial configuration.

### Running the HTTP MCP server

For AI tools / external services that prefer HTTP over stdio:

```bash
dev-machine --http=8730
# or: DEVMACHINE_HTTP_PORT=8730 dev-machine --http
```

The MCP endpoint is at `POST /mcp`; health check at `GET /healthz`. The host
defaults to `127.0.0.1` and can be overridden with `DEVMACHINE_HTTP_HOST`.

## TUI dashboard layout

The dashboard is a full-screen terminal interface split into distinct panels:

```
+---------------------+-------------------------------+
|   Docker Status     |      Project Instances        |
|   (container state, |   (table: name, branch,       |
|    resource usage)  |    status, URL, ports)        |
+---------------------+-------------------------------+
| Section Charts      |                               |
+---------------------+   Activity Log / Result /     |
| Jobs Queue          |   Monitor (tabbed)            |
+---------------------+                               |
| Instance Power      |   - Log: live action output   |
+---------------------+   - Result: structured output |
| Actions             |   - Monitor: CPU/mem/disk     |
| (by category)       |     sparklines, process list, |
|  > Dashboard        |     Docker container stats    |
|  > Setup & Tooling  |                               |
|  > Docker           +-------------------------------+
|  > GitHub           | Keys: Up/Down Tab Enter ...   |
|  > Build & Provision+-------------------------------+
|  > Laravel Controls |
|  > MCP Passthrough  |
|  > Backup & Restore |
+---------------------+
```

**Left column (45%):** Docker status overview, section performance charts, job queue, instance power controls, and the categorized action menu.

**Right column (55%):** Instance table at the top; tabbed activity area at the bottom with Log, Result, and Monitor views. The Monitor tab includes live sparkline graphs for CPU, memory, and disk, plus process and Docker container tables.

**Keyboard driven:** Navigate with arrow keys and Tab, run actions with Enter, toggle tabs with `[` / `]` or `1`-`3`, open AI Ops with `/`, manage instance power with `i`, view the job queue with `j`, search with `?`, copy logs with `y`, and quit with `q`.

## Features

### Instance management

- Create instances from any git branch with automatic naming, port allocation, and database provisioning
- Update instances by pulling latest code and re-running the full build pipeline (dependencies, migrations, asset compilation)
- Remove instances with full cleanup: stop containers, drop databases, remove Caddy entries, deregister, delete files
- Instance TTL support -- auto-expire after N hours
- Orphan detection and forced cleanup for stale resources
- Selective teardown -- optionally keep databases or files on removal

### Docker integration

- Generates and edits `docker-compose.yml` via AST manipulation (no string templating)
- Caddy reverse proxy with automatic HTTPS via mkcert certificates
- Per-instance PostgreSQL databases created through `init.sql` injection
- Per-instance Redis database index allocation
- Automatic port allocation for Vite dev servers
- Docker maintenance actions: prune, restart, rebuild, logs

### TUI dashboard

- Full-screen blessed-based terminal UI with mouse and keyboard support
- Categorized action menu with 8 categories (Dashboard, Setup, Docker, GitHub, Build, Laravel, MCP, Backup)
- Job queue with sequential execution, cancellation, and per-job log files
- Live activity log with scrollback (6000 lines), search, copy-to-clipboard, and export
- Result panel for structured command output
- Monitor tab with CPU/memory/disk sparklines, process table, and Docker container stats
- Section performance charts tracking action success rates and durations
- Instance power panel for quick start/stop/restart
- First-run wizard for guided setup
- Splash screen on launch
- AI Ops command palette -- describe what you want in natural language and get matched to available actions

### MCP server mode

10 tools exposed via the Model Context Protocol for AI agent integration:

| Tool | Description |
|------|-------------|
| `create-instance` | Provision a new environment from a git branch |
| `remove-instance` | Tear down an instance with full cleanup |
| `update-instance` | Pull latest code and re-run the build pipeline |
| `instance-health` | Run diagnostic checks (container, DB, Redis, HTTP) |
| `list-instances` | List all instances with status and resource info |
| `create-backup` | Snapshot workspace files and databases |
| `restore-backup` | Restore from a previous backup (selective) |
| `list-backups` | List available backups with IDs and sizes |
| `run-command` | Execute a validated CLI command inside a container |
| `view-logs` | Read Laravel, Docker, or audit logs |

### Build status page

While provisioning a new instance, the TUI displays real-time progress through the build pipeline: git clone, dependency install, database setup, migration, asset compilation, certificate generation, and Caddy configuration -- with clear success/failure indicators at each step.

## Configuration

All configuration is driven by environment variables with sensible defaults. No config file required.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVMACHINE_BASE_DIR` | Parent of module directory | Root workspace directory containing `docker-compose.yml` and `_docker/` |
| `DEVMACHINE_DOMAIN_SUFFIX` | `app.test` (or inferred from Caddyfile) | Domain suffix for instance subdomains (e.g. `feature-x.app.test`) |
| `DEVMACHINE_DISABLE_HOSTS_UPDATE` | `false` | Set to `true` to skip `/etc/hosts` modifications |
| `DEVMACHINE_CADDY_MANAGED_TLS` | `false` | Set to `true` to let Caddy manage TLS instead of mkcert |
| `DEVMACHINE_CERT_PATH` | `_docker/caddy/certs/<suffix>.pem` | Path to TLS certificate (relative to base dir or absolute) |
| `DEVMACHINE_CERT_KEY_PATH` | `_docker/caddy/certs/<suffix>-key.pem` | Path to TLS certificate key |
| `DEVMACHINE_CADDY_CERT_PATH` | `/etc/caddy/certs/<suffix>.pem` | Certificate path as seen inside the Caddy container |
| `DEVMACHINE_CADDY_CERT_KEY_PATH` | `/etc/caddy/certs/<suffix>-key.pem` | Certificate key path inside the Caddy container |
| `DEVMACHINE_PROJECT_SUBDIR` | `app` | Sub-directory inside each instance dir that holds the project checkout |
| `DEVMACHINE_PHP_IMAGE` | `php:8.4-fpm` | Default Docker image for PHP containers |
| `DEVMACHINE_NETWORK` | `devmachine` | Docker network name shared by all services |
| `DEVMACHINE_MAX_INSTANCES` | `20` | Maximum number of concurrent instances |
| `DEVMACHINE_BACKUP_ROOT` | `<base>/backups` | Directory for backup storage |
| `DEVMACHINE_CADDY_DATA_PATH` | (empty) | Custom Caddy data directory path |
| `DEVMACHINE_COMPOSE_PROJECT` | `devmachine` | Docker Compose project name prefix |

## Architecture

dev-machine manages a workspace directory that contains a shared `docker-compose.yml`, a `_docker/` directory with service configurations, and individual instance directories.

**Registry** (`mcp-server/registry.json`) -- The source of truth for all instances. Each entry tracks the instance prefix, branch, database name, Redis DB indices, Vite port, and provisioning status.

**Docker Compose AST editing** -- Instead of string-templating YAML, dev-machine parses `docker-compose.yml` into an AST, injects or removes service blocks, and writes it back. This preserves comments, formatting, and manual edits.

**Caddy reverse proxy** -- Each instance gets a `<prefix>.<domain-suffix>` subdomain. dev-machine writes Caddy server blocks with `reverse_proxy` directives and TLS configuration, then reloads Caddy.

**Port allocation** -- Vite dev server ports are allocated from a pool, tracked in the registry, and freed on instance removal.

**PostgreSQL** -- Databases are created via `init.sql` injection into the shared PostgreSQL container. Each instance gets its own database name derived from its prefix.

**Build pipeline** -- Instance creation runs a deterministic pipeline: git clone, composer install, npm install, environment file generation, database migration, Vite build, certificate check, Caddy config, and registry update. Failures trigger automatic rollback.

**Library modules:**

| Module | Purpose |
|--------|---------|
| `lib/registry.ts` | Instance registry CRUD |
| `lib/docker-compose.ts` | Compose file AST editing |
| `lib/caddyfile.ts` | Caddy configuration management |
| `lib/port-allocator.ts` | Vite port allocation |
| `lib/postgres-init.ts` | Database provisioning |
| `lib/git.ts` | Git operations |
| `lib/docker.ts` | Docker CLI wrappers |
| `lib/backup.ts` | Backup and restore |
| `lib/build-status.ts` | Build progress tracking |
| `lib/audit-log.ts` | Action audit logging |
| `lib/preflight.ts` | Prerequisite checks |
| `lib/hosts.ts` | `/etc/hosts` management |
| `lib/env-generator.ts` | `.env` file generation |
| `lib/sanitize.ts` | Input sanitization |
| `lib/file-lock.ts` | Concurrent access locking |

## MCP integration

dev-machine runs as an MCP server over stdio by default. To use it with Claude or other MCP-compatible AI tools, add it to your MCP configuration:

```json
{
  "mcpServers": {
    "dev-machine": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/dev-machine"
    }
  }
}
```

Or with `tsx` for development:

```json
{
  "mcpServers": {
    "dev-machine": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/dev-machine"
    }
  }
}
```

Once connected, the AI agent can create dev instances, check their health, view logs, run commands, and manage backups -- all through natural language that maps to the 10 MCP tools.

## Prerequisites

- **Node.js 20+**
- **Docker** and **Docker Compose**
- **mkcert** -- for local HTTPS certificates (or set `DEVMACHINE_CADDY_MANAGED_TLS=true`)
- **git**

## License

MIT -- see [LICENSE](LICENSE).

---

Built by [Jekabs Porietis](https://github.com/jecis-repos).

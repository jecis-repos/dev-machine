/**
 * dev-machine configuration.
 *
 * All paths and identifiers are driven by environment variables with sane
 * defaults so the project works out of the box for local development.
 */

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

/* ------------------------------------------------------------------ */
/*  Core paths                                                         */
/* ------------------------------------------------------------------ */

const envBaseDir = process.env.DEVMACHINE_BASE_DIR?.trim();
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Root workspace directory that contains docker-compose.yml, _docker/, etc. */
export const BASE_DIR = envBaseDir
  ? resolve(envBaseDir)
  : resolve(moduleDir, "..", "..");

export const DOCKER_COMPOSE_PATH = `${BASE_DIR}/docker-compose.yml`;
export const CADDYFILE_PATH = `${BASE_DIR}/_docker/caddy/Caddyfile`;
export const INIT_SQL_PATH = `${BASE_DIR}/_docker/postgres/init.sql`;
export const MAKEFILE_PATH = `${BASE_DIR}/Makefile`;
export const REGISTRY_PATH = `${BASE_DIR}/mcp-server/registry.json`;
export const WORKTREE_REGISTRY_PATH = `${BASE_DIR}/mcp-server/worktree-registry.json`;
export const ENV_TEMPLATE_PATH = `${BASE_DIR}/_docker/env.template`;

/* ------------------------------------------------------------------ */
/*  Domain / TLS                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_LOCAL_DOMAIN_SUFFIX = "app.test";

function inferDomainSuffixFromCaddyfile(
  caddyfilePath: string,
): string | undefined {
  if (!existsSync(caddyfilePath)) return undefined;

  let content = "";
  try {
    content = readFileSync(caddyfilePath, "utf-8");
  } catch {
    return undefined;
  }

  const suffixes: string[] = [];
  const serverBlockRegex = /^([^\s#][^{]+)\{\s*$/gm;

  for (const match of content.matchAll(serverBlockRegex)) {
    const hostExpr = match[1]?.trim();
    if (!hostExpr) continue;

    const hosts = hostExpr
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const host of hosts) {
      if (host.startsWith(":") || host.startsWith("@") || host.startsWith("("))
        continue;

      const normalizedHost = host.toLowerCase();
      const hostWithoutWildcard = normalizedHost.startsWith("*.")
        ? normalizedHost.slice(2)
        : normalizedHost;
      const firstDot = hostWithoutWildcard.indexOf(".");
      if (firstDot < 0) continue;

      const suffix = normalizedHost.startsWith("*.")
        ? hostWithoutWildcard
        : hostWithoutWildcard.slice(firstDot + 1);
      if (suffix) suffixes.push(suffix);
    }
  }

  const uniqueSuffixes = [...new Set(suffixes)];
  const stagingSuffix = uniqueSuffixes.find((s) => s.startsWith("staging."));
  if (stagingSuffix) return stagingSuffix;

  const nonLocalSuffix = uniqueSuffixes.find(
    (s) => s !== DEFAULT_LOCAL_DOMAIN_SUFFIX,
  );
  if (nonLocalSuffix) return nonLocalSuffix;

  return undefined;
}

const domainSuffixEnv = process.env.DEVMACHINE_DOMAIN_SUFFIX?.trim();
const inferredDomainSuffix = domainSuffixEnv
  ? undefined
  : inferDomainSuffixFromCaddyfile(CADDYFILE_PATH);

export const DOMAIN_SUFFIX =
  domainSuffixEnv || inferredDomainSuffix || DEFAULT_LOCAL_DOMAIN_SUFFIX;

export const HOSTS_UPDATE_ENABLED =
  process.env.DEVMACHINE_DISABLE_HOSTS_UPDATE?.trim() !== "true";
export const CADDY_MANAGED_TLS =
  process.env.DEVMACHINE_CADDY_MANAGED_TLS?.trim() === "true";

const certStem = DOMAIN_SUFFIX === DEFAULT_LOCAL_DOMAIN_SUFFIX
  ? "app.test+1"
  : DOMAIN_SUFFIX;
const certPathEnv = process.env.DEVMACHINE_CERT_PATH?.trim();
const certKeyPathEnv = process.env.DEVMACHINE_CERT_KEY_PATH?.trim();

export const CERT_PATH = certPathEnv
  ? resolve(BASE_DIR, certPathEnv)
  : `${BASE_DIR}/_docker/caddy/certs/${certStem}.pem`;
export const CERT_KEY_PATH = certKeyPathEnv
  ? resolve(BASE_DIR, certKeyPathEnv)
  : `${BASE_DIR}/_docker/caddy/certs/${certStem}-key.pem`;

export const CADDY_TLS_CERT_PATH =
  process.env.DEVMACHINE_CADDY_CERT_PATH?.trim() ||
  `/etc/caddy/certs/${certStem}.pem`;
export const CADDY_TLS_KEY_PATH =
  process.env.DEVMACHINE_CADDY_CERT_KEY_PATH?.trim() ||
  `/etc/caddy/certs/${certStem}-key.pem`;

export const CERT_SCRIPT_PATH = `${BASE_DIR}/scripts/generate-certs.sh`;
export const ADMIN_SCRIPT_PATH = `${BASE_DIR}/scripts/create-admin.php`;
export const HOSTS_FILE = "/etc/hosts";

/* ------------------------------------------------------------------ */
/*  Project conventions                                                */
/* ------------------------------------------------------------------ */

/**
 * Sub-directory inside each instance dir that holds the project checkout.
 * Override with DEVMACHINE_PROJECT_SUBDIR (default "app").
 */
export const PROJECT_SUBDIR =
  process.env.DEVMACHINE_PROJECT_SUBDIR?.trim() || "app";

/**
 * Docker image to use for PHP containers when composer.json inspection
 * doesn't resolve one automatically.
 * Override with DEVMACHINE_PHP_IMAGE (default "php:8.4-fpm").
 */
export const DEFAULT_PHP_IMAGE =
  process.env.DEVMACHINE_PHP_IMAGE?.trim() || "php:8.4-fpm";

/**
 * Docker network name shared by all services.
 * Override with DEVMACHINE_NETWORK (default "devmachine").
 */
export const NETWORK_NAME =
  process.env.DEVMACHINE_NETWORK?.trim() || "devmachine";

/* ------------------------------------------------------------------ */
/*  Quotas                                                             */
/* ------------------------------------------------------------------ */

export const MAX_INSTANCES = parseInt(
  process.env.DEVMACHINE_MAX_INSTANCES || "20",
  10,
);
export const MIN_DISK_FREE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

/* ------------------------------------------------------------------ */
/*  Backups                                                            */
/* ------------------------------------------------------------------ */

export const BACKUP_ROOT =
  process.env.DEVMACHINE_BACKUP_ROOT?.trim() ||
  `${BASE_DIR}/backups`;

export const CADDY_DATA_PATH =
  process.env.DEVMACHINE_CADDY_DATA_PATH?.trim() || "";

/* ------------------------------------------------------------------ */
/*  Docker container naming                                            */
/* ------------------------------------------------------------------ */

/**
 * Prefix used for `docker stats` container name resolution.
 * Override with DEVMACHINE_COMPOSE_PROJECT (default "devmachine").
 */
export const COMPOSE_PROJECT =
  process.env.DEVMACHINE_COMPOSE_PROJECT?.trim() || "devmachine";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function instanceHostname(prefix: string): string {
  return `${prefix}.${DOMAIN_SUFFIX}`;
}

/* ------------------------------------------------------------------ */
/*  Fix-loop worktree defaults                                         */
/*                                                                     */
/*  These mirror the Atelier `WorktreeProvisioner` ctor defaults.      */
/*  They target a pre-existing pgvector container (port 5435) — NOT    */
/*  the per-instance Postgres on 5432.                                 */
/* ------------------------------------------------------------------ */

export const FIXLOOP_PG_HOST =
  process.env.DEVMACHINE_FIXLOOP_PG_HOST?.trim() || "127.0.0.1";
export const FIXLOOP_PG_PORT =
  process.env.DEVMACHINE_FIXLOOP_PG_PORT?.trim() || "5435";
export const FIXLOOP_PG_USER =
  process.env.DEVMACHINE_FIXLOOP_PG_USER?.trim() || "autonomy";
export const FIXLOOP_PG_PASSWORD =
  process.env.DEVMACHINE_FIXLOOP_PG_PASSWORD?.trim() || "autonomy_secret";
export const FIXLOOP_DB_OWNER =
  process.env.DEVMACHINE_FIXLOOP_DB_OWNER?.trim() || "atelier";

/* ------------------------------------------------------------------ */
/*  Fix-loop coding-agent bridges                                       */
/* ------------------------------------------------------------------ */

/**
 * Coding-agent bridge identifier.
 *
 * `claude-code` / `codex` / `amp` / `crush` spawn the corresponding CLI;
 * `mock` short-circuits the spawn and writes synthetic diff/report
 * files. The Atelier PHP original calls `agents.dispatch_intent` — an
 * internal Action that talks to bridge processes. This Node port skips
 * that indirection and spawns the coding-agent CLI directly.
 */
export type CodingAgentBridge =
  | "claude-code"
  | "codex"
  | "amp"
  | "crush"
  | "mock";

/**
 * Default bridge used by `dispatch-fix-loop-wave` when the caller does
 * not pass an explicit `bridge` override. Override via
 * `DEVMACHINE_FIXLOOP_BRIDGE`.
 */
export const FIXLOOP_DEFAULT_BRIDGE: CodingAgentBridge =
  (process.env.DEVMACHINE_FIXLOOP_BRIDGE as CodingAgentBridge) ||
  "claude-code";

/**
 * Path/name of the Claude Code CLI binary. Override via
 * `DEVMACHINE_FIXLOOP_CLAUDE_CODE_BIN` (default: `claude`).
 */
export const FIXLOOP_CLAUDE_CODE_BIN =
  process.env.DEVMACHINE_FIXLOOP_CLAUDE_CODE_BIN || "claude";

/**
 * Path/name of the Codex CLI binary. Override via
 * `DEVMACHINE_FIXLOOP_CODEX_BIN` (default: `codex`).
 */
export const FIXLOOP_CODEX_BIN =
  process.env.DEVMACHINE_FIXLOOP_CODEX_BIN || "codex";

/**
 * Path/name of the Sourcegraph Amp CLI binary. Override via
 * `DEVMACHINE_FIXLOOP_AMP_BIN` (default: `amp`).
 */
export const FIXLOOP_AMP_BIN =
  process.env.DEVMACHINE_FIXLOOP_AMP_BIN || "amp";

/**
 * Path/name of the Charm Crush terminal CLI binary. Override via
 * `DEVMACHINE_FIXLOOP_CRUSH_BIN` (default: `crush`).
 */
export const FIXLOOP_CRUSH_BIN =
  process.env.DEVMACHINE_FIXLOOP_CRUSH_BIN || "crush";

/* ------------------------------------------------------------------ */
/*  Data types                                                         */
/* ------------------------------------------------------------------ */

export interface Instance {
  prefix: string;
  display_name: string;
  directory: string;
  branch: string;
  php_image?: string;
  php_version?: string;
  db_name: string;
  redis_db: number;
  redis_cache_db: number;
  vite_port: number;
  timezone: string;
  created_at?: string;
  status?: "provisioning" | "updating" | "ready";
  expires_at?: string;
}

export interface Registry {
  instances: Instance[];
}

export type DbSeedSource = "default" | "none";

export interface CreateInstanceInput {
  branch: string;
  name?: string;
  display_name?: string;
  timezone?: string;
  db_seed?: DbSeedSource | string;
  db_dump_path?: string;
  ttl_hours?: number;
}

export interface RemoveInstanceInput {
  name: string;
  keep_database?: boolean;
  keep_files?: boolean;
  force_orphan_cleanup?: boolean;
}

export interface CreateBackupInput {
  name?: string;
}

export interface RestoreBackupInput {
  backup_id: string;
  restore_databases?: boolean;
  restore_files?: boolean;
}

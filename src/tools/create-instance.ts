/**
 * create-instance — Provision a new dev environment instance.
 *
 * Clones a branch, wires up Docker Compose, Caddy, Postgres, Redis,
 * installs deps, runs migrations, and starts the container.
 * Rolls back all changes on failure.
 */

import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { execSync } from "child_process";
import { isAbsolute, join } from "path";

import {
  BASE_DIR,
  CERT_PATH,
  CERT_SCRIPT_PATH,
  ADMIN_SCRIPT_PATH,
  CADDY_MANAGED_TLS,
  PROJECT_SUBDIR,
  DEFAULT_PHP_IMAGE,
  MAX_INSTANCES,
  MIN_DISK_FREE_BYTES,
  instanceHostname,
} from "../config.js";

import type { CreateInstanceInput, Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry, addInstance, removeInstance as removeFromRegistry, updateInstance } from "../lib/registry.js";
import { allocateVitePort, allocateRedisDbSlots } from "../lib/port-allocator.js";
import { addAppService, removeAppService } from "../lib/docker-compose.js";
import { addCaddyBlock, removeCaddyBlock } from "../lib/caddyfile.js";
import { addDatabaseEntries, removeDatabaseEntries } from "../lib/postgres-init.js";
import { addHostEntry, removeHostEntry } from "../lib/hosts.js";
import { generateEnv } from "../lib/env-generator.js";
import { regenerateMakefile } from "../lib/makefile.js";
import { validateBranch, cloneRepo } from "../lib/git.js";
import {
  startService,
  stopService,
  removeService,
  restartCaddy,
  execInService,
  execInServiceAsRoot,
  createDatabase,
  grantPrivileges,
  dropDatabase,
  restoreDump,
  copyToService,
} from "../lib/docker.js";
import { runCreateInstancePreflight } from "../lib/preflight.js";
import { resolveComposerRuntimeForCheckout } from "../lib/composer-platform.js";
import { loadStagingCommands } from "../lib/staging-commands.js";
import { auditLog } from "../lib/audit-log.js";
import { notifyWebhook } from "../lib/webhook.js";
import { BuildProgress } from "../lib/build-status.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const BRANCH_DERIVED_PREFIX_MAX_LENGTH = 8;
const PREFIX_MAX_LENGTH = 32;

/* ------------------------------------------------------------------ */
/*  Provision state — tracks what was created so rollback knows what   */
/*  to undo.                                                           */
/* ------------------------------------------------------------------ */

interface ProvisionState {
  containerStarted: boolean;
  registryAdded: boolean;
  caddyBlockAdded: boolean;
  dockerComposePatched: boolean;
  databasesCreated: boolean;
  initSqlUpdated: boolean;
  hostsUpdated: boolean;
  directoryCreated: boolean;
}

/* ------------------------------------------------------------------ */
/*  Rollback                                                           */
/* ------------------------------------------------------------------ */

async function rollbackProvision(
  prefix: string,
  dbName: string,
  directory: string,
  state: ProvisionState,
  step: (msg: string) => void,
): Promise<void> {
  step("[rollback] Cleaning up after provisioning failure...");

  const rollbackError = (label: string, err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    step(`[rollback] Warning: ${label}: ${msg}`);
    auditLog("rollback_step_failed", { prefix, step: label, error: msg });
  };

  if (state.containerStarted) {
    try {
      stopService(`${prefix}-app`);
      removeService(`${prefix}-app`);
      step("[rollback] Container stopped and removed");
    } catch (e) {
      rollbackError("could not stop container", e);
    }
  }

  if (state.registryAdded) {
    try {
      await removeFromRegistry(prefix);
      await regenerateMakefile();
      step("[rollback] Removed from registry");
    } catch (e) {
      rollbackError("could not remove from registry", e);
    }
  }

  if (state.caddyBlockAdded) {
    try {
      await removeCaddyBlock(prefix);
      step("[rollback] Removed Caddy block");
    } catch (e) {
      rollbackError("could not remove Caddy block", e);
    }
  }

  if (state.dockerComposePatched) {
    try {
      await removeAppService(prefix);
      step("[rollback] Removed from docker-compose.yml");
    } catch (e) {
      rollbackError("could not remove from docker-compose.yml", e);
    }
  }

  if (state.databasesCreated) {
    try {
      dropDatabase(dbName);
      dropDatabase(`${dbName}_testing`);
      step("[rollback] Dropped databases");
    } catch (e) {
      rollbackError("could not drop databases", e);
    }
  }

  if (state.initSqlUpdated) {
    try {
      await removeDatabaseEntries(dbName);
      step("[rollback] Removed from init.sql");
    } catch (e) {
      rollbackError("could not remove from init.sql", e);
    }
  }

  if (state.hostsUpdated) {
    try {
      await removeHostEntry(prefix);
      step("[rollback] Removed host entry");
    } catch (e) {
      rollbackError("could not remove host entry", e);
    }
  }

  if (state.directoryCreated) {
    const dirPath = join(BASE_DIR, directory);
    try {
      await rm(dirPath, { recursive: true, force: true });
      step("[rollback] Removed directory");
    } catch (e) {
      rollbackError("could not remove directory", e);
    }
  }

  step("[rollback] Cleanup complete");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sanitizePrefixValue(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, maxLength);
}

function sanitizePrefix(branch: string): string {
  const lastSegment = branch.split("/").pop() || branch;
  const fromLastSegment = sanitizePrefixValue(
    lastSegment,
    BRANCH_DERIVED_PREFIX_MAX_LENGTH,
  );
  return (
    fromLastSegment ||
    sanitizePrefixValue(branch, BRANCH_DERIVED_PREFIX_MAX_LENGTH)
  );
}

function normalizeName(name: string): string {
  return sanitizePrefixValue(name, PREFIX_MAX_LENGTH);
}

function titleize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

interface DbDumpPlan {
  dbDumpPath?: string;
  source: string;
}

function resolveDbDumpPlan(input: CreateInstanceInput): DbDumpPlan {
  const customPath = input.db_dump_path?.trim();
  if (customPath) {
    const resolvedPath = isAbsolute(customPath)
      ? customPath
      : join(BASE_DIR, customPath);
    return { dbDumpPath: resolvedPath, source: "custom path" };
  }
  // No preset seed defaults — users supply their own dump or get an empty DB.
  return { source: "none (empty database)" };
}

function summarizeError(error: unknown, maxLength = 1200): string {
  const err = error as {
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };

  const parts: string[] = [];
  const message = String(err?.message ?? error ?? "unknown error").trim();
  if (message) parts.push(message);

  const stdout =
    err?.stdout === undefined
      ? ""
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf-8")
        : String(err.stdout);
  if (stdout.trim()) parts.push(stdout.trim());

  const stderr =
    err?.stderr === undefined
      ? ""
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf-8")
        : String(err.stderr);
  if (stderr.trim()) parts.push(stderr.trim());

  const raw = parts.join("\n").trim() || "unknown error";
  if (raw.length <= maxLength) return raw;

  const headLength = Math.max(200, Math.floor(maxLength * 0.65));
  const tailLength = Math.max(120, maxLength - headLength - 8);
  return `${raw.slice(0, headLength)}\n...\n${raw.slice(-tailLength)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/*  Migration helpers                                                  */
/* ------------------------------------------------------------------ */

function parsePendingMigrationNames(statusOutput: string): string[] {
  const pendingNames: string[] = [];
  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!line || !/\bPending\b/.test(line)) continue;

    const nameMatch = line.match(
      /^([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{6}_[a-z0-9_]+)/i,
    );
    if (nameMatch) pendingNames.push(nameMatch[1]);
  }
  return pendingNames;
}

function preRunOutOfOrderCreateMigrations(
  serviceName: string,
  step: (message: string) => void,
): void {
  const statusOutput = execInService(
    serviceName,
    "php artisan migrate:status --no-ansi",
    120000,
  );
  const pendingNames = parsePendingMigrationNames(statusOutput);
  if (pendingNames.length === 0) return;

  const createMigrationsToRun = new Set<string>();

  for (const addMigrationName of pendingNames) {
    const addMatch = addMigrationName.match(
      /^(\d{4}_\d{2}_\d{2}_\d{6})_add_[a-z0-9_]+_to_([a-z0-9_]+)_table$/i,
    );
    if (!addMatch) continue;

    const addTimestamp = addMatch[1];
    const targetTable = addMatch[2];
    const createRegex = new RegExp(
      `^(\\d{4}_\\d{2}_\\d{2}_\\d{6})_create_${escapeRegex(targetTable)}_table$`,
      "i",
    );

    const createMigrationName = pendingNames.find((n) =>
      createRegex.test(n),
    );
    if (!createMigrationName) continue;

    const createTimestamp = createMigrationName.slice(0, 17);
    if (createTimestamp > addTimestamp) {
      createMigrationsToRun.add(createMigrationName);
    }
  }

  const sorted = [...createMigrationsToRun].sort();
  for (const name of sorted) {
    const migrationPath = `database/migrations/${name}.php`;
    step(`[16/16] Pre-running out-of-order create migration ${migrationPath}...`);
    execInService(
      serviceName,
      `php artisan migrate --force --path=${migrationPath}`,
      300000,
    );
    step(`[16/16] Applied ${migrationPath}`);
  }
}

function tryRecoverMissingTableMigration(
  serviceName: string,
  migrateErrorMessage: string,
  step: (message: string) => void,
): boolean {
  const missingTableMatch = migrateErrorMessage.match(
    /relation "([a-z0-9_]+)" does not exist/i,
  );
  if (!missingTableMatch) return false;

  const missingTable = missingTableMatch[1];
  const createMigrationPath = execInService(
    serviceName,
    `sh -lc 'ls -1 database/migrations/*create_${missingTable}_table.php 2>/dev/null | head -n 1'`,
    60000,
  ).trim();

  if (!createMigrationPath) return false;

  step(
    `[16/16] Missing table "${missingTable}" detected, running ${createMigrationPath} first...`,
  );
  execInService(
    serviceName,
    `php artisan migrate --force --path=${createMigrationPath}`,
    300000,
  );
  step(`[16/16] Applied ${createMigrationPath}`);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Main: createInstance                                                */
/* ------------------------------------------------------------------ */

export async function createInstance(
  input: CreateInstanceInput,
): Promise<string> {
  const log: string[] = [];
  const step = (msg: string) => {
    log.push(msg);
  };

  const provisionState: ProvisionState = {
    containerStarted: false,
    registryAdded: false,
    caddyBlockAdded: false,
    dockerComposePatched: false,
    databasesCreated: false,
    initSqlUpdated: false,
    hostsUpdated: false,
    directoryCreated: false,
  };

  let prefix = "";
  let dbName = "";
  let directory = "";
  let progress: BuildProgress | undefined;

  try {
    // ---- 1. Derive name / prefix ----
    const branch = input.branch.trim();
    if (!branch) throw new Error("Branch is required.");

    prefix = input.name ? normalizeName(input.name) : sanitizePrefix(branch);
    if (!/^[a-z0-9]+$/.test(prefix)) {
      throw new Error(
        "Could not derive a valid instance prefix. Provide a name containing letters and numbers.",
      );
    }

    const displayName = input.display_name || titleize(prefix);
    progress = new BuildProgress(prefix, branch, displayName, "create");
    directory = prefix;
    const timezone = input.timezone || "UTC";
    dbName = `${prefix}_db`;
    const instanceDir = join(BASE_DIR, directory);
    const checkoutDir = join(instanceDir, PROJECT_SUBDIR);
    const certExists = existsSync(CERT_PATH);
    const dbDumpPlan = resolveDbDumpPlan(input);

    // Validate prefix not taken
    const registry = await loadRegistry();
    if (registry.instances.some((i: Instance) => i.prefix === prefix)) {
      throw new Error(
        `Instance with prefix "${prefix}" already exists. Choose a different name.`,
      );
    }

    // Instance quota check
    const previewCount = registry.instances.filter(
      (i: Instance) => i.status === "provisioning" || i.created_at,
    ).length;
    if (previewCount >= MAX_INSTANCES) {
      throw new Error(
        `Instance quota reached (${previewCount}/${MAX_INSTANCES}). ` +
          "Remove unused instances or increase DEVMACHINE_MAX_INSTANCES.",
      );
    }

    // Disk space check
    try {
      const dfOutput = execSync(
        `df -B1 --output=avail "${BASE_DIR}" | tail -1`,
        { stdio: "pipe", timeout: 10000, shell: "/bin/sh" },
      )
        .toString()
        .trim();
      const freeBytes = parseInt(dfOutput, 10);
      if (Number.isFinite(freeBytes) && freeBytes < MIN_DISK_FREE_BYTES) {
        throw new Error(
          `Insufficient disk space: ${Math.round(freeBytes / 1024 / 1024 / 1024)}GB free, ` +
            `need at least ${Math.round(MIN_DISK_FREE_BYTES / 1024 / 1024 / 1024)}GB.`,
        );
      }
    } catch (e: any) {
      if (e.message.includes("Insufficient disk space")) throw e;
      // df may not be available — skip check
    }

    await progress.begin(1);
    step(`[1/16] Prefix "${prefix}" available`);
    auditLog("create_instance:start", {
      prefix,
      detail: `branch=${branch}`,
    });
    await progress.complete(1);

    step("[preflight] Running local prerequisite checks...");
    const preflightChecks = await runCreateInstancePreflight({
      prefix,
      checkoutDir,
      certExists,
      dbDumpPath: dbDumpPlan.dbDumpPath,
    });
    for (const check of preflightChecks) {
      step(`[preflight] ${check}`);
    }
    if (dbDumpPlan.dbDumpPath) {
      step(
        `[preflight] Database seed source: ${dbDumpPlan.source} (${dbDumpPlan.dbDumpPath})`,
      );
    } else {
      step(
        `[preflight] Database seed source: ${dbDumpPlan.source} (no dump restore)`,
      );
    }

    // ---- 2. Allocate ports and slots ----
    await progress.begin(2);
    const vitePort = await allocateVitePort();
    const { redis_db, redis_cache_db } = await allocateRedisDbSlots();
    step(`[2/16] Allocated: vite=${vitePort}, redis=${redis_db}/${redis_cache_db}`);

    // Compute TTL / expires_at
    const ttlHours =
      input.ttl_hours ??
      parseInt(process.env.PREVIEW_TTL_HOURS || "0", 10);
    const expiresAt =
      ttlHours > 0
        ? new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()
        : undefined;

    // Build instance object (early for registry reservation)
    const instance: Instance = {
      prefix,
      display_name: displayName,
      directory,
      branch,
      db_name: dbName,
      redis_db,
      redis_cache_db,
      vite_port: vitePort,
      timezone,
      created_at: new Date().toISOString(),
      status: "provisioning",
      expires_at: expiresAt,
    };

    // Early registry reservation
    await addInstance(instance);
    provisionState.registryAdded = true;
    step("[2/16] Reserved in registry (status: provisioning)");
    await progress.complete(2);

    // ---- 3. Verify certs ----
    await progress.begin(3);
    if (CADDY_MANAGED_TLS) {
      step("[3/16] Caddy managed TLS enabled, skipping local certificate generation");
    } else if (!certExists) {
      step("[3/16] Certs missing, generating...");
      execSync(`bash ${CERT_SCRIPT_PATH}`, { cwd: BASE_DIR, stdio: "pipe" });
      step("[3/16] Certs generated");
    } else {
      step("[3/16] Certs verified");
    }
    await progress.complete(3);

    // ---- 4. Validate branch exists ----
    await progress.begin(4);
    step("[4/16] Validating branch...");
    validateBranch(branch);
    step(`[4/16] Branch "${branch}" verified`);
    await progress.complete(4);

    // ---- 5. Clone repo ----
    await progress.begin(5);
    step("[5/16] Cloning repository...");
    await mkdir(instanceDir, { recursive: true });
    provisionState.directoryCreated = true;
    cloneRepo(branch, directory);
    step(`[5/16] Cloned to ${directory}/${PROJECT_SUBDIR}`);
    await progress.complete(5);
    await progress.deploy(); // Status page files are now available

    // ---- 6. Resolve PHP runtime from composer requirements ----
    await progress.begin(6);
    step("[6/16] Inspecting composer platform requirements...");
    const runtimeSelection = resolveComposerRuntimeForCheckout(
      checkoutDir,
      (line: string) => {
        step(`[6/16] ${line}`);
      },
    );
    step(
      `[6/16] Root PHP constraint: ${runtimeSelection.rootPhpConstraint ?? "not declared"}`,
    );
    if (runtimeSelection.requiredExtensions.length > 0) {
      step(
        `[6/16] Required extensions: ${runtimeSelection.requiredExtensions.map((ext: string) => `ext-${ext}`).join(", ")}`,
      );
    } else {
      step("[6/16] Required extensions: none");
    }
    step(
      `[6/16] Selected runtime: ${runtimeSelection.selected.image} (PHP ${runtimeSelection.selected.phpVersion})`,
    );

    // Update instance with runtime info
    instance.php_image = runtimeSelection.selected.image;
    instance.php_version = runtimeSelection.selected.phpVersion;
    await progress.complete(6);

    // ---- 7. Generate .env ----
    await progress.begin(7);
    const envPath = await generateEnv(instance);
    step(`[7/16] Generated ${envPath}`);
    await progress.complete(7);

    // ---- 8. Patch docker-compose.yml ----
    await progress.begin(8);
    await addAppService(instance);
    provisionState.dockerComposePatched = true;
    step(`[8/16] Updated docker-compose.yml (image ${instance.php_image})`);
    await progress.complete(8);

    // ---- 9. Add Caddy server block ----
    await progress.begin(9);
    await addCaddyBlock(instance);
    provisionState.caddyBlockAdded = true;
    step("[9/16] Updated Caddyfile");
    await progress.complete(9);

    // ---- 10. Update init.sql ----
    await progress.begin(10);
    await addDatabaseEntries(dbName);
    provisionState.initSqlUpdated = true;
    step("[10/16] Updated init.sql");
    await progress.complete(10);

    // ---- 11. Create databases in running PostgreSQL ----
    await progress.begin(11);
    const dbResult = createDatabase(dbName);
    const testDbResult = createDatabase(`${dbName}_testing`);
    grantPrivileges(dbName);
    grantPrivileges(`${dbName}_testing`);
    provisionState.databasesCreated = true;
    step(`[11/16] ${dbResult}; ${testDbResult}`);
    await progress.complete(11);

    // ---- 12. Update /etc/hosts ----
    await progress.begin(12);
    const hostsResult = await addHostEntry(prefix);
    provisionState.hostsUpdated = hostsResult.includes("Added");
    step(`[12/16] ${hostsResult}`);
    await progress.complete(12);

    // ---- 13. Regenerate Makefile ----
    await progress.begin(13);
    await regenerateMakefile();
    step("[13/16] Regenerated Makefile");
    await progress.complete(13);

    // ---- 14. Start container and restart Caddy ----
    await progress.begin(14);
    step("[14/16] Starting container...");
    startService(`${prefix}-app`);
    provisionState.containerStarted = true;
    restartCaddy();
    step("[14/16] Container started, Caddy restarted");
    await progress.complete(14);

    // ---- 15. Run setup commands ----
    await progress.begin(15);
    step("[15/16] Running setup commands...");
    const svc = `${prefix}-app`;

    try {
      execInServiceAsRoot(
        svc,
        "sh -lc 'mkdir -p /var/www/html/storage/logs /var/www/html/bootstrap/cache && chown -R sail:sail /var/www/html/storage /var/www/html/bootstrap/cache && chmod -R u+rwX,g+rwX /var/www/html/storage /var/www/html/bootstrap/cache'",
        120000,
      );
      step("[15/16] storage/bootstrap permissions normalized");
    } catch (e: any) {
      step(`[15/16] Warning: permission normalize: ${summarizeError(e)}`);
    }

    try {
      execInService(
        svc,
        "git config --global --add safe.directory /var/www/html",
      );
    } catch {
      // Non-fatal; only reduces noisy composer git warnings in bind-mounted repos.
    }

    // npm install — run inside container
    try {
      execInService(svc, "npm install", 300000);
      step("[15/16] npm install done");
    } catch (e: any) {
      // Fallback to host-side npm
      try {
        execSync(`cd "${checkoutDir}" && npm install`, {
          stdio: "pipe",
          timeout: 300000,
        });
        step("[15/16] npm install done (host fallback)");
      } catch (hostErr: any) {
        throw new Error(
          `npm install failed for "${prefix}". ${hostErr.message}`,
        );
      }
    }

    try {
      execInServiceAsRoot(
        svc,
        "composer install --no-interaction --no-scripts",
        600000,
      );
      step("[15/16] composer install done (--no-scripts)");
    } catch (e: any) {
      throw new Error(`Composer install failed for "${prefix}". ${e.message}`);
    }

    const vendorAutoloadPath = join(checkoutDir, "vendor", "autoload.php");
    if (!existsSync(vendorAutoloadPath)) {
      throw new Error(
        `Composer install did not produce vendor/autoload.php for "${prefix}". ` +
          "Check PHP/composer platform compatibility for this branch.",
      );
    }

    try {
      execInServiceAsRoot(svc, "php artisan key:generate --force");
      step("[15/16] key:generate done");
    } catch (e: any) {
      step(`[15/16] Warning: key:generate: ${e.message}`);
    }

    const postInstallCommands = ["php artisan package:discover --ansi"];
    for (const command of postInstallCommands) {
      try {
        execInServiceAsRoot(svc, command, 300000);
        step(`[15/16] ${command} done`);
      } catch (e: any) {
        step(`[15/16] Warning: ${command}: ${e.message}`);
      }
    }

    // vite build — run inside container
    try {
      execInService(svc, "npx vite build", 120000);
      step("[15/16] vite build done");
    } catch (e: any) {
      // Fallback to host-side vite
      try {
        execSync(`cd "${checkoutDir}" && npx vite build`, {
          stdio: "pipe",
          timeout: 120000,
        });
        step("[15/16] vite build done (host fallback)");
      } catch {
        step(`[15/16] Warning: vite build: ${e.message}`);
      }
    }

    // Ensure FPM user (sail) can write to runtime directories after root-owned build steps
    try {
      execInServiceAsRoot(
        svc,
        "sh -lc 'chown -R sail:sail /var/www/html/storage /var/www/html/bootstrap/cache'",
        120000,
      );
    } catch (e: any) {
      step(`[15/16] Warning: post-build ownership fix: ${summarizeError(e)}`);
    }

    // Load per-branch staging commands
    const stagingCmds = loadStagingCommands(checkoutDir, step);
    await progress.complete(15);

    // ---- 16. Restore dump or migrate ----
    await progress.begin(16);
    if (dbDumpPlan.dbDumpPath) {
      step("[16/16] Restoring database dump...");
      restoreDump(dbName, dbDumpPlan.dbDumpPath);
      step("[16/16] Dump restored");
    }

    try {
      preRunOutOfOrderCreateMigrations(svc, step);
    } catch (e: any) {
      step(
        `[16/16] Warning: pre-migrate ordering check: ${summarizeError(e)}`,
      );
    }

    let migrationsDone = false;
    try {
      execInService(svc, "php artisan migrate --force", 300000);
      step("[16/16] Migrations done");
      migrationsDone = true;
    } catch (e: any) {
      const migrateError = summarizeError(e, 2200);
      try {
        const recovered = tryRecoverMissingTableMigration(
          svc,
          migrateError,
          step,
        );
        if (recovered) {
          execInService(svc, "php artisan migrate --force", 300000);
          step("[16/16] Migrations done after recovery");
          migrationsDone = true;
        }
      } catch (recoveryError: any) {
        step(
          `[16/16] Warning: migration recovery failed: ${summarizeError(recoveryError)}`,
        );
      }

      if (!migrationsDone) {
        step(`[16/16] Warning: migrate: ${migrateError}`);
      }
    }

    // Create admin user
    if (!stagingCmds.skipAdminCreation) {
      try {
        const containerScriptPath = "/tmp/create-admin.php";
        copyToService(svc, ADMIN_SCRIPT_PATH, containerScriptPath);
        const output = execInService(
          svc,
          `php artisan tinker --execute="eval(file_get_contents('${containerScriptPath}'));"`,
          120000,
        );
        if (/Super admin ready:/i.test(output)) {
          step("[16/16] Admin user created");
        } else {
          step("[16/16] Warning: admin script ran but no confirmation output");
        }
      } catch (e: any) {
        step(`[16/16] Warning: create-admin: ${summarizeError(e)}`);
      }
    } else {
      step("[16/16] Admin user creation skipped (staging.json)");
    }

    // Run before_optimize commands from staging.json
    for (const cmd of stagingCmds.beforeOptimize) {
      try {
        execInService(svc, cmd, 300000);
        step(`[16/16] ${cmd} done`);
      } catch (e: any) {
        step(`[16/16] Warning: ${cmd}: ${summarizeError(e)}`);
      }
    }

    // Run optimization
    if (!stagingCmds.skipOptimize) {
      const optimizeCmds = [
        "icons:cache",
        "event:cache",
        "view:cache",
        "route:cache",
        "config:cache",
        ...stagingCmds.extraOptimize.map((c: string) =>
          c.replace(/^php artisan /, ""),
        ),
      ];
      for (const cmd of optimizeCmds) {
        try {
          const fullCmd = cmd.startsWith("php artisan ")
            ? cmd
            : `php artisan ${cmd}`;
          execInService(svc, fullCmd);
        } catch {
          // Non-critical
        }
      }
      step("[16/16] Optimization complete");
    } else {
      step("[16/16] Optimization skipped (staging.json)");
    }

    // Run after_optimize commands from staging.json
    for (const cmd of stagingCmds.afterOptimize) {
      try {
        execInService(svc, cmd, 300000);
        step(`[16/16] ${cmd} done`);
      } catch (e: any) {
        step(`[16/16] Warning: ${cmd}: ${summarizeError(e)}`);
      }
    }

    // Mark instance as ready (remove provisioning status)
    await updateInstance(prefix, { status: undefined });
    await progress.finish();

    const url = `https://${instanceHostname(prefix)}`;
    step("");
    step(`Instance "${displayName}" created successfully!`);
    step(`URL: ${url}`);
    step(`Vite: make ${prefix}-vite (port ${vitePort})`);
    step(`Shell: make ${prefix}-shell`);
    step(`Branch: ${branch}`);

    auditLog("create_instance:success", { prefix, detail: `url=${url}` });
    notifyWebhook("instance_created", { prefix, url, branch }).catch(
      () => {},
    );

    return log.join("\n");
  } catch (err: any) {
    step(`\nERROR: ${err.message}`);
    auditLog("create_instance:error", { prefix, error: err.message });
    if (progress) {
      await progress
        .fail(progress.currentStep || 1, err.message)
        .catch(() => {});
    }

    // Rollback on failure
    if (
      prefix &&
      (provisionState.registryAdded || provisionState.directoryCreated)
    ) {
      try {
        await rollbackProvision(
          prefix,
          dbName,
          directory,
          provisionState,
          step,
        );
      } catch (rollbackErr: any) {
        step(`[rollback] ERROR: ${rollbackErr.message}`);
      }
    }

    return log.join("\n");
  }
}

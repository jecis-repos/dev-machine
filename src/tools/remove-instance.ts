/**
 * remove-instance — Tear down a dev environment instance.
 *
 * Follows a deterministic cleanup sequence:
 *   stop container -> remove compose entry -> drop DB -> deregister
 * Supports orphan cleanup for instances missing from registry.
 */

import { existsSync, lstatSync, readdirSync, statSync } from "fs";
import { rm, mkdir, rename, realpath } from "fs/promises";
import { sep, join } from "path";
import { execFileSync } from "child_process";

import {
  BASE_DIR,
  REGISTRY_PATH,
  DOCKER_COMPOSE_PATH,
  CADDYFILE_PATH,
} from "../config.js";

import type { RemoveInstanceInput, Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry, removeInstance as removeFromRegistry } from "../lib/registry.js";
import { removeAppService } from "../lib/docker-compose.js";
import { removeCaddyBlock } from "../lib/caddyfile.js";
import { removeDatabaseEntries } from "../lib/postgres-init.js";
import { removeHostEntry } from "../lib/hosts.js";
import { regenerateMakefile } from "../lib/makefile.js";
import {
  stopService,
  removeService,
  reloadCaddy,
  restartCaddy,
  dropDatabase,
} from "../lib/docker.js";
import { auditLog } from "../lib/audit-log.js";
import { notifyWebhook } from "../lib/webhook.js";

/* ------------------------------------------------------------------ */
/*  Directory safety                                                   */
/* ------------------------------------------------------------------ */

const PROTECTED_DIRECTORY_NAMES = new Set([
  ".",
  "..",
  ".trash",
  "_docker",
  "mcp-server",
  "scripts",
  ".git",
  "node_modules",
]);

const SAFE_DIR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeDirectoryName(directory: string): boolean {
  return (
    SAFE_DIR_TOKEN.test(directory) &&
    !directory.startsWith(".") &&
    !directory.includes("..") &&
    !directory.includes("/") &&
    !directory.includes("\\") &&
    !PROTECTED_DIRECTORY_NAMES.has(directory)
  );
}

function ensureCriticalWorkspaceFilesExist(): void {
  const criticalFiles = [REGISTRY_PATH, DOCKER_COMPOSE_PATH, CADDYFILE_PATH];
  for (const critical of criticalFiles) {
    if (!existsSync(critical)) {
      throw new Error(`Critical workspace file missing: ${critical}`);
    }
  }
}

async function validateSafeDirectoryTarget(
  directory: string,
): Promise<string> {
  if (!isSafeDirectoryName(directory)) {
    throw new Error(`Unsafe directory name "${directory}"`);
  }

  const dirPath = `${BASE_DIR}/${directory}`;
  if (!existsSync(dirPath)) return dirPath;

  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove symlink target "${dirPath}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to remove non-directory target "${dirPath}"`);
  }

  const [baseReal, targetReal] = await Promise.all([
    realpath(BASE_DIR),
    realpath(dirPath),
  ]);

  if (!targetReal.startsWith(`${baseReal}${sep}`)) {
    throw new Error(
      `Refusing to remove directory outside BASE_DIR: ${targetReal}`,
    );
  }
  if (targetReal === baseReal) {
    throw new Error(
      `Refusing to remove BASE_DIR directly: ${targetReal}`,
    );
  }

  return dirPath;
}

/* ------------------------------------------------------------------ */
/*  Quarantine / safe-delete                                           */
/* ------------------------------------------------------------------ */

async function purgeQuarantinedDirectory(
  quarantineName: string,
): Promise<void> {
  const quarantinePath = `${BASE_DIR}/.trash/${quarantineName}`;
  if (!existsSync(quarantinePath)) return;

  try {
    await rm(quarantinePath, { recursive: true, force: true });
  } catch (err: any) {
    // rm fails on root-owned files from Docker bind mounts — fall through to Docker-based removal.
    process.stderr.write(
      `[quarantine] rm failed for ${quarantineName}, trying Docker fallback: ${err.code || err.message}\n`,
    );
  }

  if (!existsSync(quarantinePath)) return;

  // Fallback: use Docker alpine to rm root-owned files.
  const safeName = quarantineName.replace(/[^A-Za-z0-9._-]/g, "");
  if (safeName !== quarantineName) {
    throw new Error(
      `Quarantine name contains unsafe characters: "${quarantineName}"`,
    );
  }

  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-u",
      "0:0",
      "-v",
      `${BASE_DIR}:/work`,
      "alpine",
      "sh",
      "-c",
      `chmod -R u+rwX "/work/.trash/${safeName}" && rm -rf "/work/.trash/${safeName}"`,
    ],
    { stdio: "pipe", timeout: 120000 },
  );

  if (existsSync(quarantinePath)) {
    throw new Error(
      `Failed to remove quarantined directory ${quarantinePath}.`,
    );
  }
}

async function removeDirectoryWithFallback(
  directory: string,
): Promise<void> {
  const dirPath = await validateSafeDirectoryTarget(directory);
  if (!existsSync(dirPath)) return;

  await mkdir(`${BASE_DIR}/.trash`, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const quarantineName = `${directory}-${stamp}-${process.pid}`;
  const quarantinePath = `${BASE_DIR}/.trash/${quarantineName}`;

  try {
    await rename(dirPath, quarantinePath);
  } catch {
    // Rename fails when directory contains root-owned files from Docker bind mounts.
    const safeDirName = directory.replace(/[^A-Za-z0-9._-]/g, "");
    const safeQuarName = quarantineName.replace(/[^A-Za-z0-9._-]/g, "");
    if (safeDirName !== directory || safeQuarName !== quarantineName) {
      throw new Error(
        `Directory name contains unsafe characters: "${directory}"`,
      );
    }
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-u",
        "0:0",
        "-v",
        `${BASE_DIR}:/work`,
        "alpine",
        "sh",
        "-c",
        `mv "/work/${safeDirName}" "/work/.trash/${safeQuarName}"`,
      ],
      { stdio: "pipe", timeout: 120000 },
    );
  }
  await purgeQuarantinedDirectory(quarantineName);
}

function dbNameFromPrefix(prefix: string): string {
  return `${prefix}_db`;
}

async function cleanTrashDir(maxAgeMs = 7 * 24 * 3600 * 1000): Promise<void> {
  const trashDir = `${BASE_DIR}/.trash`;
  if (!existsSync(trashDir)) return;

  try {
    const entries = readdirSync(trashDir);
    const cutoff = Date.now() - maxAgeMs;

    for (const entry of entries) {
      const entryPath = join(trashDir, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.mtimeMs < cutoff) {
          await rm(entryPath, { recursive: true, force: true });
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Non-fatal — .trash cleanup is best-effort
  }
}

/* ------------------------------------------------------------------ */
/*  Teardown sequence                                                  */
/* ------------------------------------------------------------------ */

async function runTeardownSteps(
  prefix: string,
  serviceName: string,
  dbName: string,
  directory: string,
  input: RemoveInstanceInput,
  step: (msg: string) => void,
): Promise<void> {
  // 1. Stop and remove container
  step("[1/8] Stopping container...");
  try {
    stopService(serviceName);
    removeService(serviceName);
    step("[1/8] Container stopped and removed");
  } catch {
    step("[1/8] Container was not running");
  }

  // 2. Remove from docker-compose.yml
  step("[2/8] Updating docker-compose.yml...");
  try {
    await removeAppService(prefix);
    step("[2/8] Removed from docker-compose.yml");
  } catch (e: any) {
    step(`[2/8] Warning: ${e.message}`);
  }

  // 3. Remove Caddy block
  step("[3/8] Updating Caddyfile...");
  try {
    await removeCaddyBlock(prefix);
    step("[3/8] Removed from Caddyfile");
  } catch (e: any) {
    step(`[3/8] Warning: ${e.message}`);
  }

  // 4. Drop databases (unless keep_database)
  if (!input.keep_database) {
    step("[4/8] Dropping databases...");
    const r1 = dropDatabase(dbName);
    const r2 = dropDatabase(`${dbName}_testing`);
    step(`[4/8] ${r1}; ${r2}`);
  } else {
    step("[4/8] Keeping databases (--keep_database)");
  }

  // 5. Remove from init.sql
  step("[5/8] Updating init.sql...");
  try {
    await removeDatabaseEntries(dbName);
    step("[5/8] Removed from init.sql");
  } catch (e: any) {
    step(`[5/8] Warning: ${e.message}`);
  }

  // 6. Remove from /etc/hosts
  step("[6/8] Updating /etc/hosts...");
  const hostsResult = await removeHostEntry(prefix);
  step(`[6/8] ${hostsResult}`);

  // 7. Remove from registry and regenerate Makefile
  step("[7/8] Updating registry and Makefile...");
  const registry = await loadRegistry();
  const hasRegistryEntry = registry.instances.some((i: Instance) => i.prefix === prefix);
  if (hasRegistryEntry) {
    await removeFromRegistry(prefix);
  }
  await regenerateMakefile();
  step(
    `[7/8] ${hasRegistryEntry ? "Registry updated" : "Registry unchanged"}, Makefile regenerated`,
  );

  // 8. Reload Caddy (reload is sufficient for removal — no new volume mounts)
  step("[8/8] Reloading Caddy...");
  try {
    reloadCaddy();
    step("[8/8] Caddy reloaded");
  } catch {
    // Fallback to full restart if reload fails
    try {
      restartCaddy();
      step("[8/8] Caddy restarted (reload failed, fell back to restart)");
    } catch {
      step("[8/8] Warning: Caddy reload/restart failed (may not be running)");
    }
  }

  // Remove files via quarantine
  if (!input.keep_files) {
    const dirPath = `${BASE_DIR}/${directory}`;
    if (existsSync(dirPath)) {
      step(`Removing ${dirPath}...`);
      await removeDirectoryWithFallback(directory);
      step(`Removed ${dirPath}`);
    }
  } else {
    step(`Keeping files at ${BASE_DIR}/${directory}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main: removeInstanceTool                                           */
/* ------------------------------------------------------------------ */

export async function removeInstanceTool(
  input: RemoveInstanceInput,
): Promise<string> {
  const log: string[] = [];
  const step = (msg: string) => {
    log.push(msg);
  };

  try {
    auditLog("remove_instance:start", { prefix: input.name });
    ensureCriticalWorkspaceFilesExist();

    const registry = await loadRegistry();
    const instance = registry.instances.find((i: Instance) => i.prefix === input.name);

    if (!instance) {
      if (!input.force_orphan_cleanup) {
        throw new Error(`Instance "${input.name}" not found in registry`);
      }

      // Orphan cleanup: instance not in registry but artifacts may remain
      step(
        `[orphan] Instance "${input.name}" not found in registry. Running best-effort orphan cleanup.`,
      );
      await runTeardownSteps(
        input.name,
        `${input.name}-app`,
        dbNameFromPrefix(input.name),
        input.name,
        input,
        step,
      );

      ensureCriticalWorkspaceFilesExist();
      await cleanTrashDir();
      step("");
      step(`Orphan cleanup for "${input.name}" completed.`);
      auditLog("remove_instance:success", {
        prefix: input.name,
        detail: "orphan cleanup",
      });
      notifyWebhook("instance_removed", { prefix: input.name }).catch(
        () => {},
      );
      return log.join("\n");
    }

    const prefix = instance.prefix;
    await runTeardownSteps(
      prefix,
      `${prefix}-app`,
      instance.db_name,
      instance.directory,
      input,
      step,
    );

    ensureCriticalWorkspaceFilesExist();
    await cleanTrashDir();
    step("");
    step(
      `Instance "${instance.display_name}" (${prefix}) removed successfully.`,
    );
    auditLog("remove_instance:success", { prefix });
    notifyWebhook("instance_removed", {
      prefix,
      display_name: instance.display_name,
    }).catch(() => {});
    return log.join("\n");
  } catch (err: any) {
    step(`\nERROR: ${err.message}`);
    auditLog("remove_instance:error", {
      prefix: input.name,
      error: err.message,
    });
    return log.join("\n");
  }
}

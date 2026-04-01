/**
 * restore-backup — Restore a previously created backup.
 *
 * Supports selective restore (files only, databases only, or both).
 * Uses atomic swap for workspace files and emergency rollback on failure.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { rm } from "fs/promises";
import { join, dirname } from "path";

import { BACKUP_ROOT, BASE_DIR, CADDY_DATA_PATH } from "../config.js";

import type { RestoreBackupInput } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import {
  startService,
  stopService,
  restartCaddy,
  dropDatabase,
  createDatabase,
  grantPrivileges,
  restoreDump,
  isServiceRunning,
  listRunningAppServices,
} from "../lib/docker.js";
import {
  getLatestSymlinkTarget,
  verifySha256sums,
  generateTimestampId,
} from "../lib/backup.js";
import { auditLog } from "../lib/audit-log.js";
import { notifyWebhook } from "../lib/webhook.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function cleanPreRestoreDirs(keep = 1): Promise<void> {
  const parentDir = dirname(BASE_DIR);
  const baseName = BASE_DIR.split("/").pop() || "";
  try {
    const entries = readdirSync(parentDir)
      .filter((name) => name.startsWith(`${baseName}.pre-restore.`))
      .sort()
      .reverse();

    // Remove all except the most recent `keep` entries
    for (const entry of entries.slice(keep)) {
      const entryPath = join(parentDir, entry);
      await rm(entryPath, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal — cleanup is best-effort
  }
}

/* ------------------------------------------------------------------ */
/*  Main: restoreBackup                                                */
/* ------------------------------------------------------------------ */

export async function restoreBackup(
  input: RestoreBackupInput,
): Promise<string> {
  const log: string[] = [];
  const step = (msg: string) => {
    log.push(msg);
  };
  const restoreDatabases = input.restore_databases !== false;
  const restoreFiles = input.restore_files !== false;

  let stoppedServices: string[] = [];
  let caddyStopped = false;

  try {
    auditLog("restore_backup:start", {
      detail: `backup_id=${input.backup_id}`,
    });

    // 1. Resolve backup_id
    let backupId = input.backup_id.trim();
    if (backupId === "latest") {
      const target = getLatestSymlinkTarget();
      if (!target) {
        throw new Error(
          'No "latest" symlink found. Specify an explicit backup_id.',
        );
      }
      backupId = target;
      step(`[1/10] Resolved "latest" -> ${backupId}`);
    } else {
      step(`[1/10] Using backup: ${backupId}`);
    }

    const backupDir = join(BACKUP_ROOT, backupId);
    if (!existsSync(backupDir)) {
      throw new Error(`Backup directory not found: ${backupDir}`);
    }

    // 2. Verify SHA256SUMS integrity
    step("[2/10] Verifying backup integrity...");
    const verification = verifySha256sums(backupDir);
    if (!verification.passed) {
      throw new Error(
        `Backup integrity check failed: ${verification.output}`,
      );
    }
    step("[2/10] Integrity check passed");

    // 3. Load running app services
    step("[3/10] Discovering running services...");
    stoppedServices = listRunningAppServices();
    step(
      `[3/10] Found ${stoppedServices.length} app service(s): ${stoppedServices.join(", ") || "none"}`,
    );

    // 4. Stop all app services + caddy (keep pgsql, redis)
    step("[4/10] Stopping services for restore...");
    for (const svc of stoppedServices) {
      try {
        stopService(svc);
        step(`[4/10] Stopped ${svc}`);
      } catch (e: any) {
        step(`[4/10] Warning: could not stop ${svc}: ${e.message}`);
      }
    }
    try {
      stopService("caddy");
      caddyStopped = true;
      step("[4/10] Stopped caddy");
    } catch {
      step("[4/10] Warning: caddy was not running");
    }

    // 5. Restore workspace files
    if (restoreFiles) {
      // Support both zstd (new) and gzip (legacy) archives
      const workspaceTarZst = join(
        backupDir,
        "devmachine-workspace.tar.zst",
      );
      const workspaceTarGz = join(
        backupDir,
        "devmachine-workspace.tar.gz",
      );
      const workspaceTar = existsSync(workspaceTarZst)
        ? workspaceTarZst
        : workspaceTarGz;
      const extractFlag = workspaceTar.endsWith(".tar.zst")
        ? "--zstd"
        : "-z";

      if (existsSync(workspaceTar)) {
        const preRestoreTag = `.pre-restore.${generateTimestampId()}`;
        const preRestorePath = `${BASE_DIR}${preRestoreTag}`;
        const stagingPath = `${BASE_DIR}.staging-restore.${process.pid}`;

        // Extract to staging directory first — if extraction fails, live dir stays untouched
        step(
          `[5/10] Extracting workspace archive to staging directory... (${workspaceTar.endsWith(".tar.zst") ? "zstd" : "gzip"})`,
        );
        execSync(`mkdir -p "${stagingPath}"`, {
          stdio: "pipe",
          timeout: 10000,
        });
        try {
          execSync(
            `tar ${extractFlag} -xf "${workspaceTar}" -C "${stagingPath}"`,
            { stdio: "pipe", timeout: 600000 },
          );
        } catch (extractErr) {
          // Clean up staging dir on failure — live workspace stays intact
          execSync(`rm -rf "${stagingPath}"`, {
            stdio: "pipe",
            timeout: 60000,
            shell: "/bin/sh",
          });
          throw extractErr;
        }

        // Preserve running mcp-server code
        const mcpSrc = join(BASE_DIR, "mcp-server");
        const mcpDst = join(stagingPath, "mcp-server");
        if (existsSync(mcpSrc)) {
          execSync(
            `rm -rf "${mcpDst}" && cp -a "${mcpSrc}" "${mcpDst}"`,
            { stdio: "pipe", timeout: 120000, shell: "/bin/sh" },
          );
          step("[5/10] Preserved mcp-server/ in staging directory");
        }

        // Atomic swap: move live -> pre-restore, move staging -> live
        step("[5/10] Swapping workspace directories...");
        execSync(`mv "${BASE_DIR}" "${preRestorePath}"`, {
          stdio: "pipe",
          timeout: 300000,
        });
        try {
          execSync(`mv "${stagingPath}" "${BASE_DIR}"`, {
            stdio: "pipe",
            timeout: 300000,
          });
        } catch (swapErr) {
          // Emergency: restore original if staging move fails
          try {
            execSync(`mv "${preRestorePath}" "${BASE_DIR}"`, {
              stdio: "pipe",
              timeout: 300000,
            });
          } catch (restoreErr: any) {
            process.stderr.write(
              `[restore] CRITICAL: emergency rollback failed. Pre-restore at: ${preRestorePath}. Error: ${restoreErr.message}\n`,
            );
            throw new Error(
              `Workspace swap AND rollback both failed. Manual recovery needed from ${preRestorePath}`,
            );
          }
          throw swapErr;
        }

        step(
          `[5/10] Workspace restored (pre-restore saved at ${preRestorePath})`,
        );
      } else {
        step(
          "[5/10] No workspace archive found in backup, skipping file restore",
        );
      }

      // 6. Restore caddy data
      const caddyTarZst = join(backupDir, "caddy-data.tar.zst");
      const caddyTarGz = join(backupDir, "caddy-data.tar.gz");
      const caddyTar = existsSync(caddyTarZst)
        ? caddyTarZst
        : caddyTarGz;
      const caddyExtractFlag = caddyTar.endsWith(".tar.zst")
        ? "--zstd"
        : "-z";
      if (existsSync(caddyTar) && CADDY_DATA_PATH) {
        step("[6/10] Extracting Caddy data...");
        execSync(`mkdir -p "${CADDY_DATA_PATH}"`, {
          stdio: "pipe",
          timeout: 10000,
        });
        execSync(
          `tar ${caddyExtractFlag} -xf "${caddyTar}" -C "${CADDY_DATA_PATH}"`,
          { stdio: "pipe", timeout: 120000 },
        );
        step("[6/10] Caddy data restored");
      } else {
        step("[6/10] No Caddy data archive found, skipping");
      }
    } else {
      step("[5/10] File restore skipped (restore_files=false)");
      step("[6/10] Caddy data restore skipped");
    }

    // 7. Restore databases
    if (restoreDatabases) {
      step("[7/10] Restoring databases...");
      const dumpFiles = readdirSync(backupDir).filter(
        (f) =>
          f.startsWith("db-") &&
          f.endsWith(".dump") &&
          f !== "db-postgres.dump",
      );

      for (const dumpFile of dumpFiles) {
        const dbName = dumpFile.replace(/^db-/, "").replace(/\.dump$/, "");
        const dumpPath = join(backupDir, dumpFile);

        step(`[7/10] Restoring ${dbName}...`);
        try {
          dropDatabase(dbName);
          createDatabase(dbName);
          grantPrivileges(dbName);
          restoreDump(dbName, dumpPath);
          step(`[7/10] Restored ${dbName}`);
        } catch (e: any) {
          step(
            `[7/10] Warning: failed to restore ${dbName}: ${e.message}`,
          );
        }
      }
      step(
        `[7/10] Database restore complete (${dumpFiles.length} database(s))`,
      );
    } else {
      step("[7/10] Database restore skipped (restore_databases=false)");
    }

    // 8. Restart all app services + caddy
    step("[8/10] Restarting services...");
    try {
      restartCaddy();
      caddyStopped = false;
      step("[8/10] Caddy restarted");
    } catch (e: any) {
      step(`[8/10] Warning: caddy restart failed: ${e.message}`);
    }

    for (const svc of stoppedServices) {
      try {
        startService(svc);
        step(`[8/10] Started ${svc}`);
      } catch (e: any) {
        step(`[8/10] Warning: could not start ${svc}: ${e.message}`);
      }
    }

    // 9. Verify services came back up
    step("[9/10] Verifying services...");
    const failedServices: string[] = [];
    for (const svc of stoppedServices) {
      if (!isServiceRunning(svc)) {
        failedServices.push(svc);
      }
    }
    if (failedServices.length > 0) {
      step(
        `[9/10] Warning: ${failedServices.length} service(s) failed to start: ${failedServices.join(", ")}`,
      );
    } else {
      step(`[9/10] All ${stoppedServices.length} service(s) running`);
    }

    // 10. Clean up old pre-restore dirs and summarize
    await cleanPreRestoreDirs(1);
    step("[10/10] Restore complete");
    step("");
    step(`Restored from backup: ${backupId}`);
    step(`Files restored: ${restoreFiles ? "yes" : "no"}`);
    step(`Databases restored: ${restoreDatabases ? "yes" : "no"}`);
    if (failedServices.length > 0) {
      step(`Warning: Failed services: ${failedServices.join(", ")}`);
    }

    auditLog("restore_backup:success", {
      detail: `backup_id=${backupId}`,
    });
    notifyWebhook("backup_restored", { backup_id: backupId }).catch(
      () => {},
    );

    return log.join("\n");
  } catch (err: any) {
    step(`\nERROR: ${err.message}`);
    auditLog("restore_backup:error", { error: err.message });

    // Emergency: try to restart services
    step("Attempting emergency service restart...");
    for (const svc of stoppedServices) {
      try {
        startService(svc);
        step(`Restarted ${svc}`);
      } catch {
        step(`Failed to restart ${svc}`);
      }
    }
    if (caddyStopped) {
      try {
        restartCaddy();
        step("Restarted caddy");
      } catch {
        step("Failed to restart caddy");
      }
    }

    return log.join("\n");
  }
}

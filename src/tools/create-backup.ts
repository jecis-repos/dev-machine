/**
 * create-backup — Full snapshot of workspace files + all databases.
 *
 * Creates a timestamped backup directory with:
 *   - workspace archive (zstd or gzip)
 *   - Caddy data archive (optional)
 *   - per-database pg_dump files
 *   - SHA256SUMS manifest
 */

import { execSync } from "child_process";
import { existsSync, writeFileSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";

import { BACKUP_ROOT, BASE_DIR, CADDY_DATA_PATH } from "../config.js";

import type { CreateBackupInput } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { listDatabases, dumpDatabase } from "../lib/docker.js";
import {
  generateTimestampId,
  formatBytes,
  updateLatestSymlink,
  cleanOldBackups,
} from "../lib/backup.js";
import { auditLog } from "../lib/audit-log.js";
import { notifyWebhook } from "../lib/webhook.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hasZstd(): boolean {
  try {
    execSync("command -v zstd", {
      stdio: "pipe",
      timeout: 5000,
      shell: "/bin/sh",
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main: createBackup                                                 */
/* ------------------------------------------------------------------ */

export async function createBackup(
  input: CreateBackupInput,
): Promise<string> {
  const log: string[] = [];
  const step = (msg: string) => {
    log.push(msg);
  };

  try {
    auditLog("create_backup:start");

    // 1. Generate timestamp ID and create directory
    const id = generateTimestampId();
    const backupDir = join(BACKUP_ROOT, id);
    await mkdir(backupDir, { recursive: true });
    step(`[1/8] Created backup directory: ${backupDir}`);

    // 2. Write optional LABEL file
    const label = input.name?.trim();
    if (label) {
      writeFileSync(join(backupDir, "LABEL"), label + "\n", "utf-8");
      step(`[2/8] Label: ${label}`);
    } else {
      step("[2/8] No label provided");
    }

    // 3. Tar workspace excluding heavy/transient dirs
    const useZstd = hasZstd();
    const compressFlag = useZstd ? "--zstd" : "-z";
    const wsExt = useZstd ? ".tar.zst" : ".tar.gz";
    step(`[3/8] Archiving workspace (${useZstd ? "zstd" : "gzip"})...`);
    const workspaceTar = join(backupDir, `devmachine-workspace${wsExt}`);
    try {
      execSync(
        `tar ${compressFlag} -cf "${workspaceTar}" ` +
          `--exclude='node_modules' ` +
          `--exclude='vendor' ` +
          `--exclude='.git' ` +
          `--exclude='storage/logs' ` +
          `--exclude='framework/cache' ` +
          `--warning=no-file-changed ` +
          `--ignore-failed-read ` +
          `-C "${BASE_DIR}" .`,
        { stdio: "pipe", timeout: 600000 },
      );
    } catch (tarErr: any) {
      // tar exits 1 on permission-denied files but still archives everything it can
      if (!existsSync(workspaceTar) || statSync(workspaceTar).size === 0) {
        throw tarErr;
      }
      step(
        "[3/8] Warning: some files were not readable (permission denied), archive is partial",
      );
    }
    // Verify archive integrity
    try {
      execSync(`tar ${compressFlag} -tf "${workspaceTar}" > /dev/null`, {
        stdio: "pipe",
        timeout: 300000,
      });
    } catch {
      throw new Error(
        `Workspace archive failed integrity check (tar ${compressFlag} -tf)`,
      );
    }
    step(`[3/8] Workspace archived (${useZstd ? "zstd" : "gzip"})`);

    // 4. Tar caddy data (if exists)
    const caddyExt = useZstd ? ".tar.zst" : ".tar.gz";
    const caddyTar = join(backupDir, `caddy-data${caddyExt}`);
    if (CADDY_DATA_PATH && existsSync(CADDY_DATA_PATH)) {
      step("[4/8] Archiving Caddy data...");
      try {
        execSync(
          `tar ${compressFlag} -cf "${caddyTar}" --warning=no-file-changed --ignore-failed-read -C "${CADDY_DATA_PATH}" .`,
          { stdio: "pipe", timeout: 120000 },
        );
      } catch (tarErr: any) {
        if (!existsSync(caddyTar) || statSync(caddyTar).size === 0) {
          throw tarErr;
        }
        step(
          "[4/8] Warning: some Caddy files were not readable, archive is partial",
        );
      }
      step("[4/8] Caddy data archived");
    } else {
      step("[4/8] Caddy data path not found, skipping");
    }

    // 5. Dump databases
    step("[5/8] Dumping databases...");
    const databases = listDatabases();
    for (const db of databases) {
      const dumpPath = join(backupDir, `db-${db}.dump`);
      dumpDatabase(db, dumpPath);
      step(`[5/8] Dumped ${db}`);
    }
    // Also dump postgres system catalog
    const postgresDump = join(backupDir, "db-postgres.dump");
    dumpDatabase("postgres", postgresDump);
    step(`[5/8] Dumped postgres (${databases.length + 1} databases total)`);

    // 6. Generate SHA256SUMS
    step("[6/8] Generating checksums...");
    execSync(
      "sha256sum *.tar.zst *.tar.gz *.dump 2>/dev/null > SHA256SUMS || true",
      { cwd: backupDir, stdio: "pipe", timeout: 120000, shell: "/bin/sh" },
    );
    step("[6/8] SHA256SUMS generated");

    // 7. Update latest symlink
    updateLatestSymlink(id);
    step(`[7/8] Updated "latest" symlink -> ${id}`);

    // 8. Prune old backups
    step("[8/8] Pruning old backups (7-day retention)...");
    const pruned = await cleanOldBackups(7);
    if (pruned.length > 0) {
      step(
        `[8/8] Pruned ${pruned.length} old backup(s): ${pruned.join(", ")}`,
      );
    } else {
      step("[8/8] No old backups to prune");
    }

    // Summary
    const allFiles = [
      workspaceTar,
      caddyTar,
      postgresDump,
      ...databases.map((db: string) => join(backupDir, `db-${db}.dump`)),
    ].filter(existsSync);
    let totalBytes = 0;
    for (const f of allFiles) {
      try {
        totalBytes += statSync(f).size;
      } catch {
        /* skip */
      }
    }

    step("");
    step(`Backup "${id}" created successfully!`);
    if (label) step(`Label: ${label}`);
    step(`Location: ${backupDir}`);
    step(`Total size: ${formatBytes(totalBytes)}`);

    auditLog("create_backup:success", {
      detail: `id=${id} size=${formatBytes(totalBytes)}`,
    });
    notifyWebhook("backup_created", {
      backup_id: id,
      label,
      total_size: formatBytes(totalBytes),
    }).catch(() => {});

    return log.join("\n");
  } catch (err: any) {
    step(`\nERROR: ${err.message}`);
    auditLog("create_backup:error", { error: err.message });
    return log.join("\n");
  }
}

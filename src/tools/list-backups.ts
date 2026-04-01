/**
 * list-backups — Return all available backups as JSON.
 */

import { existsSync } from "fs";

import { BACKUP_ROOT } from "../config.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { listBackupDirs, getBackupManifest } from "../lib/backup.js";

export async function listBackups(): Promise<string> {
  if (!existsSync(BACKUP_ROOT)) {
    return JSON.stringify({
      backups: [],
      message: `No backup directory found at ${BACKUP_ROOT}`,
    });
  }

  const dirs = listBackupDirs();
  if (dirs.length === 0) {
    return JSON.stringify({ backups: [], message: "No backups found." });
  }

  const backups = dirs
    .map((id: string) => getBackupManifest(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  return JSON.stringify(
    { backup_root: BACKUP_ROOT, count: backups.length, backups },
    null,
    2,
  );
}

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync, readlinkSync, statSync, unlinkSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { BACKUP_ROOT } from "../config.js";

const TIMESTAMP_REGEX = /^\d{8}-\d{6}Z$/;
const DEFAULT_RETENTION_DAYS = 14;

export function generateTimestampId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function getLatestSymlinkTarget(): string | undefined {
  const latestPath = join(BACKUP_ROOT, "latest");
  try {
    if (lstatSync(latestPath).isSymbolicLink()) {
      return basename(readlinkSync(latestPath));
    }
  } catch {
    // symlink doesn't exist
  }
  return undefined;
}

export function updateLatestSymlink(targetDirName: string): void {
  const latestPath = join(BACKUP_ROOT, "latest");
  try {
    unlinkSync(latestPath);
  } catch {
    // doesn't exist yet
  }
  symlinkSync(targetDirName, latestPath);
}

export function listBackupDirs(): string[] {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT)
    .filter((name) => {
      if (!TIMESTAMP_REGEX.test(name)) return false;
      const full = join(BACKUP_ROOT, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

export interface BackupManifest {
  id: string;
  path: string;
  is_latest: boolean;
  label?: string;
  created_at: string;
  files: Array<{ name: string; size: string; bytes: number }>;
  total_size: string;
  total_bytes: number;
  has_sha256sums: boolean;
}

export function getBackupManifest(id: string): BackupManifest | undefined {
  const dir = join(BACKUP_ROOT, id);
  if (!existsSync(dir)) return undefined;

  const latestTarget = getLatestSymlinkTarget();
  const files: Array<{ name: string; size: string; bytes: number }> = [];
  let totalBytes = 0;

  for (const name of readdirSync(dir)) {
    const filePath = join(dir, name);
    try {
      const stat = statSync(filePath);
      if (stat.isFile()) {
        files.push({ name, size: formatBytes(stat.size), bytes: stat.size });
        totalBytes += stat.size;
      }
    } catch {
      // skip unreadable files
    }
  }

  let label: string | undefined;
  const labelPath = join(dir, "LABEL");
  try {
    label = readFileSync(labelPath, "utf-8").trim() || undefined;
  } catch {
    // no label
  }

  const match = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z$/);
  const createdAt = match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
    : "";

  return {
    id,
    path: dir,
    is_latest: latestTarget === id,
    label,
    created_at: createdAt,
    files,
    total_size: formatBytes(totalBytes),
    total_bytes: totalBytes,
    has_sha256sums: existsSync(join(dir, "SHA256SUMS")),
  };
}

export interface Sha256VerifyResult {
  passed: boolean;
  output: string;
}

export function verifySha256sums(dir: string): Sha256VerifyResult {
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) {
    return { passed: false, output: "SHA256SUMS file not found" };
  }

  try {
    const output = execSync("sha256sum -c SHA256SUMS", {
      cwd: dir,
      stdio: "pipe",
      timeout: 120000,
    }).toString();
    return { passed: true, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr?.toString() || "";
    const stdout = e.stdout?.toString() || "";
    return { passed: false, output: (stderr || stdout || e.message || String(err)).trim() };
  }
}

export async function cleanOldBackups(retentionDays = DEFAULT_RETENTION_DAYS): Promise<string[]> {
  const dirs = listBackupDirs();
  const latestTarget = getLatestSymlinkTarget();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const id of dirs) {
    if (id === latestTarget) continue;

    const match = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) continue;

    const ts = new Date(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
    ).getTime();

    if (ts < cutoffMs) {
      const dirPath = join(BACKUP_ROOT, id);
      await rm(dirPath, { recursive: true, force: true });
      removed.push(id);
    }
  }

  return removed;
}

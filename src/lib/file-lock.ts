import { openSync, closeSync, unlinkSync, readFileSync, renameSync, writeFileSync, writeSync, constants } from "node:fs";
import { REGISTRY_PATH } from "../config.js";

const DEFAULT_LOCK_PATH = `${REGISTRY_PATH}.lock`;
const MAX_WAIT_MS = 30_000;
const BASE_DELAY_MS = 50;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically replace a stale lock with our own PID.
 * Uses rename() which is atomic on POSIX — prevents TOCTOU race conditions.
 */
function tryReplaceStale(lockPath: string): boolean {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const match = content.match(/^(\d+)$/);
    if (!match) {
      try { unlinkSync(lockPath); } catch { /* race ok */ }
      return false;
    }

    const pid = parseInt(match[1], 10);
    if (pid <= 0 || isProcessAlive(pid)) {
      return false;
    }

    const tmpPath = `${lockPath}.${process.pid}`;
    writeFileSync(tmpPath, `${process.pid}\n`, "utf-8");
    renameSync(tmpPath, lockPath);

    const verify = readFileSync(lockPath, "utf-8").trim();
    return verify === `${process.pid}`;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    if (content === `${process.pid}`) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already removed
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function while holding an exclusive file lock.
 * Uses PID-based advisory locking with stale lock detection and exponential backoff.
 *
 * Defaults to the instance-registry lock path for backward compatibility.
 * Pass an explicit `lockPath` to lock a different file (e.g. the worktree
 * registry) so unrelated registries don't contend on a single lock.
 */
export async function withRegistryLock<T>(
  fn: () => Promise<T>,
  lockPath: string = DEFAULT_LOCK_PATH,
): Promise<T> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let delay = BASE_DELAY_MS;

  while (true) {
    if (tryAcquire(lockPath) || tryReplaceStale(lockPath)) {
      try {
        return await fn();
      } finally {
        releaseLock(lockPath);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Failed to acquire registry lock after ${MAX_WAIT_MS}ms. Lock file: ${lockPath}`);
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 1000);
  }
}

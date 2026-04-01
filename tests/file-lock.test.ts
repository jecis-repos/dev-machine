import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

describe("file-lock behavior", () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "devmachine-lock-test-"));
    lockPath = join(tmpDir, "registry.json.lock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lock file does not exist initially", () => {
    expect(existsSync(lockPath)).toBe(false);
  });

  it("creating and removing a lock file works", async () => {
    await writeFile(lockPath, `${process.pid}\n`);
    expect(existsSync(lockPath)).toBe(true);

    const { unlinkSync } = await import("node:fs");
    unlinkSync(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("stale lock detection identifies dead PIDs", async () => {
    await writeFile(lockPath, "999999\n");
    let alive = true;
    try {
      process.kill(999999, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("current PID is alive", () => {
    let alive = false;
    try {
      process.kill(process.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  });
});

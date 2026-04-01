import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockBackupRoot = vi.hoisted(() => ({ value: "/tmp/dev-machine-test-backups-nonexistent" }));

vi.mock("../src/config.js", () => ({
  get BACKUP_ROOT() { return mockBackupRoot.value; },
}));

import { generateTimestampId, formatBytes, listBackupDirs } from "../src/lib/backup.js";

describe("generateTimestampId", () => {
  it("matches YYYYMMDD-HHMMSSz format", () => {
    const id = generateTimestampId();
    expect(id).toMatch(/^\d{8}-\d{6}Z$/);
  });

  it("generates different IDs at different times", async () => {
    const id1 = generateTimestampId();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const id2 = generateTimestampId();
    expect(id1).toMatch(/^\d{8}-\d{6}Z$/);
    expect(id2).toMatch(/^\d{8}-\d{6}Z$/);
  });

  it("produces UTC-based timestamps", () => {
    const id = generateTimestampId();
    const yearStr = id.slice(0, 4);
    const year = parseInt(yearStr, 10);
    const currentYear = new Date().getUTCFullYear();
    expect(year).toBe(currentYear);
  });
});

describe("formatBytes", () => {
  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes correctly", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1099511627776)).toBe("1.0 TB");
  });
});

describe("listBackupDirs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "devmachine-backup-test-"));
    mockBackupRoot.value = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent directory", () => {
    mockBackupRoot.value = "/tmp/nonexistent-dir-xyz-999";
    const result = listBackupDirs();
    expect(result).toEqual([]);
  });

  it("returns empty array for directory with no valid backup dirs", async () => {
    await mkdir(join(tempDir, "not-a-backup"));
    await mkdir(join(tempDir, "random-dir"));
    const result = listBackupDirs();
    expect(result).toEqual([]);
  });

  it("returns backup dirs sorted newest first", async () => {
    await mkdir(join(tempDir, "20240101-120000Z"));
    await mkdir(join(tempDir, "20240315-080000Z"));
    await mkdir(join(tempDir, "20240210-150000Z"));

    const result = listBackupDirs();
    expect(result).toEqual([
      "20240315-080000Z",
      "20240210-150000Z",
      "20240101-120000Z",
    ]);
  });

  it("ignores files that match the pattern but are not directories", async () => {
    await mkdir(join(tempDir, "20240101-120000Z"));
    await writeFile(join(tempDir, "20240202-120000Z"), "I am a file");

    const result = listBackupDirs();
    expect(result).toEqual(["20240101-120000Z"]);
  });

  it("filters out non-timestamp entries like 'latest'", async () => {
    await mkdir(join(tempDir, "20240101-120000Z"));
    await mkdir(join(tempDir, "latest"));
    const result = listBackupDirs();
    expect(result).toEqual(["20240101-120000Z"]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock config before importing build-status
const mockBaseDir = { value: "/tmp/dev-machine-build-test" };

vi.mock("../src/config.js", () => ({
  get BASE_DIR() { return mockBaseDir.value; },
  PROJECT_SUBDIR: "app",
}));

import { BuildProgress } from "../src/lib/build-status.js";
import type { BuildStatusData } from "../src/lib/build-status.js";

describe("BuildProgress", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "devmachine-build-test-"));
    mockBaseDir.value = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates correct initial state for create mode", () => {
      const progress = new BuildProgress("test_prefix", "feat/login", "Test Instance", "create");
      expect(progress.currentStep).toBe(0);
    });

    it("creates correct initial state for update mode", () => {
      const progress = new BuildProgress("test_prefix", "main", "Test Instance", "update");
      expect(progress.currentStep).toBe(0);
    });
  });

  describe("begin", () => {
    it("sets step to active and updates currentStep", async () => {
      const progress = new BuildProgress("test_prefix", "main", "Test", "create");
      // Create the public dir so flush can write
      const pubDir = join(tempDir, "test_prefix", "app", "public");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pubDir, { recursive: true });

      await progress.begin(1);
      expect(progress.currentStep).toBe(1);

      // Verify JSON was written
      const jsonPath = join(pubDir, "build-status.json");
      const data: BuildStatusData = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(data.currentStep).toBe(1);
      expect(data.status).toBe("building");
      expect(data.steps[0].status).toBe("active");
    });
  });

  describe("complete", () => {
    it("sets step to done with duration", async () => {
      const progress = new BuildProgress("test_prefix", "main", "Test", "create");
      const pubDir = join(tempDir, "test_prefix", "app", "public");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pubDir, { recursive: true });

      await progress.begin(1);
      await progress.complete(1);

      const jsonPath = join(pubDir, "build-status.json");
      const data: BuildStatusData = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(data.steps[0].status).toBe("done");
      expect(typeof data.steps[0].duration).toBe("number");
    });
  });

  describe("warn", () => {
    it("sets step to warning status", async () => {
      const progress = new BuildProgress("test_prefix", "main", "Test", "create");
      const pubDir = join(tempDir, "test_prefix", "app", "public");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pubDir, { recursive: true });

      await progress.begin(1);
      await progress.warn(1);

      const jsonPath = join(pubDir, "build-status.json");
      const data: BuildStatusData = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(data.steps[0].status).toBe("warning");
      expect(typeof data.steps[0].duration).toBe("number");
    });
  });

  describe("fail", () => {
    it("sets step to error and overall status to error", async () => {
      const progress = new BuildProgress("test_prefix", "main", "Test", "create");
      const pubDir = join(tempDir, "test_prefix", "app", "public");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pubDir, { recursive: true });

      await progress.begin(3);
      await progress.fail(3, "Docker build failed");

      const jsonPath = join(pubDir, "build-status.json");
      const data: BuildStatusData = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(data.steps[2].status).toBe("error");
      expect(data.status).toBe("error");
      expect(data.error).toBe("Docker build failed");
    });
  });

  describe("step flow", () => {
    it("progresses through multiple steps", async () => {
      const progress = new BuildProgress("test_prefix", "main", "Test", "update");
      const pubDir = join(tempDir, "test_prefix", "app", "public");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pubDir, { recursive: true });

      await progress.begin(1);
      await progress.complete(1);
      await progress.begin(2);
      await progress.complete(2);

      expect(progress.currentStep).toBe(2);

      const jsonPath = join(pubDir, "build-status.json");
      const data: BuildStatusData = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(data.steps[0].status).toBe("done");
      expect(data.steps[1].status).toBe("done");
      expect(data.steps[2].status).toBe("pending");
    });
  });
});

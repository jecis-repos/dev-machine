import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import type { Instance } from "../src/types.js";

// Mock file-lock to bypass actual locking
vi.mock("../src/lib/file-lock.js", () => ({
  withRegistryLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// Mutable registry path for tests
let mockRegistryPath = "/tmp/test-registry.json";
vi.mock("../src/config.js", () => ({
  get REGISTRY_PATH() { return mockRegistryPath; },
  BASE_DIR: "/tmp",
  DOMAIN_SUFFIX: "app.test",
  PROJECT_SUBDIR: "app",
  instanceHostname: (prefix: string) => `${prefix}.app.test`,
}));

import { loadRegistry, addInstance, removeInstance, updateInstance } from "../src/lib/registry.js";

function makeInstance(prefix: string, overrides?: Partial<Instance>): Instance {
  return {
    prefix,
    display_name: prefix.toUpperCase(),
    directory: `/tmp/${prefix}`,
    branch: "main",
    db_name: `${prefix}_db`,
    redis_db: 0,
    redis_cache_db: 1,
    vite_port: 5173,
    timezone: "UTC",
    ...overrides,
  };
}

describe("registry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "devmachine-reg-test-"));
    mockRegistryPath = join(tmpDir, "registry.json");
  });

  describe("loadRegistry", () => {
    it("returns empty registry when file does not exist", async () => {
      const registry = await loadRegistry();
      expect(registry.instances).toEqual([]);
    });

    it("loads existing registry from disk", async () => {
      const data = { instances: [makeInstance("alpha")] };
      writeFileSync(mockRegistryPath, JSON.stringify(data));
      const registry = await loadRegistry();
      expect(registry.instances).toHaveLength(1);
      expect(registry.instances[0].prefix).toBe("alpha");
    });

    it("returns empty registry on corrupt JSON", async () => {
      writeFileSync(mockRegistryPath, "not json{{{");
      const registry = await loadRegistry();
      expect(registry.instances).toEqual([]);
    });
  });

  describe("addInstance", () => {
    it("adds a new instance to empty registry", async () => {
      await addInstance(makeInstance("alpha"));
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances).toHaveLength(1);
      expect(content.instances[0].prefix).toBe("alpha");
    });

    it("replaces existing instance with same prefix", async () => {
      await addInstance(makeInstance("alpha", { branch: "old" }));
      await addInstance(makeInstance("alpha", { branch: "new" }));
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances).toHaveLength(1);
      expect(content.instances[0].branch).toBe("new");
    });

    it("adds multiple instances with different prefixes", async () => {
      await addInstance(makeInstance("alpha"));
      await addInstance(makeInstance("beta", { vite_port: 5174, redis_db: 2, redis_cache_db: 3 }));
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances).toHaveLength(2);
    });
  });

  describe("removeInstance", () => {
    it("removes an instance by prefix", async () => {
      await addInstance(makeInstance("alpha"));
      await addInstance(makeInstance("beta", { vite_port: 5174, redis_db: 2, redis_cache_db: 3 }));
      await removeInstance("alpha");
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances).toHaveLength(1);
      expect(content.instances[0].prefix).toBe("beta");
    });

    it("does nothing when prefix not found", async () => {
      await addInstance(makeInstance("alpha"));
      await removeInstance("nonexistent");
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances).toHaveLength(1);
    });
  });

  describe("updateInstance", () => {
    it("updates fields on an existing instance", async () => {
      await addInstance(makeInstance("alpha", { branch: "old" }));
      await updateInstance("alpha", { branch: "new", display_name: "Updated" });
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances[0].branch).toBe("new");
      expect(content.instances[0].display_name).toBe("Updated");
    });

    it("does nothing when prefix not found", async () => {
      await addInstance(makeInstance("alpha"));
      await updateInstance("nonexistent", { branch: "new" });
      const content = JSON.parse(readFileSync(mockRegistryPath, "utf-8"));
      expect(content.instances[0].branch).toBe("main");
    });
  });
});

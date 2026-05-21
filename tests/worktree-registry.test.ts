import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import type { Worktree } from "../src/types.js";

// Bypass the real file lock — these tests cover the registry API, not the
// lock primitive (file-lock has its own test file).
vi.mock("../src/lib/file-lock.js", () => ({
  withRegistryLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

let mockWorktreeRegistryPath = "/tmp/test-worktree-registry.json";
vi.mock("../src/config.js", () => ({
  get WORKTREE_REGISTRY_PATH() {
    return mockWorktreeRegistryPath;
  },
  REGISTRY_PATH: "/tmp/test-registry.json",
  BASE_DIR: "/tmp",
  FIXLOOP_PG_HOST: "127.0.0.1",
  FIXLOOP_PG_PORT: "5435",
  FIXLOOP_PG_USER: "autonomy",
  FIXLOOP_PG_PASSWORD: "autonomy_secret",
  FIXLOOP_DB_OWNER: "atelier",
}));

import {
  loadWorktreeRegistry,
  addWorktree,
  removeWorktreeFromRegistry,
  getWorktree,
} from "../src/lib/worktree-registry.js";

function makeWorktree(taskId: string, overrides?: Partial<Worktree>): Worktree {
  return {
    task_id: taskId,
    worktree_path: `/tmp/repo/.claude/worktrees/agent-${taskId}`,
    branch: `agent-${taskId}`,
    base_ref: "origin/master",
    db_host: "127.0.0.1",
    db_port: "5435",
    db_username: "autonomy",
    db_password: "autonomy_secret",
    db_database: `atelier_${taskId.replace(/-/g, "_")}`,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("worktree-registry", () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "devmachine-wt-reg-test-"));
    mockWorktreeRegistryPath = join(dir, "worktree-registry.json");
  });

  describe("loadWorktreeRegistry", () => {
    it("returns empty registry when file does not exist", async () => {
      const registry = await loadWorktreeRegistry();
      expect(registry.worktrees).toEqual([]);
    });

    it("loads existing registry from disk", async () => {
      const data = { worktrees: [makeWorktree("task-one")] };
      writeFileSync(mockWorktreeRegistryPath, JSON.stringify(data));
      const registry = await loadWorktreeRegistry();
      expect(registry.worktrees).toHaveLength(1);
      expect(registry.worktrees[0].task_id).toBe("task-one");
    });

    it("returns empty registry on corrupt JSON", async () => {
      writeFileSync(mockWorktreeRegistryPath, "}}}not json");
      const registry = await loadWorktreeRegistry();
      expect(registry.worktrees).toEqual([]);
    });

    it("returns empty registry when shape is wrong", async () => {
      writeFileSync(mockWorktreeRegistryPath, JSON.stringify({ foo: "bar" }));
      const registry = await loadWorktreeRegistry();
      expect(registry.worktrees).toEqual([]);
    });
  });

  describe("addWorktree", () => {
    it("adds a new worktree to empty registry", async () => {
      await addWorktree(makeWorktree("alpha-1"));
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      expect(content.worktrees).toHaveLength(1);
      expect(content.worktrees[0].task_id).toBe("alpha-1");
      expect(content.worktrees[0].db_database).toBe("atelier_alpha_1");
    });

    it("replaces existing worktree with same task_id", async () => {
      await addWorktree(makeWorktree("alpha", { branch: "agent-alpha" }));
      await addWorktree(makeWorktree("alpha", { branch: "agent-alpha", base_ref: "origin/feat/x" }));
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      expect(content.worktrees).toHaveLength(1);
      expect(content.worktrees[0].base_ref).toBe("origin/feat/x");
    });

    it("adds multiple worktrees with different task_ids", async () => {
      await addWorktree(makeWorktree("alpha"));
      await addWorktree(makeWorktree("beta"));
      await addWorktree(makeWorktree("gamma"));
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      expect(content.worktrees).toHaveLength(3);
      expect(content.worktrees.map((w: Worktree) => w.task_id).sort()).toEqual([
        "alpha", "beta", "gamma",
      ]);
    });
  });

  describe("removeWorktreeFromRegistry", () => {
    it("removes a worktree by task_id", async () => {
      await addWorktree(makeWorktree("alpha"));
      await addWorktree(makeWorktree("beta"));
      await removeWorktreeFromRegistry("alpha");
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      expect(content.worktrees).toHaveLength(1);
      expect(content.worktrees[0].task_id).toBe("beta");
    });

    it("does nothing when task_id not found", async () => {
      await addWorktree(makeWorktree("alpha"));
      await removeWorktreeFromRegistry("does-not-exist");
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      expect(content.worktrees).toHaveLength(1);
    });
  });

  describe("getWorktree", () => {
    it("returns undefined when not registered", async () => {
      expect(await getWorktree("missing")).toBeUndefined();
    });

    it("returns the registered worktree", async () => {
      await addWorktree(makeWorktree("alpha", { base_ref: "origin/feat/abc" }));
      const found = await getWorktree("alpha");
      expect(found).toBeDefined();
      expect(found?.task_id).toBe("alpha");
      expect(found?.base_ref).toBe("origin/feat/abc");
    });
  });

  describe("race safety stub", () => {
    // Real race protection is provided by `withRegistryLock` in
    // src/lib/file-lock.ts (covered by tests/file-lock.test.ts). With the
    // no-op lock mock above, three concurrent `addWorktree` calls would
    // race on the read-modify-write cycle — so we drive them sequentially
    // here. The point of this test is just: an add+remove sequence
    // leaves the registry consistent (no duplicates, no drift).
    it("sequential add/remove leaves a consistent registry", async () => {
      await addWorktree(makeWorktree("a"));
      await addWorktree(makeWorktree("b"));
      await addWorktree(makeWorktree("c"));
      await removeWorktreeFromRegistry("b");
      const content = JSON.parse(
        readFileSync(mockWorktreeRegistryPath, "utf-8"),
      );
      const ids = content.worktrees.map((w: Worktree) => w.task_id).sort();
      expect(ids).toEqual(["a", "c"]);
    });
  });
});

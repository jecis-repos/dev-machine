import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestClusters } from "../src/lib/fix-loop-harvest.js";
import type { FixLoopClusterSpec } from "../src/lib/fix-loop-bridges.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "devmachine-harvest-"));
  await mkdir(join(tmp, "out"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function clusterAt(name: string, overrides: Partial<FixLoopClusterSpec> = {}): FixLoopClusterSpec {
  return {
    cluster: name,
    task_id: `task-${name}`,
    worktree_path: join(tmp, "wt", name),
    db_database: `db_${name}`,
    tests: [`tests/${name}.test.ts`],
    diff_path: join(tmp, "out", `${name}.diff`),
    report_path: join(tmp, "out", `${name}.report.md`),
    status: "dispatched",
    ...overrides,
  };
}

describe("harvestClusters — per-status resolution", () => {
  it("marks a cluster as harvested when diff exists and is non-empty", async () => {
    const c = clusterAt("alpha");
    await writeFile(c.diff_path, "diff --git a/file b/file\n", "utf-8");

    const { updated, summary } = harvestClusters([c]);
    expect(updated[0].status).toBe("harvested");
    expect(summary).toEqual({ harvested: 1, failed: 0, in_flight: 0 });
  });

  it("captures the report inline when both diff and report exist", async () => {
    const c = clusterAt("alpha");
    await writeFile(c.diff_path, "diff content\n", "utf-8");
    await writeFile(c.report_path, "## Done\n\nAll green.", "utf-8");

    const { updated } = harvestClusters([c]);
    expect(updated[0].status).toBe("harvested");
    expect(updated[0].report).toBe("## Done\n\nAll green.");
  });

  it("truncates report to the first 2000 characters (PHP parity)", async () => {
    const c = clusterAt("alpha");
    await writeFile(c.diff_path, "diff\n", "utf-8");
    await writeFile(c.report_path, "x".repeat(5000), "utf-8");

    const { updated } = harvestClusters([c]);
    expect(updated[0].report).toHaveLength(2000);
  });

  it("treats a zero-byte diff as still in flight (not harvested)", async () => {
    const c = clusterAt("beta");
    await writeFile(c.diff_path, "", "utf-8");

    const { updated, summary } = harvestClusters([c]);
    expect(updated[0].status).toBe("dispatched");
    expect(summary).toEqual({ harvested: 0, failed: 0, in_flight: 1 });
  });

  it("marks failed-no-report when the .failed sentinel exists", async () => {
    const c = clusterAt("gamma");
    await writeFile(`${c.diff_path}.failed`, "build broke", "utf-8");

    const { updated, summary } = harvestClusters([c]);
    expect(updated[0].status).toBe("failed-no-report");
    expect(summary).toEqual({ harvested: 0, failed: 1, in_flight: 0 });
  });

  it("marks retry-failed when the .retry-failed sentinel exists", async () => {
    const c = clusterAt("delta");
    await writeFile(`${c.diff_path}.retry-failed`, "exhausted retries", "utf-8");

    const { updated, summary } = harvestClusters([c]);
    expect(updated[0].status).toBe("retry-failed");
    expect(summary).toEqual({ harvested: 0, failed: 1, in_flight: 0 });
  });

  it(".retry-failed beats .failed beats diff (precedence)", async () => {
    const c = clusterAt("epsilon");
    await writeFile(c.diff_path, "non-empty\n", "utf-8");
    await writeFile(`${c.diff_path}.failed`, "old failure", "utf-8");
    await writeFile(`${c.diff_path}.retry-failed`, "permanent", "utf-8");

    const { updated } = harvestClusters([c]);
    expect(updated[0].status).toBe("retry-failed");
  });

  it("leaves cluster as dispatched when no artifacts exist", () => {
    const c = clusterAt("zeta");
    const { updated, summary } = harvestClusters([c]);
    expect(updated[0].status).toBe("dispatched");
    expect(summary).toEqual({ harvested: 0, failed: 0, in_flight: 1 });
  });
});

describe("harvestClusters — aggregate", () => {
  it("counts a mixed wave correctly", async () => {
    const harvested = clusterAt("h");
    const failed = clusterAt("f");
    const pending = clusterAt("p");
    const retry = clusterAt("r");

    await writeFile(harvested.diff_path, "ok\n", "utf-8");
    await writeFile(`${failed.diff_path}.failed`, "broke", "utf-8");
    await writeFile(`${retry.diff_path}.retry-failed`, "stop", "utf-8");

    const { updated, summary } = harvestClusters([harvested, failed, pending, retry]);
    expect(summary).toEqual({ harvested: 1, failed: 2, in_flight: 1 });
    const byCluster = Object.fromEntries(updated.map((c) => [c.cluster, c.status]));
    expect(byCluster).toEqual({
      h: "harvested",
      f: "failed-no-report",
      p: "dispatched",
      r: "retry-failed",
    });
  });

  it("returns empty summary for empty input", () => {
    const { updated, summary } = harvestClusters([]);
    expect(updated).toEqual([]);
    expect(summary).toEqual({ harvested: 0, failed: 0, in_flight: 0 });
  });

  it("does not mutate input clusters", async () => {
    const c = clusterAt("alpha", { status: "dispatched" });
    await writeFile(c.diff_path, "ok\n", "utf-8");
    const snapshot = JSON.stringify(c);

    harvestClusters([c]);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

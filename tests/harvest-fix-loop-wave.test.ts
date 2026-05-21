import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestFixLoopWave } from "../src/tools/harvest-fix-loop-wave.js";
import type { FixLoopClusterSpec } from "../src/lib/fix-loop-bridges.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "devmachine-harvest-tool-"));
  await mkdir(join(tmp, "out"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function clusterAt(name: string): FixLoopClusterSpec {
  return {
    cluster: name,
    task_id: `task-${name}`,
    worktree_path: join(tmp, "wt", name),
    db_database: `db_${name}`,
    tests: [`tests/${name}.test.ts`],
    diff_path: join(tmp, "out", `${name}.diff`),
    report_path: join(tmp, "out", `${name}.report.md`),
    status: "dispatched",
  };
}

describe("harvestFixLoopWave — tool surface", () => {
  it("returns harvested status with inline report when both files exist", async () => {
    const c = clusterAt("alpha");
    await writeFile(c.diff_path, "diff body\n", "utf-8");
    await writeFile(c.report_path, "## Report\nDone.", "utf-8");

    const result = await harvestFixLoopWave({
      wave: "L42",
      clusters: [c],
    });

    expect(result.ok).toBe(true);
    expect(result.wave).toBe("L42");
    expect(result.clusters[0].status).toBe("harvested");
    expect(result.clusters[0].report).toBe("## Report\nDone.");
    expect(result.summary).toEqual({ harvested: 1, failed: 0, in_flight: 0 });
  });

  it("aggregates a mixed wave correctly", async () => {
    const h = clusterAt("h");
    const f = clusterAt("f");
    const p = clusterAt("p");
    const r = clusterAt("r");

    await writeFile(h.diff_path, "ok\n", "utf-8");
    await writeFile(`${f.diff_path}.failed`, "nope", "utf-8");
    await writeFile(`${r.diff_path}.retry-failed`, "stop", "utf-8");

    const result = await harvestFixLoopWave({
      wave: "L42",
      clusters: [h, f, p, r],
    });

    expect(result.summary).toEqual({ harvested: 1, failed: 2, in_flight: 1 });

    const byCluster = Object.fromEntries(
      result.clusters.map((c) => [c.cluster, c.status]),
    );
    expect(byCluster).toEqual({
      h: "harvested",
      f: "failed-no-report",
      p: "dispatched",
      r: "retry-failed",
    });
  });

  it("returns an empty summary for an empty cluster list", async () => {
    const result = await harvestFixLoopWave({ wave: "L42", clusters: [] });
    expect(result.ok).toBe(true);
    expect(result.clusters).toEqual([]);
    expect(result.summary).toEqual({ harvested: 0, failed: 0, in_flight: 0 });
  });

  it("is idempotent — re-harvesting yields the same result", async () => {
    const c = clusterAt("alpha");
    await writeFile(c.diff_path, "diff\n", "utf-8");

    const first = await harvestFixLoopWave({ wave: "L42", clusters: [c] });
    const second = await harvestFixLoopWave({ wave: "L42", clusters: [c] });

    expect(first.summary).toEqual(second.summary);
    expect(first.clusters[0].status).toBe(second.clusters[0].status);
  });
});

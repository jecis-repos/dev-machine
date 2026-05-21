import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchFixLoopWave } from "../src/tools/dispatch-fix-loop-wave.js";
import type { FixLoopClusterSpec } from "../src/lib/fix-loop-bridges.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "devmachine-dispatch-tool-"));
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
  };
}

describe("dispatchFixLoopWave — happy path (mock bridge)", () => {
  it("dispatches every cluster and returns one entry per cluster", async () => {
    const result = await dispatchFixLoopWave({
      wave: "L42",
      bridge: "mock",
      clusters: [clusterAt("alpha"), clusterAt("beta"), clusterAt("gamma")],
    });

    expect(result.ok).toBe(true);
    expect(result.wave).toBe("L42");
    expect(result.bridge).toBe("mock");
    expect(result.dispatches).toHaveLength(3);
    expect(result.dispatches.map((d) => d.cluster)).toEqual(["alpha", "beta", "gamma"]);
    for (const d of result.dispatches) {
      expect(d.status).toBe("dispatched");
    }
  });

  it("returns unique UUIDs as dispatch_ids", async () => {
    const result = await dispatchFixLoopWave({
      wave: "L42",
      bridge: "mock",
      clusters: [clusterAt("a"), clusterAt("b"), clusterAt("c"), clusterAt("d")],
    });

    const ids = result.dispatches.map((d) => d.dispatch_id);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const uniq = new Set(ids);
    expect(uniq.size).toBe(ids.length);
  });

  it("mock bridge writes the diff + report files to disk", async () => {
    const cluster = clusterAt("solo");
    await dispatchFixLoopWave({
      wave: "L42",
      bridge: "mock",
      clusters: [cluster],
    });
    expect(existsSync(cluster.diff_path)).toBe(true);
    expect(existsSync(cluster.report_path)).toBe(true);
  });

  it("returns ok with an empty clusters list", async () => {
    const result = await dispatchFixLoopWave({
      wave: "empty",
      bridge: "mock",
      clusters: [],
    });
    expect(result.ok).toBe(true);
    expect(result.dispatches).toEqual([]);
  });
});

describe("dispatchFixLoopWave — bridge selection", () => {
  it("echoes the chosen bridge in the result", async () => {
    const result = await dispatchFixLoopWave({
      wave: "L42",
      bridge: "mock",
      clusters: [clusterAt("alpha")],
    });
    expect(result.bridge).toBe("mock");
  });
});

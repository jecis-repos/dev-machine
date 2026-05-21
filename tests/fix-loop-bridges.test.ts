import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, Readable } from "node:stream";

/* ------------------------------------------------------------------ */
/*  Mock node:child_process.spawn                                      */
/* ------------------------------------------------------------------ */

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function createFakeChild(pid = 4242) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    unref: () => void;
  };
  ee.pid = pid;
  ee.stdout = stdout;
  ee.stderr = stderr;
  ee.unref = vi.fn();
  return ee;
}

/* ------------------------------------------------------------------ */
/*  Imports under test (after vi.mock so the mock takes effect)        */
/* ------------------------------------------------------------------ */

import {
  buildPromptForCluster,
  DEFAULT_INTENT_TEMPLATE,
  dispatchClusterToBridge,
  type FixLoopClusterSpec,
} from "../src/lib/fix-loop-bridges.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "devmachine-bridges-"));
  spawnMock.mockReset();
  spawnMock.mockReturnValue(createFakeChild());
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCluster(overrides: Partial<FixLoopClusterSpec> = {}): FixLoopClusterSpec {
  return {
    cluster: "demo",
    task_id: "demo-task",
    worktree_path: join(tmp, "worktree"),
    db_database: "demo_db",
    tests: ["tests/Feature/DemoTest.php"],
    diff_path: join(tmp, "out", "demo.diff"),
    report_path: join(tmp, "out", "demo.report.md"),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests: prompt template                                             */
/* ------------------------------------------------------------------ */

describe("buildPromptForCluster", () => {
  it("substitutes every documented placeholder", () => {
    const cluster = makeCluster({
      cluster: "auth",
      worktree_path: "/wt/auth",
      db_database: "atelier_auth",
      tests: ["a.php", "b.php"],
      diff_path: "/wt/auth.diff",
      report_path: "/wt/auth.report.md",
    });
    const prompt = buildPromptForCluster(cluster);
    expect(prompt).toContain("cluster `auth`");
    expect(prompt).toContain("Worktree: /wt/auth");
    expect(prompt).toContain("Database: atelier_auth");
    expect(prompt).toContain("- a.php");
    expect(prompt).toContain("- b.php");
    expect(prompt).toContain("Write your unified diff to: /wt/auth.diff");
    expect(prompt).toContain("Write your markdown report to: /wt/auth.report.md");
    expect(prompt).toContain("/wt/auth.diff.failed");
  });

  it("renders empty test list as (none)", () => {
    const prompt = buildPromptForCluster(makeCluster({ tests: [] }));
    expect(prompt).toContain("(none)");
  });

  it("exports the canonical template constant", () => {
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{cluster_id}");
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{worktree_path}");
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{db_database}");
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{tests}");
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{diff_path}");
    expect(DEFAULT_INTENT_TEMPLATE).toContain("{report_path}");
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: claude-code + codex + amp + crush bridges                   */
/* ------------------------------------------------------------------ */

describe("dispatchClusterToBridge — real bridges", () => {
  it("spawns `claude -p <prompt>` with the worktree as cwd", async () => {
    const cluster = makeCluster();
    const result = await dispatchClusterToBridge({
      bridge: "claude-code",
      prompt: "drive tests to green",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe("claude");
    expect(args).toEqual(["-p", "drive tests to green"]);
    expect(opts.cwd).toBe(cluster.worktree_path);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);

    expect(result.ok).toBe(true);
    expect(result.dispatch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pid).toBe(4242);
  });

  it("spawns `codex exec <prompt>`", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "codex",
      prompt: "go",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("codex");
    expect(args).toEqual(["exec", "go"]);
  });

  it("spawns `amp -x <prompt>`", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "amp",
      prompt: "ship it",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("amp");
    expect(args).toEqual(["-x", "ship it"]);
  });

  it("spawns `crush run <prompt>`", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "crush",
      prompt: "do the thing",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("crush");
    expect(args).toEqual(["run", "do the thing"]);
  });

  it("calls unref on the spawned child", async () => {
    const fake = createFakeChild(9876);
    spawnMock.mockReturnValue(fake);

    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "claude-code",
      prompt: "p",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    expect(fake.unref).toHaveBeenCalled();
  });

  it("creates the worktree dir if it does not exist before spawning", async () => {
    const cluster = makeCluster({ worktree_path: join(tmp, "fresh", "wt") });
    expect(existsSync(cluster.worktree_path)).toBe(false);

    await dispatchClusterToBridge({
      bridge: "claude-code",
      prompt: "p",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    expect(existsSync(cluster.worktree_path)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: mock bridge                                                 */
/* ------------------------------------------------------------------ */

describe("dispatchClusterToBridge — mock bridge", () => {
  it("does NOT spawn anything", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "mock",
      prompt: "ignored",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("writes a non-empty diff file (so harvest round-trips to `harvested`)", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "mock",
      prompt: "ignored",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    expect(existsSync(cluster.diff_path)).toBe(true);
    expect(statSync(cluster.diff_path).size).toBeGreaterThan(0);
  });

  it("writes the report file with the documented payload", async () => {
    const cluster = makeCluster();
    await dispatchClusterToBridge({
      bridge: "mock",
      prompt: "ignored",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    const report = await readFile(cluster.report_path, "utf-8");
    expect(report).toBe("mock harvest payload");
  });

  it("returns ok + dispatch_id without a pid", async () => {
    const cluster = makeCluster();
    const result = await dispatchClusterToBridge({
      bridge: "mock",
      prompt: "ignored",
      cwd: cluster.worktree_path,
      diff_path: cluster.diff_path,
      report_path: cluster.report_path,
    });

    expect(result.ok).toBe(true);
    expect(result.dispatch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pid).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ------------------------------------------------------------------ */
//  Mock child_process so we never shell out to real git/psql.         */
// ------------------------------------------------------------------ */
//
// Both `execFile` (direct) and the `promisify(execFile)` wrapper used in
// `src/lib/worktree.ts` end up here. We record every call so we can assert
// on the exact (file, args) shape the production code emits.

interface CallRecord {
  file: string;
  args: string[];
  cwd?: string;
  pgpassword?: string;
}

const calls: CallRecord[] = [];

// Per-call programmable behaviour. Default: success with empty stdout/stderr.
// A failing case can push { ok: false, stderr } before the call.
const responseQueue: Array<{ ok: boolean; stderr?: string; stdout?: string }> = [];

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
      callback: (
        err: (Error & { stderr?: string; stdout?: string }) | null,
        out?: { stdout: string; stderr: string },
      ) => void,
    ) => {
      calls.push({
        file,
        args: [...args],
        cwd: options?.cwd,
        pgpassword: options?.env?.PGPASSWORD,
      });
      const next = responseQueue.shift() ?? { ok: true };
      if (next.ok) {
        callback(null, { stdout: next.stdout ?? "", stderr: next.stderr ?? "" });
      } else {
        const err = new Error(next.stderr ?? "command failed") as Error & {
          stderr?: string;
          stdout?: string;
        };
        err.stderr = next.stderr ?? "";
        err.stdout = next.stdout ?? "";
        callback(err);
      }
    },
  };
});

// Config — pin to known values so we can assert exact CLI shape.
vi.mock("../src/config.js", () => ({
  FIXLOOP_PG_HOST: "127.0.0.1",
  FIXLOOP_PG_PORT: "5435",
  FIXLOOP_PG_USER: "autonomy",
  FIXLOOP_PG_PASSWORD: "autonomy_secret",
  FIXLOOP_DB_OWNER: "atelier",
  REGISTRY_PATH: "/tmp/test-registry.json",
  WORKTREE_REGISTRY_PATH: "/tmp/test-worktree-registry.json",
  BASE_DIR: "/tmp",
}));

import {
  provisionWorktree,
  removeWorktree,
  statusWorktree,
  deriveDbName,
  deriveBranch,
  deriveWorktreePath,
} from "../src/lib/worktree.js";
import type { Worktree } from "../src/types.js";

beforeEach(() => {
  calls.length = 0;
  responseQueue.length = 0;
});

describe("deriveDbName", () => {
  it("prefixes with atelier_ and replaces - with _", () => {
    expect(deriveDbName("abc-123")).toBe("atelier_abc_123");
    expect(deriveDbName("plain")).toBe("atelier_plain");
    expect(deriveDbName("a-b-c-d")).toBe("atelier_a_b_c_d");
  });
});

describe("deriveBranch", () => {
  it("prefixes with agent-", () => {
    expect(deriveBranch("abc")).toBe("agent-abc");
  });
});

describe("deriveWorktreePath", () => {
  it("returns <repo_root>/.claude/worktrees/agent-<task_id>", () => {
    expect(deriveWorktreePath("/repo", "abc")).toBe(
      "/repo/.claude/worktrees/agent-abc",
    );
  });
});

describe("provisionWorktree — happy path (no prior worktree)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "devmachine-wt-prov-"));
  });

  it("emits the exact git + psql commands in order", async () => {
    const result = await provisionWorktree({
      task_id: "task-x",
      repo_root: repoRoot,
      base_ref: "origin/master",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.worktree).toBeDefined();
    expect(result.worktree?.task_id).toBe("task-x");
    expect(result.worktree?.branch).toBe("agent-task-x");
    expect(result.worktree?.db_database).toBe("atelier_task_x");
    expect(result.worktree?.base_ref).toBe("origin/master");
    expect(result.worktree?.db_host).toBe("127.0.0.1");
    expect(result.worktree?.db_port).toBe("5435");

    // The worktree path does not exist (fresh tmpdir), so the idempotent
    // cleanup branch is NOT taken. Expected: 4 calls.
    //   1. git worktree add --no-track -b agent-task-x <path> origin/master
    //   2. psql ... DROP DATABASE IF EXISTS atelier_task_x
    //   3. psql ... CREATE DATABASE atelier_task_x OWNER atelier
    //   4. psql ... CREATE EXTENSION IF NOT EXISTS vector
    expect(calls).toHaveLength(4);

    expect(calls[0]).toMatchObject({
      file: "git",
      args: [
        "worktree", "add", "--no-track", "-b", "agent-task-x",
        `${repoRoot}/.claude/worktrees/agent-task-x`,
        "origin/master",
      ],
      cwd: repoRoot,
    });

    expect(calls[1].file).toBe("psql");
    expect(calls[1].args).toEqual([
      "-h", "127.0.0.1",
      "-p", "5435",
      "-U", "autonomy",
      "-d", "postgres",
      "-c", "DROP DATABASE IF EXISTS atelier_task_x",
    ]);
    expect(calls[1].pgpassword).toBe("autonomy_secret");

    expect(calls[2].args).toEqual([
      "-h", "127.0.0.1",
      "-p", "5435",
      "-U", "autonomy",
      "-d", "postgres",
      "-c", "CREATE DATABASE atelier_task_x OWNER atelier",
    ]);
    expect(calls[2].pgpassword).toBe("autonomy_secret");

    expect(calls[3].args).toEqual([
      "-h", "127.0.0.1",
      "-p", "5435",
      "-U", "autonomy",
      "-d", "atelier_task_x",
      "-c", "CREATE EXTENSION IF NOT EXISTS vector",
    ]);
  });

  it("defaults base_ref to 'origin/master' when omitted", async () => {
    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
    });
    expect(result.ok).toBe(true);
    expect(result.worktree?.base_ref).toBe("origin/master");
    expect(calls[0].args).toContain("origin/master");
  });

  it("respects a custom base_ref", async () => {
    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
      base_ref: "release/v0.15.1-tag",
    });
    expect(result.ok).toBe(true);
    expect(result.worktree?.base_ref).toBe("release/v0.15.1-tag");
    expect(calls[0].args[calls[0].args.length - 1]).toBe("release/v0.15.1-tag");
  });

  it("populates expires_at when ttl_hours > 0", async () => {
    const before = Date.now();
    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
      ttl_hours: 2,
    });
    expect(result.worktree?.expires_at).toBeDefined();
    const expiry = new Date(result.worktree!.expires_at!).getTime();
    expect(expiry - before).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 1000);
    expect(expiry - before).toBeLessThanOrEqual(2 * 3600 * 1000 + 1000);
  });

  it("leaves expires_at undefined when ttl_hours is 0 or absent", async () => {
    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
      ttl_hours: 0,
    });
    expect(result.worktree?.expires_at).toBeUndefined();
  });
});

describe("provisionWorktree — idempotent re-add", () => {
  it("removes prior worktree + deletes branch before re-adding when path exists", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "devmachine-wt-idem-"));
    // Create the worktree path so existsSync(...) returns true.
    const wtDir = join(repoRoot, ".claude", "worktrees", "agent-dup");
    await mkdir(wtDir, { recursive: true });

    const result = await provisionWorktree({
      task_id: "dup",
      repo_root: repoRoot,
    });

    expect(result.ok).toBe(true);

    // Expected sequence — 6 calls:
    //   1. git worktree remove --force <path>     (idempotent cleanup)
    //   2. git branch -D agent-dup                (idempotent cleanup)
    //   3. git worktree add --no-track -b ...
    //   4. psql DROP DATABASE IF EXISTS
    //   5. psql CREATE DATABASE ... OWNER atelier
    //   6. psql CREATE EXTENSION IF NOT EXISTS vector
    expect(calls).toHaveLength(6);

    expect(calls[0]).toMatchObject({
      file: "git",
      args: ["worktree", "remove", "--force", wtDir],
      cwd: repoRoot,
    });

    expect(calls[1]).toMatchObject({
      file: "git",
      args: ["branch", "-D", "agent-dup"],
      cwd: repoRoot,
    });

    expect(calls[2].file).toBe("git");
    expect(calls[2].args.slice(0, 5)).toEqual([
      "worktree", "add", "--no-track", "-b", "agent-dup",
    ]);

    expect(calls[3].args).toContain("DROP DATABASE IF EXISTS atelier_dup");
    expect(calls[4].args).toContain("CREATE DATABASE atelier_dup OWNER atelier");
    expect(calls[5].args).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });
});

describe("provisionWorktree — input validation", () => {
  it("rejects non-kebab-case task_id", async () => {
    const result = await provisionWorktree({
      task_id: "Bad Task!",
      repo_root: "/tmp",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/kebab-case/);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty repo_root", async () => {
    const result = await provisionWorktree({
      task_id: "ok-task",
      repo_root: "",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/repo_root is required/);
    expect(calls).toHaveLength(0);
  });
});

describe("provisionWorktree — failure surface", () => {
  it("surfaces git worktree add failure and stops before psql", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "devmachine-wt-fail-"));
    responseQueue.push({ ok: false, stderr: "fatal: cannot lock ref" });

    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /git worktree add failed/.test(e))).toBe(true);
    expect(calls).toHaveLength(1); // only the failing git call
  });

  it("surfaces CREATE DATABASE failure", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "devmachine-wt-cdb-"));
    // git add OK, DROP OK, CREATE fails.
    responseQueue.push({ ok: true }); // git worktree add
    responseQueue.push({ ok: true }); // DROP DATABASE IF EXISTS
    responseQueue.push({ ok: false, stderr: "role 'atelier' does not exist" });

    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /CREATE DATABASE.*failed/.test(e))).toBe(true);
    // Should not have proceeded to CREATE EXTENSION.
    expect(calls).toHaveLength(3);
  });

  it("flags CREATE EXTENSION vector failure but still returns the worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "devmachine-wt-ext-"));
    responseQueue.push({ ok: true }); // git worktree add
    responseQueue.push({ ok: true }); // DROP
    responseQueue.push({ ok: true }); // CREATE DATABASE
    responseQueue.push({ ok: false, stderr: 'extension "vector" is not available' });

    const result = await provisionWorktree({
      task_id: "abc",
      repo_root: repoRoot,
    });

    expect(result.ok).toBe(false); // extension failure populates errors
    expect(result.worktree).toBeDefined();
    expect(result.errors.some((e) => /CREATE EXTENSION vector failed/.test(e))).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("emits `git worktree remove --force` then `DROP DATABASE IF EXISTS`", async () => {
    const result = await removeWorktree({
      task_id: "abc",
      worktree_path: "/repo/.claude/worktrees/agent-abc",
      db_database: "atelier_abc",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(2);

    expect(calls[0]).toMatchObject({
      file: "git",
      args: ["worktree", "remove", "--force", "/repo/.claude/worktrees/agent-abc"],
    });

    expect(calls[1].file).toBe("psql");
    expect(calls[1].args).toEqual([
      "-h", "127.0.0.1",
      "-p", "5435",
      "-U", "autonomy",
      "-d", "postgres",
      "-c", "DROP DATABASE IF EXISTS atelier_abc",
    ]);
    expect(calls[1].pgpassword).toBe("autonomy_secret");
  });

  it("does NOT delete the local branch (mirrors WaveCleanupService)", async () => {
    await removeWorktree({
      task_id: "abc",
      worktree_path: "/repo/.claude/worktrees/agent-abc",
      db_database: "atelier_abc",
    });
    expect(calls.find((c) => c.args.includes("branch"))).toBeUndefined();
  });

  it("returns best-effort errors instead of throwing", async () => {
    responseQueue.push({ ok: false, stderr: "fatal: 'path' is not a working tree" });
    responseQueue.push({ ok: false, stderr: 'database "atelier_abc" does not exist' });

    const result = await removeWorktree({
      task_id: "abc",
      worktree_path: "/repo/.claude/worktrees/agent-abc",
      db_database: "atelier_abc",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/git worktree remove failed/);
    expect(result.errors[1]).toMatch(/drop database failed/);
  });
});

describe("statusWorktree", () => {
  function makeWorktree(overrides?: Partial<Worktree>): Worktree {
    return {
      task_id: "abc",
      worktree_path: "/path/that/does/not/exist/agent-abc",
      branch: "agent-abc",
      base_ref: "origin/master",
      db_host: "127.0.0.1",
      db_port: "5435",
      db_username: "autonomy",
      db_password: "autonomy_secret",
      db_database: "atelier_abc",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("issues `SELECT 1` against the worktree's own DB coordinates", async () => {
    const wt = makeWorktree({
      db_host: "db.local",
      db_port: "6543",
      db_username: "agent",
      db_password: "secret",
      db_database: "atelier_xyz",
    });
    // path does not exist, so ok stays false even when the DB ping succeeds.
    await statusWorktree(wt);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("psql");
    expect(calls[0].args).toEqual([
      "-h", "db.local",
      "-p", "6543",
      "-U", "agent",
      "-d", "atelier_xyz",
      "-tAc", "SELECT 1",
    ]);
    expect(calls[0].pgpassword).toBe("secret");
  });

  it("returns ok=false when the path is missing", async () => {
    const result = await statusWorktree(makeWorktree());
    expect(result.ok).toBe(false);
    expect(result.worktree_path_exists).toBe(false);
    expect(result.errors.some((e) => /worktree_path does not exist/.test(e))).toBe(true);
  });

  it("returns ok=false when the DB is unreachable", async () => {
    responseQueue.push({ ok: false, stderr: "could not connect to server" });
    const result = await statusWorktree(makeWorktree());
    expect(result.db_reachable).toBe(false);
    expect(result.errors.some((e) => /db unreachable/.test(e))).toBe(true);
  });
});

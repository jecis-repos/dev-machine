/**
 * Worktree provisioning, removal, and status.
 *
 * Pure functions — no MCP coupling, no registry writes. Mirrors the
 * semantics of `app/Modules/Dev/Services/WorktreeProvisioner.php` and
 * `WaveCleanupService.php` in the Atelier repo (which are the
 * authoritative behaviour spec for this toolset).
 *
 * Contract:
 *   - `provisionWorktree` is **idempotent**: if the worktree path already
 *     exists it is `git worktree remove --force`d, the local branch is
 *     `git branch -D`d, and then a fresh worktree+branch is added. The
 *     DB is `DROP DATABASE IF EXISTS`d then re-`CREATE DATABASE`d.
 *   - `removeWorktree` is best-effort: it returns the list of errors it
 *     hit but never throws. It does NOT delete the local branch — branch
 *     cleanup is the provision-side's problem (matches `WaveCleanupService`).
 *   - `statusWorktree` reads the registry, checks `existsSync(path)`, and
 *     issues `SELECT 1` against the dedicated DB to confirm reachability.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import {
  FIXLOOP_DB_OWNER,
  FIXLOOP_PG_HOST,
  FIXLOOP_PG_PASSWORD,
  FIXLOOP_PG_PORT,
  FIXLOOP_PG_USER,
} from "../config.js";
import type { Worktree, WorktreeCreateInput, WorktreeRemoveInput } from "../types.js";

const pExecFile = promisify(execFile);

const TASK_ID_REGEX = /^[a-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Apply the Atelier DB-name rule: `atelier_<task_id with dashes → underscores>`.
 */
export function deriveDbName(taskId: string): string {
  return `atelier_${taskId.replace(/-/g, "_")}`;
}

export function deriveBranch(taskId: string): string {
  return `agent-${taskId}`;
}

export function deriveWorktreePath(repoRoot: string, taskId: string): string {
  return `${repoRoot}/.claude/worktrees/agent-${taskId}`;
}

/**
 * Run a command and return `{ ok, stderr }`. Never throws.
 */
async function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ ok: boolean; stderr: string }> {
  try {
    const { stderr } = await pExecFile(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 60_000,
    });
    return { ok: true, stderr };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr =
      e?.stderr === undefined
        ? ""
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf-8")
          : String(e.stderr);
    return { ok: false, stderr: stderr.trim() || e?.message || "unknown error" };
  }
}

interface PgOptions {
  host: string;
  port: string;
  user: string;
  password: string;
}

function pgEnv(opts: PgOptions): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: opts.password };
}

/* ------------------------------------------------------------------ */
/*  provisionWorktree                                                  */
/* ------------------------------------------------------------------ */

export interface ProvisionResult {
  ok: boolean;
  worktree?: Worktree;
  errors: string[];
}

/**
 * Provision a worktree + dedicated DB for a fix-loop agent.
 *
 * Idempotent: if the worktree path already exists or the branch already
 * exists locally, both are removed before re-adding. The DB is always
 * `DROP DATABASE IF EXISTS`d then re-created — this matches the Atelier
 * `WorktreeProvisioner::provision()` contract.
 *
 * The defaults come from `FIXLOOP_*` config (env-overridable). The base
 * worktree root is `<repo_root>/.claude/worktrees/agent-<task_id>`.
 */
export async function provisionWorktree(
  input: WorktreeCreateInput,
): Promise<ProvisionResult> {
  const errors: string[] = [];
  const taskId = input.task_id.trim();
  const repoRoot = input.repo_root;
  const baseRef = input.base_ref?.trim() || "origin/master";

  if (!TASK_ID_REGEX.test(taskId)) {
    errors.push(
      `Task id must be kebab-case (a-z, 0-9, -, _). Got: ${input.task_id}`,
    );
    return { ok: false, errors };
  }
  if (!repoRoot) {
    errors.push("repo_root is required.");
    return { ok: false, errors };
  }

  const worktreePath = deriveWorktreePath(repoRoot, taskId);
  const branch = deriveBranch(taskId);
  const dbName = deriveDbName(taskId);

  const pg: PgOptions = {
    host: FIXLOOP_PG_HOST,
    port: FIXLOOP_PG_PORT,
    user: FIXLOOP_PG_USER,
    password: FIXLOOP_PG_PASSWORD,
  };

  // ---- 1. Idempotent cleanup: remove any prior worktree + branch ----
  if (existsSync(worktreePath)) {
    // Best-effort — failures here are surfaced below if the add then fails.
    await runCommand("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
    });
    await runCommand("git", ["branch", "-D", branch], { cwd: repoRoot });
  }

  // ---- 2. git worktree add --no-track -b <branch> <path> <base_ref> ----
  const addRes = await runCommand(
    "git",
    ["worktree", "add", "--no-track", "-b", branch, worktreePath, baseRef],
    { cwd: repoRoot },
  );
  if (!addRes.ok) {
    errors.push(`git worktree add failed: ${addRes.stderr}`);
    return { ok: false, errors };
  }

  // ---- 3. DROP DATABASE IF EXISTS + CREATE DATABASE ... OWNER ----
  const env = pgEnv(pg);

  // DROP is best-effort — IF EXISTS makes it idempotent.
  await runCommand(
    "psql",
    [
      "-h", pg.host,
      "-p", pg.port,
      "-U", pg.user,
      "-d", "postgres",
      "-c", `DROP DATABASE IF EXISTS ${dbName}`,
    ],
    { env },
  );

  const createRes = await runCommand(
    "psql",
    [
      "-h", pg.host,
      "-p", pg.port,
      "-U", pg.user,
      "-d", "postgres",
      "-c", `CREATE DATABASE ${dbName} OWNER ${FIXLOOP_DB_OWNER}`,
    ],
    { env },
  );
  if (!createRes.ok) {
    errors.push(`CREATE DATABASE ${dbName} failed: ${createRes.stderr}`);
    return { ok: false, errors };
  }

  // ---- 4. CREATE EXTENSION IF NOT EXISTS vector (W33 requirement) ----
  const extRes = await runCommand(
    "psql",
    [
      "-h", pg.host,
      "-p", pg.port,
      "-U", pg.user,
      "-d", dbName,
      "-c", "CREATE EXTENSION IF NOT EXISTS vector",
    ],
    { env },
  );
  if (!extRes.ok) {
    // Non-fatal but the W33 agent_skills migration needs pgvector — surface it.
    errors.push(`CREATE EXTENSION vector failed (DB will be unusable for pgvector workloads): ${extRes.stderr}`);
  }

  const createdAt = new Date().toISOString();
  const expiresAt =
    input.ttl_hours && input.ttl_hours > 0
      ? new Date(Date.now() + input.ttl_hours * 3600 * 1000).toISOString()
      : undefined;

  const worktree: Worktree = {
    task_id: taskId,
    worktree_path: worktreePath,
    branch,
    base_ref: baseRef,
    db_host: pg.host,
    db_port: pg.port,
    db_username: pg.user,
    db_password: pg.password,
    db_database: dbName,
    created_at: createdAt,
    expires_at: expiresAt,
  };

  return { ok: errors.length === 0, worktree, errors };
}

/* ------------------------------------------------------------------ */
/*  removeWorktree                                                     */
/* ------------------------------------------------------------------ */

export interface RemoveResult {
  ok: boolean;
  errors: string[];
}

/**
 * Tear down a worktree + DB. Best-effort — never throws. Matches
 * `WaveCleanupService::cleanup()` semantics: `git worktree remove --force`
 * then `DROP DATABASE IF EXISTS`. Does NOT delete the local branch.
 */
export async function removeWorktree(
  input: WorktreeRemoveInput & { worktree_path: string; db_database: string },
): Promise<RemoveResult> {
  const errors: string[] = [];

  const wtRes = await runCommand(
    "git",
    ["worktree", "remove", "--force", input.worktree_path],
  );
  if (!wtRes.ok) {
    errors.push(
      `git worktree remove failed for '${input.task_id}' at ${input.worktree_path}: ${wtRes.stderr}`,
    );
  }

  const env = pgEnv({
    host: FIXLOOP_PG_HOST,
    port: FIXLOOP_PG_PORT,
    user: FIXLOOP_PG_USER,
    password: FIXLOOP_PG_PASSWORD,
  });

  const dropRes = await runCommand(
    "psql",
    [
      "-h", FIXLOOP_PG_HOST,
      "-p", FIXLOOP_PG_PORT,
      "-U", FIXLOOP_PG_USER,
      "-d", "postgres",
      "-c", `DROP DATABASE IF EXISTS ${input.db_database}`,
    ],
    { env },
  );
  if (!dropRes.ok) {
    errors.push(
      `drop database failed for '${input.task_id}' (db=${input.db_database}): ${dropRes.stderr}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/*  statusWorktree                                                     */
/* ------------------------------------------------------------------ */

export interface StatusResult {
  ok: boolean;
  task_id: string;
  registered: boolean;
  worktree_path_exists: boolean;
  db_reachable: boolean;
  worktree?: Worktree;
  errors: string[];
}

/**
 * Check whether a registered worktree is healthy: filesystem path exists
 * and the DB accepts `SELECT 1`. Caller passes the registry entry so this
 * function stays pure (no MCP coupling).
 */
export async function statusWorktree(worktree: Worktree): Promise<StatusResult> {
  const errors: string[] = [];

  const pathExists = existsSync(worktree.worktree_path);
  if (!pathExists) {
    errors.push(`worktree_path does not exist: ${worktree.worktree_path}`);
  }

  const env = pgEnv({
    host: worktree.db_host,
    port: worktree.db_port,
    user: worktree.db_username,
    password: worktree.db_password,
  });

  const pingRes = await runCommand(
    "psql",
    [
      "-h", worktree.db_host,
      "-p", worktree.db_port,
      "-U", worktree.db_username,
      "-d", worktree.db_database,
      "-tAc", "SELECT 1",
    ],
    { env, timeout: 15_000 },
  );

  const dbReachable = pingRes.ok;
  if (!dbReachable) {
    errors.push(`db unreachable (${worktree.db_database}): ${pingRes.stderr}`);
  }

  return {
    ok: pathExists && dbReachable,
    task_id: worktree.task_id,
    registered: true,
    worktree_path_exists: pathExists,
    db_reachable: dbReachable,
    worktree,
    errors,
  };
}

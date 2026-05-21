/**
 * Tool registry — imports all MCP tools and registers them with the server.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createInstance } from "./create-instance.js";
import { removeInstanceTool } from "./remove-instance.js";
import { updateInstance } from "./update-instance.js";
import { instanceHealth } from "./instance-health.js";
import { listInstances } from "./list-instances.js";
import { createBackup } from "./create-backup.js";
import { restoreBackup } from "./restore-backup.js";
import { listBackups } from "./list-backups.js";
import { runCommand } from "./run-command.js";
import { viewLogs } from "./view-logs.js";
import { dispatchFixLoopWave } from "./dispatch-fix-loop-wave.js";
import { harvestFixLoopWave } from "./harvest-fix-loop-wave.js";

import { worktreeCreate } from "./worktree-create.js";
import { worktreeRemove } from "./worktree-remove.js";
import { worktreeList } from "./worktree-list.js";
import { worktreeStatus } from "./worktree-status.js";

export function registerTools(server: McpServer): void {
  /* ---------------------------------------------------------------- */
  /*  create-instance                                                  */
  /* ---------------------------------------------------------------- */
  server.tool(
    "create-instance",
    "Provision a new dev environment instance from a git branch. " +
      "Clones the repo, sets up Docker, Caddy, Postgres, Redis, installs deps, " +
      "runs migrations, and starts the container. Rolls back on failure.",
    {
      branch: z.string().describe("Git branch to clone"),
      name: z.string().optional().describe("Short alphanumeric prefix (auto-derived from branch if omitted)"),
      display_name: z.string().optional().describe("Human-readable name"),
      timezone: z.string().optional().describe("Timezone for the instance (default UTC)"),
      db_dump_path: z.string().optional().describe("Path to a database dump to restore (relative to workspace or absolute)"),
      ttl_hours: z.number().optional().describe("Auto-expire after N hours (0 = no expiry)"),
    },
    async (params) => {
      const result = await createInstance(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  remove-instance                                                  */
  /* ---------------------------------------------------------------- */
  server.tool(
    "remove-instance",
    "Tear down a dev instance: stop container, remove compose entry, drop DB, " +
      "deregister, and delete files. Supports orphan cleanup.",
    {
      name: z.string().describe("Instance prefix to remove"),
      keep_database: z.boolean().optional().describe("Keep databases after removal"),
      keep_files: z.boolean().optional().describe("Keep project files after removal"),
      force_orphan_cleanup: z.boolean().optional().describe("Force cleanup even if instance is not in registry"),
    },
    async (params) => {
      const result = await removeInstanceTool(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  update-instance                                                  */
  /* ---------------------------------------------------------------- */
  server.tool(
    "update-instance",
    "Pull latest code and re-run the build pipeline: git pull, composer install, " +
      "npm install, vite build, migrate, optimize.",
    {
      name: z.string().describe("Instance prefix to update"),
      branch: z.string().optional().describe("Switch to a different branch (default: current branch)"),
    },
    async (params) => {
      const result = await updateInstance(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  instance-health                                                  */
  /* ---------------------------------------------------------------- */
  server.tool(
    "instance-health",
    "Run diagnostic health checks: container, database, Redis, resources, disk, migrations, HTTP.",
    {
      instance: z.string().describe("Instance prefix to check"),
    },
    async (params) => {
      const result = await instanceHealth(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  list-instances                                                   */
  /* ---------------------------------------------------------------- */
  server.tool(
    "list-instances",
    "List all registered dev instances with their status, URLs, and resource allocations.",
    {},
    async () => {
      const result = await listInstances();
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  create-backup                                                    */
  /* ---------------------------------------------------------------- */
  server.tool(
    "create-backup",
    "Create a full snapshot of workspace files and all databases with integrity checksums.",
    {
      name: z.string().optional().describe("Human-readable label for this backup"),
    },
    async (params) => {
      const result = await createBackup(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  restore-backup                                                   */
  /* ---------------------------------------------------------------- */
  server.tool(
    "restore-backup",
    'Restore a previously created backup. Supports selective restore (files, databases, or both). Use "latest" as backup_id for the most recent.',
    {
      backup_id: z.string().describe('Backup ID or "latest"'),
      restore_databases: z.boolean().optional().describe("Restore databases (default true)"),
      restore_files: z.boolean().optional().describe("Restore workspace files (default true)"),
    },
    async (params) => {
      const result = await restoreBackup(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  list-backups                                                     */
  /* ---------------------------------------------------------------- */
  server.tool(
    "list-backups",
    "List all available backups with their IDs, labels, and sizes.",
    {},
    async () => {
      const result = await listBackups();
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  run-command                                                      */
  /* ---------------------------------------------------------------- */
  server.tool(
    "run-command",
    "Execute a CLI command inside an instance container. Commands are validated against an allowlist for safety.",
    {
      instance: z.string().describe("Instance prefix"),
      command: z.string().describe("Command to run (e.g. 'php artisan migrate:status', 'npm run build')"),
      timeout: z.number().optional().describe("Timeout in ms (default 120000, max 600000)"),
    },
    async (params) => {
      const result = await runCommand(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ---------------------------------------------------------------- */
  /*  view-logs                                                        */
  /* ---------------------------------------------------------------- */
  server.tool(
    "view-logs",
    "Read application logs (Laravel), Docker container logs, or audit logs for an instance.",
    {
      instance: z.string().optional().describe("Instance prefix (required for laravel/docker sources)"),
      source: z.enum(["laravel", "docker", "audit"]).optional().describe("Log source (default: laravel)"),
      lines: z.number().optional().describe("Number of lines to return (default 100, max 1000)"),
      filter: z.string().optional().describe("Case-insensitive text filter"),
    },
    async (params) => {
      const result = await viewLogs(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ================================================================ */
  /*  worktree-*  — lightweight git-worktree-based fix-loop agents.   */
  /*                                                                  */
  /*  These are intentionally parallel to (but separate from) the     */
  /*  *-instance tools above. No Docker, no Caddy, no Redis, no port  */
  /*  allocation. They drive `git worktree add` against a shared      */
  /*  `.git` and `CREATE DATABASE` on an existing pgvector container. */
  /*                                                                  */
  /*  Authoritative behaviour spec:                                   */
  /*    app/Modules/Dev/Services/WorktreeProvisioner.php              */
  /*    app/Modules/Dev/Services/WaveCleanupService.php               */
  /*  in the Atelier (autonamyaiaiai/test) repo.                      */
  /* ================================================================ */

  server.tool(
    "worktree-create",
    "Provision a git-worktree + dedicated pgvector DB for a fix-loop coding agent. " +
      "Idempotent: re-running for the same task_id removes prior worktree+branch and drops+recreates the DB. " +
      "Creates the `vector` extension on the new DB (required for the W33 agent_skills migration).",
    {
      task_id: z.string().describe("Kebab-case task id (a-z, 0-9, -, _). Used as DB name + branch suffix."),
      repo_root: z.string().describe("Absolute path to the Atelier repo root (the worktree is created under <repo_root>/.claude/worktrees/agent-<task_id>)."),
      base_ref: z.string().optional().describe("Git ref to branch from (default 'origin/master')."),
      ttl_hours: z.number().optional().describe("Auto-expire after N hours (advisory; not enforced here)."),
    },
    async (params) => {
      const result = await worktreeCreate(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.tool(
    "worktree-remove",
    "Tear down a worktree: `git worktree remove --force` + `DROP DATABASE IF EXISTS`. " +
      "Best-effort — registry entry is removed even if git/psql fail so a half-cleaned worktree doesn't get stuck.",
    {
      task_id: z.string().describe("Task id of a registered worktree."),
    },
    async (params) => {
      const result = await worktreeRemove(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.tool(
    "worktree-list",
    "List all registered worktrees with their branch, path, and DB coordinates.",
    {},
    async () => {
      const result = await worktreeList();
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  server.tool(
    "worktree-status",
    "Health-check a registered worktree: does the filesystem path exist, and does `SELECT 1` succeed against the dedicated DB?",
    {
      task_id: z.string().describe("Task id of a registered worktree."),
    },
    async (params) => {
      const result = await worktreeStatus(params);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  /* ================================================================ */
  /*  fix-loop dispatch + harvest                                     */
  /*                                                                  */
  /*  Ports the dispatch + harvest halves of Atelier's L5-L9 fix-loop */
  /*  Actions (`dev.fix-loop.dispatch`, `dev.fix-loop.harvest`).       */
  /* ================================================================ */

  const fixLoopClusterSchema = z
    .object({
      cluster: z.string().describe("Cluster id (kebab-case)"),
      task_id: z.string().describe("Worktree task id"),
      worktree_path: z.string().describe("Absolute path to the cluster worktree"),
      db_database: z.string().describe("Dedicated pgvector database for the cluster"),
      tests: z.array(z.string()).describe("Failing tests the agent must drive to green"),
      diff_path: z.string().describe("Absolute path the agent writes its diff to"),
      report_path: z.string().describe("Absolute path the agent writes its report to"),
      status: z.string().optional(),
      dispatch_id: z.string().nullable().optional(),
      retry_count: z.number().optional(),
      report: z.string().optional(),
    })
    .passthrough();

  server.tool(
    "dispatch-fix-loop-wave",
    "Spawn a coding-agent bridge (claude-code, codex, amp, crush, or mock) for each cluster in a fix-loop wave. " +
      "Fire-and-forget: returns once spawned; the agent writes its diff/report to disk async. " +
      "Use `harvest-fix-loop-wave` to scan for completion.",
    {
      wave: z.string().describe("Wave identifier"),
      clusters: z.array(fixLoopClusterSchema).describe("Cluster specs (FixLoopWave JSONB shape)"),
      bridge: z
        .enum(["claude-code", "codex", "amp", "crush", "mock"])
        .optional()
        .describe("Override DEVMACHINE_FIXLOOP_BRIDGE for this call"),
    },
    async (params) => {
      const result = await dispatchFixLoopWave(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "harvest-fix-loop-wave",
    "Scan disk for each cluster's expected .diff / .report.md / .failed / .retry-failed artifacts " +
      "and return updated cluster specs plus a {harvested, failed, in_flight} count summary.",
    {
      wave: z.string().describe("Wave identifier"),
      clusters: z.array(fixLoopClusterSchema).describe("Cluster specs (FixLoopWave JSONB shape)"),
    },
    async (params) => {
      const result = await harvestFixLoopWave(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

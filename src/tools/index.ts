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
}

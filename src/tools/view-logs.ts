/**
 * view-logs — Read Laravel, Docker, or audit logs for an instance.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { BASE_DIR, PROJECT_SUBDIR } from "../config.js";

import type { ViewLogsInput, Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry } from "../lib/registry.js";

/* ------------------------------------------------------------------ */
/*  Log readers                                                        */
/* ------------------------------------------------------------------ */

function getDockerLogs(
  serviceName: string,
  lines: number,
  filter?: string,
): string {
  try {
    let cmd = `docker compose logs --no-color --tail=${lines} ${serviceName}`;
    if (filter) {
      cmd += ` 2>&1 | grep -i "${filter.replace(/"/g, '\\"')}"`;
    }
    return execSync(cmd, {
      cwd: BASE_DIR,
      stdio: "pipe",
      timeout: 30000,
      shell: filter ? "/bin/sh" : undefined,
    })
      .toString()
      .trim();
  } catch (err: any) {
    const output = err.stdout?.toString().trim();
    if (output) return output;
    return `No logs available for ${serviceName}`;
  }
}

function findLatestAppLog(instanceDir: string): string | null {
  const logDir = join(
    BASE_DIR,
    instanceDir,
    PROJECT_SUBDIR,
    "storage",
    "logs",
  );
  if (!existsSync(logDir)) return null;

  try {
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({
        name: f,
        path: join(logDir, f),
        mtime: statSync(join(logDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

async function getAppLogs(
  instanceDir: string,
  lines: number,
  filter?: string,
): Promise<string> {
  const logPath = findLatestAppLog(instanceDir);
  if (!logPath) {
    return `No log files found in ${instanceDir}/${PROJECT_SUBDIR}/storage/logs/`;
  }

  try {
    const content = await readFile(logPath, "utf-8");
    let logLines = content.split("\n");

    if (filter) {
      const lowerFilter = filter.toLowerCase();
      logLines = logLines.filter((line) =>
        line.toLowerCase().includes(lowerFilter),
      );
    }

    const result = logLines.slice(-lines).join("\n").trim();
    const logFile = logPath.split("/").pop();
    return `=== ${logFile} (last ${lines} lines${filter ? `, filter: "${filter}"` : ""}) ===\n\n${result || "(empty)"}`;
  } catch (err: any) {
    return `Error reading log: ${err.message}`;
  }
}

async function getAuditLogs(
  lines: number,
  filter?: string,
): Promise<string> {
  const auditPath = join(BASE_DIR, "mcp-server", "audit.jsonl");
  if (!existsSync(auditPath)) {
    return "No audit log found (audit.jsonl does not exist)";
  }

  try {
    const content = await readFile(auditPath, "utf-8");
    let logLines = content.split("\n").filter(Boolean);

    if (filter) {
      const lowerFilter = filter.toLowerCase();
      logLines = logLines.filter((line) =>
        line.toLowerCase().includes(lowerFilter),
      );
    }

    const entries = logLines.slice(-lines);

    // Format JSONL entries for readability
    const formatted = entries.map((line) => {
      try {
        const entry = JSON.parse(line);
        const time = entry.timestamp?.slice(0, 19) || "?";
        const action = entry.action || "?";
        const pfx = entry.prefix ? ` [${entry.prefix}]` : "";
        const detail = entry.detail || entry.error || "";
        return `${time}${pfx} ${action}${detail ? ": " + detail : ""}`;
      } catch {
        return line;
      }
    });

    return `=== Audit Log (last ${entries.length} entries${filter ? `, filter: "${filter}"` : ""}) ===\n\n${formatted.join("\n") || "(empty)"}`;
  } catch (err: any) {
    return `Error reading audit log: ${err.message}`;
  }
}

/* ------------------------------------------------------------------ */
/*  Main: viewLogs                                                     */
/* ------------------------------------------------------------------ */

export async function viewLogs(input: ViewLogsInput): Promise<string> {
  const lines = Math.min(Math.max(input.lines ?? 100, 1), 1000);
  const source = input.source ?? "laravel";

  // Audit logs don't need an instance
  if (source === "audit") {
    return getAuditLogs(lines, input.filter);
  }

  // For laravel/docker, resolve instance
  const registry = await loadRegistry();

  if (!input.instance) {
    // No instance specified
    if (source === "docker") {
      // Show combined docker logs
      return getDockerLogs("", lines, input.filter);
    }

    const names = registry.instances
      .map((i: Instance) => `  - ${i.prefix} (${i.display_name})`)
      .join("\n");
    return `Specify an instance to view logs:\n${names}\n\nUsage: instance="myapp", source="laravel" or "docker"`;
  }

  const instance = registry.instances.find(
    (i: Instance) => i.prefix === input.instance,
  );
  if (!instance) {
    return `Instance "${input.instance}" not found in registry`;
  }

  if (source === "docker") {
    const serviceName = `${instance.prefix}-app`;
    return getDockerLogs(serviceName, lines, input.filter);
  }

  // Default: application logs
  return getAppLogs(instance.directory, lines, input.filter);
}

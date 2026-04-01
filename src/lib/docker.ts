import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { BASE_DIR } from "../config.js";
import { validateDbName, quoteDbIdentifier } from "./sanitize.js";

function dc(args: string, timeout = 120000): string {
  return execSync(`docker compose ${args}`, {
    cwd: BASE_DIR,
    stdio: "pipe",
    timeout,
  }).toString();
}

export function startService(serviceName: string): string {
  return dc(`up -d ${serviceName}`, 180000);
}

export function stopService(serviceName: string): string {
  return dc(`stop ${serviceName}`);
}

export function removeService(serviceName: string): string {
  return dc(`rm -f ${serviceName}`);
}

export function restartCaddy(): string {
  return dc("up -d --force-recreate caddy", 180000);
}

export function execInService(serviceName: string, command: string, timeout = 300000, user = "sail"): string {
  return dc(`exec -T -u ${user} ${serviceName} ${command}`, timeout);
}

export function execInServiceAsRoot(serviceName: string, command: string, timeout = 300000): string {
  return execInService(serviceName, command, timeout, "root");
}

export function createDatabase(dbName: string): string {
  validateDbName(dbName);
  try {
    dc(`exec -T pgsql psql -U sail -d postgres -c "CREATE DATABASE ${quoteDbIdentifier(dbName)};"`, 30000);
    return `Created database ${dbName}`;
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string };
    if (e.stderr?.toString().includes("already exists")) {
      return `Database ${dbName} already exists`;
    }
    throw err;
  }
}

export function grantPrivileges(dbName: string): string {
  validateDbName(dbName);
  try {
    dc(`exec -T pgsql psql -U sail -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${quoteDbIdentifier(dbName)} TO sail;"`, 30000);
    return `Granted privileges on ${dbName}`;
  } catch {
    return `Warning: Could not grant privileges on ${dbName}`;
  }
}

export function dropDatabase(dbName: string): string {
  validateDbName(dbName);
  try {
    dc(`exec -T pgsql psql -U sail -d postgres -c "DROP DATABASE IF EXISTS ${quoteDbIdentifier(dbName)};"`, 30000);
    return `Dropped database ${dbName}`;
  } catch (err: unknown) {
    const e = err as { message?: string };
    return `Warning: Could not drop ${dbName}: ${e.message ?? String(err)}`;
  }
}

export function copyToService(serviceName: string, localPath: string, containerPath: string): void {
  dc(`cp ${localPath} ${serviceName}:${containerPath}`);
}

export function restoreDump(dbName: string, dumpPath: string): string {
  validateDbName(dbName);
  const containerDumpPath = `/tmp/${dbName}.dump`;
  dc(`cp ${dumpPath} pgsql:${containerDumpPath}`);
  try {
    dc(`exec -T pgsql pg_restore -U sail -d ${quoteDbIdentifier(dbName)} --no-owner --no-acl -j 4 ${containerDumpPath}`, 600000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string };
    const stderr = String(e.stderr ?? "").trim();
    if (stderr) {
      process.stderr.write(`[pg_restore:${dbName}] warnings: ${stderr.slice(0, 500)}\n`);
    }
  }
  dc(`exec -T pgsql rm ${containerDumpPath}`);
  return `Restored ${dumpPath} into ${dbName}`;
}

export function reloadCaddy(): string {
  return dc("exec -T caddy caddy reload --config /etc/caddy/Caddyfile", 30000);
}

export function isServiceRunning(serviceName: string): boolean {
  try {
    const output = dc(`ps --format json ${serviceName}`);
    return output.includes('"running"') || output.includes('"Up"');
  } catch {
    return false;
  }
}

export function listDatabases(suffix = "_db"): string[] {
  const output = dc(
    `exec -T pgsql psql -U sail -d postgres -t -A -c "SELECT datname FROM pg_database WHERE datname LIKE '%${suffix}' AND datname NOT LIKE '%_testing';"`,
    30000,
  );
  return output
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean);
}

export function dumpDatabase(dbName: string, outputPath: string): void {
  validateDbName(dbName);
  execSync(
    `docker compose exec -T pgsql pg_dump -U sail -Fc "${dbName}" > "${outputPath}"`,
    { cwd: BASE_DIR, stdio: "pipe", timeout: 600000, shell: "/bin/sh" },
  );
  try {
    const size = statSync(outputPath).size;
    if (size === 0) {
      throw new Error(`Database dump for ${dbName} is empty (0 bytes)`);
    }
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes("empty")) throw err;
    throw new Error(`Database dump for ${dbName} failed: output file not created`);
  }
}

export function listRunningAppServices(): string[] {
  try {
    const output = dc("ps --format json");
    const trimmed = output.trim();
    if (!trimmed) return [];

    const entries: Array<Record<string, unknown>> = [];
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed) as unknown[];
      entries.push(...(parsed as Array<Record<string, unknown>>));
    } else {
      for (const line of trimmed.split("\n")) {
        const text = line.trim();
        if (text) entries.push(JSON.parse(text) as Record<string, unknown>);
      }
    }

    return entries
      .filter((entry) => {
        const service = String(entry.Service ?? entry.Name ?? "");
        const state = String(entry.State ?? "").toLowerCase();
        return service.endsWith("-app") && (state === "running" || state.startsWith("up"));
      })
      .map((entry) => String(entry.Service ?? entry.Name ?? ""));
  } catch {
    return [];
  }
}

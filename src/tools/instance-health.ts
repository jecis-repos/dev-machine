/**
 * instance-health — Run diagnostic health checks on a dev instance.
 *
 * Checks: container, database, Redis, resources, disk, migrations, HTTP.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import {
  BASE_DIR,
  DOMAIN_SUFFIX,
  COMPOSE_PROJECT,
} from "../config.js";

import type { Instance, InstanceHealthInput } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry } from "../lib/registry.js";
import { isServiceRunning, execInService } from "../lib/docker.js";

/* ------------------------------------------------------------------ */
/*  Individual checks                                                  */
/* ------------------------------------------------------------------ */

interface HealthCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

function checkContainer(prefix: string): HealthCheck {
  const serviceName = `${prefix}-app`;
  const running = isServiceRunning(serviceName);
  return {
    name: "Container",
    status: running ? "pass" : "fail",
    detail: running
      ? `${serviceName} is running`
      : `${serviceName} is NOT running`,
  };
}

function checkDatabase(prefix: string, dbName: string): HealthCheck {
  try {
    const result = execSync(
      `docker compose exec -T pgsql psql -U sail -d "${dbName}" -c "SELECT 1;" -t -A`,
      { cwd: BASE_DIR, stdio: "pipe", timeout: 10000 },
    )
      .toString()
      .trim();
    return {
      name: "Database",
      status: result.includes("1") ? "pass" : "warn",
      detail: `${dbName}: connected`,
    };
  } catch (err: any) {
    return {
      name: "Database",
      status: "fail",
      detail: `${dbName}: connection failed — ${err.message?.slice(0, 100)}`,
    };
  }
}

function checkRedis(instance: Instance): HealthCheck {
  try {
    const result = execSync(
      `docker compose exec -T redis redis-cli -n ${instance.redis_db} PING`,
      { cwd: BASE_DIR, stdio: "pipe", timeout: 5000 },
    )
      .toString()
      .trim();
    return {
      name: "Redis",
      status: result === "PONG" ? "pass" : "warn",
      detail: `DB ${instance.redis_db}/${instance.redis_cache_db}: ${result}`,
    };
  } catch (err: any) {
    return {
      name: "Redis",
      status: "fail",
      detail: `Redis connection failed — ${err.message?.slice(0, 100)}`,
    };
  }
}

function checkDiskSpace(directory: string): HealthCheck {
  try {
    const dirPath = join(BASE_DIR, directory);
    if (!existsSync(dirPath)) {
      return {
        name: "Disk",
        status: "fail",
        detail: `Directory ${directory} does not exist`,
      };
    }

    // Get instance directory size
    const duOutput = execSync(
      `du -sh "${dirPath}" 2>/dev/null | cut -f1`,
      { stdio: "pipe", timeout: 30000, shell: "/bin/sh" },
    )
      .toString()
      .trim();

    // Get available disk space
    const dfOutput = execSync(
      `df -h "${dirPath}" | tail -1 | awk '{print $4}'`,
      { stdio: "pipe", timeout: 10000, shell: "/bin/sh" },
    )
      .toString()
      .trim();

    // Parse available space — warn if under 5GB
    const dfBytes = execSync(
      `df -B1 "${dirPath}" | tail -1 | awk '{print $4}'`,
      { stdio: "pipe", timeout: 10000, shell: "/bin/sh" },
    )
      .toString()
      .trim();
    const availableGB = parseInt(dfBytes, 10) / 1024 ** 3;

    let status: "pass" | "warn" | "fail" = "pass";
    if (availableGB < 2) status = "fail";
    else if (availableGB < 5) status = "warn";

    return {
      name: "Disk",
      status,
      detail: `Instance: ${duOutput}, Available: ${dfOutput}`,
    };
  } catch (err: any) {
    return {
      name: "Disk",
      status: "warn",
      detail: `Could not check disk: ${err.message?.slice(0, 80)}`,
    };
  }
}

function checkMigrations(prefix: string): HealthCheck {
  const serviceName = `${prefix}-app`;
  try {
    const output = execInService(
      serviceName,
      "php artisan migrate:status --no-interaction 2>&1",
      15000,
    );
    const pendingLines = output
      .split("\n")
      .filter((l: string) => l.includes("Pending"));
    if (pendingLines.length > 0) {
      return {
        name: "Migrations",
        status: "warn",
        detail: `${pendingLines.length} pending migration(s)`,
      };
    }
    return {
      name: "Migrations",
      status: "pass",
      detail: "All migrations applied",
    };
  } catch (err: any) {
    if (!isServiceRunning(serviceName)) {
      return {
        name: "Migrations",
        status: "fail",
        detail: "Container not running",
      };
    }
    return {
      name: "Migrations",
      status: "warn",
      detail: `Could not check: ${err.message?.slice(0, 80)}`,
    };
  }
}

function checkResources(prefix: string): HealthCheck {
  const containerName = `${COMPOSE_PROJECT}-${prefix}-app-1`;
  try {
    const output = execSync(
      `docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" ${containerName}`,
      { stdio: "pipe", timeout: 15000, shell: "/bin/sh" },
    )
      .toString()
      .trim();

    if (!output) {
      return {
        name: "Resources",
        status: "warn",
        detail: "No stats available",
      };
    }

    const [cpuPct, memUsage, memPct] = output.split("|");
    const memPercNum = parseFloat((memPct || "0").replace("%", ""));

    let status: "pass" | "warn" | "fail" = "pass";
    if (memPercNum > 90) status = "fail";
    else if (memPercNum > 75) status = "warn";

    return {
      name: "Resources",
      status,
      detail: `CPU: ${cpuPct?.trim()}, Memory: ${memUsage?.trim()} (${memPct?.trim()})`,
    };
  } catch {
    return {
      name: "Resources",
      status: "warn",
      detail: "Container not running or stats unavailable",
    };
  }
}

function checkHttp(prefix: string): HealthCheck {
  const url = `https://${prefix}.${DOMAIN_SUFFIX}`;
  try {
    const output = execSync(
      `curl -sSk -o /dev/null -w "%{http_code}" --max-time 5 "${url}"`,
      { stdio: "pipe", timeout: 10000, shell: "/bin/sh" },
    )
      .toString()
      .trim();

    const code = parseInt(output, 10);
    if (code >= 200 && code < 400) {
      return { name: "HTTP", status: "pass", detail: `${url} -> ${code}` };
    }
    if (code === 500 || code === 502 || code === 503) {
      return { name: "HTTP", status: "fail", detail: `${url} -> ${code}` };
    }
    return { name: "HTTP", status: "warn", detail: `${url} -> ${code}` };
  } catch {
    return { name: "HTTP", status: "warn", detail: `${url} -> unreachable` };
  }
}

/* ------------------------------------------------------------------ */
/*  Main: instanceHealth                                               */
/* ------------------------------------------------------------------ */

export async function instanceHealth(
  input: InstanceHealthInput,
): Promise<string> {
  const registry = await loadRegistry();
  const instance = registry.instances.find(
    (i: Instance) => i.prefix === input.instance,
  );

  if (!instance) {
    return `Instance "${input.instance}" not found. Available: ${registry.instances.map((i: Instance) => i.prefix).join(", ")}`;
  }

  const checks: HealthCheck[] = [
    checkContainer(instance.prefix),
    checkDatabase(instance.prefix, instance.db_name),
    checkRedis(instance),
    checkResources(instance.prefix),
    checkDiskSpace(instance.directory),
    checkMigrations(instance.prefix),
    checkHttp(instance.prefix),
  ];

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  let overall: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (failCount > 0) overall = "unhealthy";
  else if (warnCount > 0) overall = "degraded";

  const statusIcon = (s: string): string =>
    s === "pass" ? "OK" : s === "warn" ? "WARN" : "FAIL";
  const lines = [
    `Health Check: ${instance.display_name} (${instance.prefix})`,
    `Overall: ${overall.toUpperCase()}`,
    "",
    ...checks.map(
      (c) => `  [${statusIcon(c.status)}] ${c.name}: ${c.detail}`,
    ),
  ];

  return lines.join("\n");
}

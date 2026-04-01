/**
 * list-instances — Return all registered dev instances as JSON.
 */

import { instanceHostname } from "../config.js";
import type { Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry } from "../lib/registry.js";
import { isServiceRunning } from "../lib/docker.js";

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function listInstances(): Promise<string> {
  const registry = await loadRegistry();

  if (registry.instances.length === 0) {
    return "No instances registered.";
  }

  const rows = registry.instances.map((inst: Instance) => {
    const running = isServiceRunning(`${inst.prefix}-app`);
    return {
      prefix: inst.prefix,
      name: inst.display_name,
      branch: inst.branch,
      url: `https://${instanceHostname(inst.prefix)}`,
      vite_port: inst.vite_port,
      redis_db: `${inst.redis_db}/${inst.redis_cache_db}`,
      db: inst.db_name,
      status:
        inst.status === "provisioning"
          ? "provisioning"
          : inst.status === "updating"
            ? "updating"
            : running
              ? "running"
              : "stopped",
      timezone: inst.timezone,
      created_at: inst.created_at
        ? formatRelativeTime(inst.created_at)
        : undefined,
      expires_at: inst.expires_at || undefined,
    };
  });

  return JSON.stringify(rows, null, 2);
}

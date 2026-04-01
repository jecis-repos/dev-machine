/**
 * run-command — Execute a CLI command inside an instance container.
 *
 * Generalised from artisan-specific to a generic passthrough with
 * security validation (allowlist / blocklist).
 */

import type { RunCommandInput, Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import { loadRegistry } from "../lib/registry.js";
import { execInService, isServiceRunning } from "../lib/docker.js";
import { auditLog } from "../lib/audit-log.js";

/* ------------------------------------------------------------------ */
/*  Allowlist / blocklist                                              */
/* ------------------------------------------------------------------ */

/**
 * Allowlisted command prefixes.  Only these are permitted.
 * Prevents destructive commands like `down`, `env`, `tinker`, `db:wipe`.
 */
const ALLOWED_COMMANDS = [
  // Artisan / Laravel
  "php artisan migrate",
  "php artisan migrate:status",
  "php artisan migrate:fresh",
  "php artisan db:seed",
  "php artisan cache:clear",
  "php artisan config:clear",
  "php artisan view:clear",
  "php artisan route:clear",
  "php artisan event:clear",
  "php artisan optimize:clear",
  "php artisan optimize",
  "php artisan queue:work",
  "php artisan queue:retry",
  "php artisan queue:failed",
  "php artisan queue:flush",
  "php artisan schedule:list",
  "php artisan storage:link",
  "php artisan package:discover",
  "php artisan key:generate",
  "php artisan test",
  "php artisan about",
  "php artisan route:list",
  "php artisan model:show",
  "php artisan ide-helper:generate",
  "php artisan ide-helper:models",
  "php artisan ide-helper:meta",
  // Generic CLI
  "composer install",
  "composer update",
  "composer dump-autoload",
  "npm install",
  "npm run",
  "npm test",
  "npx vite build",
  "node -v",
  "php -v",
  "composer -V",
];

/**
 * Commands that are always blocked regardless of prefix match.
 */
const BLOCKED_COMMANDS = [
  "php artisan down",
  "php artisan up",
  "php artisan env",
  "php artisan tinker",
  "php artisan db:wipe",
  "php artisan make:",
  "rm ",
  "rm -",
  "sudo ",
  "chmod ",
  "chown ",
  "curl ",
  "wget ",
  "dd ",
  "mkfs",
  "shutdown",
  "reboot",
];

function isCommandAllowed(
  command: string,
): { allowed: boolean; reason?: string } {
  const normalizedCmd = command.trim().toLowerCase();

  // Check blocked list first
  for (const blocked of BLOCKED_COMMANDS) {
    if (
      normalizedCmd === blocked.trim() ||
      normalizedCmd.startsWith(blocked.trim())
    ) {
      return {
        allowed: false,
        reason: `"${blocked.trim()}" is blocked on dev instances`,
      };
    }
  }

  // Check allowlist
  for (const allowed of ALLOWED_COMMANDS) {
    const normalizedAllowed = allowed.toLowerCase();
    if (
      normalizedCmd === normalizedAllowed ||
      normalizedCmd.startsWith(`${normalizedAllowed} `) ||
      normalizedCmd.startsWith(`${normalizedAllowed}:`)
    ) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Command not in allowlist. Allowed prefixes: ${ALLOWED_COMMANDS.join(", ")}`,
  };
}

function sanitizeCommandArgs(command: string): string {
  // Strip shell metacharacters that could escape the command
  if (/[;&|`$(){}[\]<>!#~]/.test(command)) {
    throw new Error("Command contains disallowed shell characters");
  }
  return command.trim();
}

/* ------------------------------------------------------------------ */
/*  Main: runCommand                                                   */
/* ------------------------------------------------------------------ */

export async function runCommand(input: RunCommandInput): Promise<string> {
  const registry = await loadRegistry();
  const instance = registry.instances.find(
    (i: Instance) => i.prefix === input.instance,
  );

  if (!instance) {
    return `Instance "${input.instance}" not found. Available: ${registry.instances.map((i: Instance) => i.prefix).join(", ")}`;
  }

  const serviceName = `${instance.prefix}-app`;
  if (!isServiceRunning(serviceName)) {
    return `Container ${serviceName} is not running. Start it first.`;
  }

  let command: string;
  try {
    command = sanitizeCommandArgs(input.command);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  const check = isCommandAllowed(command);
  if (!check.allowed) {
    return `Blocked: ${check.reason}`;
  }

  const timeout = Math.min(Math.max(input.timeout ?? 120000, 5000), 600000);

  auditLog("run_command", {
    prefix: instance.prefix,
    detail: command,
  });

  try {
    const output = execInService(serviceName, command, timeout);
    return `=== ${command} (${instance.display_name}) ===\n\n${output.trim()}`;
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() || "";
    const stdout = err.stdout?.toString().trim() || "";
    const output = stdout || stderr || err.message;
    return `=== ${command} FAILED (${instance.display_name}) ===\n\n${output.slice(0, 4000)}`;
  }
}

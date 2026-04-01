/**
 * update-instance — Pull latest code and re-run build pipeline.
 *
 * Sequence: git pull -> deps -> migrate -> optimize
 * Resets status back to ready on failure so the instance remains usable.
 */

import { execFileSync } from "child_process";
import { join } from "path";

import { BASE_DIR, PROJECT_SUBDIR, instanceHostname } from "../config.js";

import type { UpdateInstanceInput, Instance } from "../types.js";

// TODO: Switch to "mcp-infra-toolkit" once published
import {
  loadRegistry,
  updateInstance as updateRegistryInstance,
} from "../lib/registry.js";
import {
  execInService,
  execInServiceAsRoot,
  isServiceRunning,
  startService,
} from "../lib/docker.js";
import { loadStagingCommands } from "../lib/staging-commands.js";
import { auditLog } from "../lib/audit-log.js";
import { notifyWebhook } from "../lib/webhook.js";
import { BuildProgress } from "../lib/build-status.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function summarizeError(error: unknown, maxLength = 1200): string {
  const err = error as {
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };

  const parts: string[] = [];
  const message = String(err?.message ?? error ?? "unknown error").trim();
  if (message) parts.push(message);

  const stdout =
    err?.stdout === undefined
      ? ""
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf-8")
        : String(err.stdout);
  if (stdout.trim()) parts.push(stdout.trim());

  const stderr =
    err?.stderr === undefined
      ? ""
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf-8")
        : String(err.stderr);
  if (stderr.trim()) parts.push(stderr.trim());

  const raw = parts.join("\n").trim() || "unknown error";
  if (raw.length <= maxLength) return raw;

  const headLength = Math.max(200, Math.floor(maxLength * 0.65));
  const tailLength = Math.max(120, maxLength - headLength - 8);
  return `${raw.slice(0, headLength)}\n...\n${raw.slice(-tailLength)}`;
}

function resolveGithubToken(): string | undefined {
  try {
    const ghToken = execFileSync("gh", ["auth", "token"], {
      stdio: "pipe",
      timeout: 15000,
      encoding: "utf-8",
    }).trim();
    if (ghToken) return ghToken;
  } catch {
    // Fall through
  }
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    undefined
  );
}

function gitExtraHeaderArg(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `-c http.https://github.com/.extraheader="Authorization: basic ${encoded}"`;
}

/* ------------------------------------------------------------------ */
/*  Main: updateInstance                                                */
/* ------------------------------------------------------------------ */

export async function updateInstance(
  input: UpdateInstanceInput,
): Promise<string> {
  const log: string[] = [];
  const step = (msg: string) => {
    log.push(msg);
  };

  const prefix = input.name.trim();
  if (!prefix) return "ERROR: Instance name is required.";

  let progress: BuildProgress | undefined;

  try {
    // 1. Find instance in registry
    const registry = await loadRegistry();
    const instance = registry.instances.find((i: Instance) => i.prefix === prefix);
    if (!instance) {
      return `ERROR: Instance "${prefix}" not found in registry.`;
    }

    const branch = input.branch?.trim() || instance.branch;
    const svc = `${prefix}-app`;
    const checkoutDir = join(BASE_DIR, instance.directory, PROJECT_SUBDIR);

    progress = new BuildProgress(
      prefix,
      branch,
      instance.display_name,
      "update",
    );
    await progress.deploy();

    step(`Updating instance "${prefix}" (branch: ${branch})`);
    auditLog("update_instance:start", {
      prefix,
      detail: `branch=${branch}`,
    });

    // 2. Ensure container is running
    await progress.begin(1);
    if (!isServiceRunning(svc)) {
      step("[1/8] Container not running, starting...");
      try {
        startService(svc);
        step("[1/8] Container started");
      } catch (e) {
        throw new Error(
          `Cannot start container ${svc}: ${summarizeError(e)}`,
        );
      }
    } else {
      step("[1/8] Container running");
    }
    await progress.complete(1);

    // 3. Mark as updating
    await progress.begin(2);
    await updateRegistryInstance(prefix, { status: "updating" });
    step("[2/8] Status: updating");
    await progress.complete(2);

    // 4. Git pull (root for mixed ownership in .git + auth)
    await progress.begin(3);
    step("[3/8] Pulling latest code...");
    const token = resolveGithubToken();
    const gitAuth = token ? gitExtraHeaderArg(token) : "";
    try {
      execInServiceAsRoot(
        svc,
        "git config --global --add safe.directory /var/www/html 2>&1",
        10000,
      );
    } catch {
      // May already be set
    }
    try {
      const pullOutput = execInServiceAsRoot(
        svc,
        `git ${gitAuth} -C /var/www/html pull origin ${branch} --ff-only 2>&1`,
        120000,
      );
      step(
        `[3/8] ${pullOutput.trim().split("\n").pop() || "git pull done"}`,
      );
    } catch {
      step("[3/8] Fast-forward failed, trying fetch + reset...");
      try {
        execInServiceAsRoot(
          svc,
          `git ${gitAuth} -C /var/www/html fetch origin ${branch} 2>&1`,
          120000,
        );
        execInServiceAsRoot(
          svc,
          `git -C /var/www/html reset --hard origin/${branch} 2>&1`,
          60000,
        );
        step("[3/8] Reset to latest remote state");
      } catch (e) {
        throw new Error(`Git update failed: ${summarizeError(e)}`);
      }
    }

    // Fix ownership after git operations so app user can work with files
    try {
      execInServiceAsRoot(
        svc,
        "chown -R sail:sail /var/www/html/.git",
        60000,
      );
    } catch {
      // Non-critical — git ops already succeeded
    }
    await progress.complete(3);

    // 5. Composer install
    await progress.begin(4);
    step("[4/8] Installing composer dependencies...");
    try {
      execInServiceAsRoot(
        svc,
        "composer install --no-interaction --no-scripts",
        600000,
      );
      execInServiceAsRoot(
        svc,
        "php artisan package:discover --ansi",
        300000,
      );
      step("[4/8] Composer install done");
    } catch (e) {
      throw new Error(`Composer install failed: ${summarizeError(e)}`);
    }
    await progress.complete(4);

    // 6. npm install + vite build
    await progress.begin(5);
    step("[5/8] Building frontend assets...");
    try {
      execInService(svc, "npm install", 300000);
      step("[5/8] npm install done");
    } catch (e) {
      step(`[5/8] Warning: npm install: ${summarizeError(e)}`);
    }

    try {
      execInService(svc, "npx vite build", 120000);
      step("[5/8] Vite build done");
    } catch (e) {
      step(`[5/8] Warning: vite build: ${summarizeError(e)}`);
    }

    // Fix permissions
    try {
      execInServiceAsRoot(
        svc,
        "sh -lc 'chown -R sail:sail /var/www/html/storage /var/www/html/bootstrap/cache'",
        120000,
      );
    } catch (e) {
      step(`[5/8] Warning: ownership fix: ${summarizeError(e)}`);
    }
    await progress.complete(5);

    // Load staging commands
    const stagingCmds = loadStagingCommands(checkoutDir, step);

    // Run before_optimize commands
    for (const cmd of stagingCmds.beforeOptimize) {
      try {
        execInService(svc, cmd, 300000);
        step(`[6/8] ${cmd} done`);
      } catch (e) {
        step(`[6/8] Warning: ${cmd}: ${summarizeError(e)}`);
      }
    }

    // 7. Migrate
    await progress.begin(6);
    step("[6/8] Running migrations...");
    try {
      execInService(svc, "php artisan migrate --force", 300000);
      step("[6/8] Migrations done");
    } catch (e) {
      step(`[6/8] Warning: migrate: ${summarizeError(e)}`);
    }
    await progress.complete(6);

    // 8. Post-update hooks (reserved for framework-specific commands from staging.json)
    await progress.begin(7);
    step("[7/8] Post-update hooks...");
    await progress.complete(7);

    // 9. Optimize
    await progress.begin(8);
    if (!stagingCmds.skipOptimize) {
      const optimizeCmds = [
        "icons:cache",
        "event:cache",
        "view:cache",
        "route:cache",
        "config:cache",
        ...stagingCmds.extraOptimize.map((c: string) =>
          c.replace(/^php artisan /, ""),
        ),
      ];
      for (const cmd of optimizeCmds) {
        try {
          const fullCmd = cmd.startsWith("php artisan ")
            ? cmd
            : `php artisan ${cmd}`;
          execInService(svc, fullCmd);
        } catch {
          // Non-critical
        }
      }
      step("[8/8] Optimization complete");
    } else {
      step("[8/8] Optimization skipped (staging.json)");
    }

    // Run after_optimize commands
    for (const cmd of stagingCmds.afterOptimize) {
      try {
        execInService(svc, cmd, 300000);
        step(`[8/8] ${cmd} done`);
      } catch (e) {
        step(`[8/8] Warning: ${cmd}: ${summarizeError(e)}`);
      }
    }
    await progress.complete(8);

    // Mark as ready
    await updateRegistryInstance(prefix, { status: undefined, branch });
    await progress.finish();

    const url = `https://${instanceHostname(prefix)}`;
    step("");
    step(`Instance "${prefix}" updated successfully!`);
    step(`URL: ${url}`);
    step(`Branch: ${branch}`);

    auditLog("update_instance:success", { prefix, detail: `url=${url}` });
    notifyWebhook("instance_updated", { prefix, url, branch }).catch(
      () => {},
    );

    return log.join("\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    step(`\nERROR: ${message}`);
    auditLog("update_instance:error", { prefix, error: message });

    if (progress) {
      await progress
        .fail(progress.currentStep || 1, message)
        .catch(() => {});
    }

    // Reset status back to ready (instance still works, just not updated)
    try {
      await updateRegistryInstance(prefix, { status: undefined });
    } catch {
      // Best effort
    }

    return log.join("\n");
  }
}

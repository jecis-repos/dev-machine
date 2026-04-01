import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StagingCommands {
  beforeOptimize: string[];
  afterOptimize: string[];
  extraOptimize: string[];
  skipOptimize: boolean;
  skipAdminCreation: boolean;
}

/**
 * Load per-branch staging commands from a staging.json file in the checkout.
 * This allows branches to customize the build pipeline (e.g., run seeders,
 * skip optimization, add custom artisan commands).
 *
 * Expected format:
 * {
 *   "before_optimize": ["php artisan db:seed --class=SomeSeeder"],
 *   "after_optimize": ["php artisan some:command"],
 *   "extra_optimize": ["php artisan custom:cache"],
 *   "skip_optimize": false,
 *   "skip_admin_creation": false
 * }
 */
export function loadStagingCommands(
  checkoutDir: string,
  step: (msg: string) => void,
): StagingCommands {
  const defaults: StagingCommands = {
    beforeOptimize: [],
    afterOptimize: [],
    extraOptimize: [],
    skipOptimize: false,
    skipAdminCreation: false,
  };

  const stagingPath = join(checkoutDir, "staging.json");
  if (!existsSync(stagingPath)) {
    return defaults;
  }

  try {
    const raw = JSON.parse(readFileSync(stagingPath, "utf-8")) as Record<string, unknown>;
    step("[staging.json] Loaded custom staging configuration");

    return {
      beforeOptimize: asStringArray(raw.before_optimize),
      afterOptimize: asStringArray(raw.after_optimize),
      extraOptimize: asStringArray(raw.extra_optimize),
      skipOptimize: raw.skip_optimize === true,
      skipAdminCreation: raw.skip_admin_creation === true,
    };
  } catch (err) {
    step(`[staging.json] Warning: could not parse: ${err instanceof Error ? err.message : String(err)}`);
    return defaults;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

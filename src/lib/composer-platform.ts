import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PHP_IMAGE } from "../config.js";

interface RuntimeSelection {
  image: string;
  phpVersion: string;
}

export interface ComposerRuntimeResult {
  rootPhpConstraint: string | null;
  requiredExtensions: string[];
  selected: RuntimeSelection;
}

/**
 * Known PHP Docker images mapped from semver constraints.
 * Ordered from newest to oldest.
 */
const PHP_IMAGE_MAP: Array<{ constraint: string; image: string; version: string }> = [
  { constraint: "^8.4", image: "php:8.4-fpm", version: "8.4" },
  { constraint: "^8.3", image: "php:8.3-fpm", version: "8.3" },
  { constraint: "^8.2", image: "php:8.2-fpm", version: "8.2" },
  { constraint: "^8.1", image: "php:8.1-fpm", version: "8.1" },
  { constraint: "^8.0", image: "php:8.0-fpm", version: "8.0" },
];

/**
 * Inspect a checkout directory's composer.json to determine the correct
 * PHP Docker image and required extensions.
 */
export function resolveComposerRuntimeForCheckout(
  checkoutDir: string,
  log: (line: string) => void,
): ComposerRuntimeResult {
  const composerPath = join(checkoutDir, "composer.json");

  if (!existsSync(composerPath)) {
    log("No composer.json found, using default PHP image");
    return {
      rootPhpConstraint: null,
      requiredExtensions: [],
      selected: { image: DEFAULT_PHP_IMAGE, phpVersion: extractVersion(DEFAULT_PHP_IMAGE) },
    };
  }

  let composerJson: Record<string, unknown>;
  try {
    composerJson = JSON.parse(readFileSync(composerPath, "utf-8")) as Record<string, unknown>;
  } catch {
    log("Could not parse composer.json, using default PHP image");
    return {
      rootPhpConstraint: null,
      requiredExtensions: [],
      selected: { image: DEFAULT_PHP_IMAGE, phpVersion: extractVersion(DEFAULT_PHP_IMAGE) },
    };
  }

  const require = composerJson.require as Record<string, string> | undefined;
  const phpConstraint = require?.php ?? null;

  // Collect ext-* requirements
  const extensions: string[] = [];
  if (require) {
    for (const key of Object.keys(require)) {
      if (key.startsWith("ext-")) {
        extensions.push(key.replace("ext-", ""));
      }
    }
  }

  if (!phpConstraint) {
    log("No PHP constraint in composer.json, using default");
    return {
      rootPhpConstraint: null,
      requiredExtensions: extensions,
      selected: { image: DEFAULT_PHP_IMAGE, phpVersion: extractVersion(DEFAULT_PHP_IMAGE) },
    };
  }

  // Try to match the constraint to a known image
  for (const entry of PHP_IMAGE_MAP) {
    if (constraintSatisfies(phpConstraint, entry.version)) {
      return {
        rootPhpConstraint: phpConstraint,
        requiredExtensions: extensions,
        selected: { image: entry.image, phpVersion: entry.version },
      };
    }
  }

  // Fallback to default
  log(`PHP constraint "${phpConstraint}" did not match any known image, using default`);
  return {
    rootPhpConstraint: phpConstraint,
    requiredExtensions: extensions,
    selected: { image: DEFAULT_PHP_IMAGE, phpVersion: extractVersion(DEFAULT_PHP_IMAGE) },
  };
}

/**
 * Simple heuristic: check if a PHP version satisfies a composer constraint.
 * Handles common patterns: ^8.2, >=8.1, 8.3.*, etc.
 */
function constraintSatisfies(constraint: string, version: string): boolean {
  const parts = constraint.split("||").map((s) => s.trim());
  return parts.some((part) => {
    const cleaned = part.replace(/\s+/g, "");
    if (cleaned.startsWith("^")) {
      const minVersion = cleaned.slice(1);
      return versionGte(version, minVersion);
    }
    if (cleaned.startsWith(">=")) {
      const minVersion = cleaned.slice(2);
      return versionGte(version, minVersion);
    }
    if (cleaned.includes("*")) {
      const prefix = cleaned.replace(".*", "").replace("*", "");
      return version.startsWith(prefix);
    }
    return version.startsWith(cleaned);
  });
}

function versionGte(a: string, b: string): boolean {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

function extractVersion(image: string): string {
  const match = image.match(/(\d+\.\d+)/);
  return match?.[1] ?? "8.4";
}

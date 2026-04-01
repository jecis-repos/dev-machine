import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

interface PreflightInput {
  prefix: string;
  checkoutDir: string;
  certExists: boolean;
  dbDumpPath?: string;
}

/**
 * Run local prerequisite checks before creating an instance.
 * Returns an array of human-readable status lines.
 */
export async function runCreateInstancePreflight(
  input: PreflightInput,
): Promise<string[]> {
  const checks: string[] = [];

  // Docker running
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10000 });
    checks.push("Docker: running");
  } catch {
    checks.push("Docker: NOT running (required)");
  }

  // Docker Compose available
  try {
    execSync("docker compose version", { stdio: "pipe", timeout: 5000 });
    checks.push("Docker Compose: available");
  } catch {
    checks.push("Docker Compose: NOT available (required)");
  }

  // Git available
  try {
    execSync("git --version", { stdio: "pipe", timeout: 5000 });
    checks.push("Git: available");
  } catch {
    checks.push("Git: NOT available (required)");
  }

  // Certificate status
  checks.push(
    input.certExists
      ? "TLS certificates: found"
      : "TLS certificates: not found (will be generated)",
  );

  // Checkout dir should not exist yet
  if (existsSync(input.checkoutDir)) {
    checks.push(`Checkout directory: EXISTS (${input.checkoutDir}) - may conflict`);
  } else {
    checks.push("Checkout directory: clear");
  }

  // DB dump file (if specified)
  if (input.dbDumpPath) {
    if (existsSync(input.dbDumpPath)) {
      checks.push(`Database dump: found at ${input.dbDumpPath}`);
    } else {
      checks.push(`Database dump: NOT found at ${input.dbDumpPath}`);
    }
  }

  return checks;
}

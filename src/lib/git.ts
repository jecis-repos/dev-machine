import { execSync } from "node:child_process";
import { join } from "node:path";
import { BASE_DIR, PROJECT_SUBDIR } from "../config.js";

/**
 * Validate that a branch exists in the configured remote.
 * Throws if the branch cannot be found.
 */
export function validateBranch(branch: string): void {
  try {
    execSync(`git ls-remote --exit-code --heads origin "${branch}"`, {
      cwd: BASE_DIR,
      stdio: "pipe",
      timeout: 30000,
    });
  } catch {
    throw new Error(
      `Branch "${branch}" not found on remote. Verify the branch exists and push it first.`,
    );
  }
}

/**
 * Clone a specific branch into the instance directory.
 * The checkout is placed at BASE_DIR/<directory>/PROJECT_SUBDIR.
 */
export function cloneRepo(branch: string, directory: string): void {
  const instanceDir = join(BASE_DIR, directory);
  const checkoutDir = join(instanceDir, PROJECT_SUBDIR);

  // Resolve GitHub token for private repo authentication
  let tokenArgs = "";
  const token = resolveGithubToken();
  if (token) {
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    tokenArgs = `-c http.https://github.com/.extraheader="Authorization: basic ${encoded}"`;
  }

  const remoteUrl = getRemoteUrl();
  execSync(
    `git ${tokenArgs} clone --single-branch --branch "${branch}" --depth 1 "${remoteUrl}" "${checkoutDir}"`,
    { cwd: BASE_DIR, stdio: "pipe", timeout: 300000 },
  );
}

function resolveGithubToken(): string | undefined {
  try {
    const ghToken = execSync("gh auth token", {
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

function getRemoteUrl(): string {
  try {
    return execSync("git remote get-url origin", {
      cwd: BASE_DIR,
      stdio: "pipe",
      timeout: 10000,
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error(
      "Could not determine git remote URL. Ensure a git repo with an 'origin' remote exists at BASE_DIR.",
    );
  }
}

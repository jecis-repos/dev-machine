import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import {
  BASE_DIR,
  CADDYFILE_PATH,
  CADDY_MANAGED_TLS,
  CADDY_TLS_CERT_PATH,
  CADDY_TLS_KEY_PATH,
  instanceHostname,
} from "../config.js";
import type { Instance } from "../types.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate a Caddy server block for an instance.
 * Includes: TLS, static files, Vite HMR proxy, PHP FastCGI, gzip, build status fallback.
 */
export async function addCaddyBlock(instance: Instance): Promise<void> {
  let content = await readFile(CADDYFILE_PATH, "utf-8");
  const domain = instanceHostname(instance.prefix);

  if (content.includes(`${domain} {`)) {
    throw new Error(`Caddy block for "${domain}" already exists`);
  }

  const tlsDirective = CADDY_MANAGED_TLS
    ? ""
    : `\ttls ${CADDY_TLS_CERT_PATH} ${CADDY_TLS_KEY_PATH}\n\n`;

  const block = `
${domain} {
${tlsDirective}\troot * /srv/${instance.prefix}/public

\t# Dev server HMR — proxy to host
\t@vite path /@vite/* /@fs/* /resources/* /__vite_ping /node_modules/*
\treverse_proxy @vite host.docker.internal:${instance.vite_port}

\t# Application via FastCGI
\tphp_fastcgi ${instance.prefix}-app:9000 {
\t\troot /var/www/html/public
\t}

\tfile_server
\tencode gzip

\t# Build status fallback — shown when container is unavailable
\thandle_errors {
\t\t@unavailable expression {err.status_code} == 502 || {err.status_code} == 503
\t\thandle @unavailable {
\t\t\t@has_status file /build-status.html
\t\t\trewrite @has_status /build-status.html
\t\t\tfile_server
\t\t}
\t}

\tlog {
\t\toutput stdout
\t}
}
`;

  const newContent = content.trimEnd() + "\n" + block.trimEnd() + "\n";
  await writeFile(CADDYFILE_PATH, newContent, "utf-8");
  await validateCaddyfile(content);
}

/**
 * Remove a Caddy server block by instance prefix.
 */
export async function removeCaddyBlock(prefix: string): Promise<void> {
  const content = await readFile(CADDYFILE_PATH, "utf-8");
  const domain = instanceHostname(prefix);

  const blockRegex = new RegExp(
    `\\n*${escapeRegex(domain)} \\{[\\s\\S]*?^\\}\\n?`,
    "m",
  );

  let modified = content.replace(blockRegex, "\n");
  modified = modified.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  await writeFile(CADDYFILE_PATH, modified, "utf-8");
  await validateCaddyfile(content);
}

/**
 * Validate Caddyfile syntax via Docker exec.
 * Restores original content on failure.
 */
async function validateCaddyfile(originalContent: string): Promise<void> {
  try {
    execSync("docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile", {
      cwd: BASE_DIR,
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch (err) {
    await writeFile(CADDYFILE_PATH, originalContent, "utf-8");
    const stderr = String((err as { stderr?: string | Buffer })?.stderr ?? "").trim();
    throw new Error(`Caddyfile validation failed. Original restored. ${stderr}`);
  }
}

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseDocument, YAMLMap } from "yaml";
import { DOCKER_COMPOSE_PATH } from "../config.js";
import type { Instance } from "../types.js";

/**
 * Validate docker-compose.yml syntax using Docker Compose CLI.
 */
function validate(filePath: string): void {
  try {
    execSync(`docker compose -f "${filePath}" config --quiet`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(
      `docker-compose.yml validation failed after edit. ` +
      `Backup has been restored. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function createBackup(filePath: string): string {
  const backup = `${filePath}.bak.${Date.now()}`;
  copyFileSync(filePath, backup);
  return backup;
}

function restoreBackup(backupPath: string, filePath: string): void {
  try {
    copyFileSync(backupPath, filePath);
  } catch {
    // If restore fails, we have bigger problems
  }
}

/**
 * Add an app service definition to docker-compose.yml for an instance.
 */
export async function addAppService(instance: Instance): Promise<void> {
  const filePath = DOCKER_COMPOSE_PATH;
  const backup = createBackup(filePath);
  const serviceName = `${instance.prefix}-app`;

  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseDocument(content);

    const services = doc.get("services") as YAMLMap;
    if (!services) {
      throw new Error("No 'services' key found in docker-compose.yml");
    }

    if (services.has(serviceName)) {
      throw new Error(`Service "${serviceName}" already exists in docker-compose.yml`);
    }

    const definition: Record<string, unknown> = {
      image: instance.php_image || "php:8.4-fpm",
      container_name: `${instance.prefix}-app`,
      volumes: [
        `./${instance.directory}/app:/var/www/html`,
      ],
      working_dir: "/var/www/html",
      networks: ["devmachine"],
      depends_on: ["pgsql", "redis"],
    };

    services.set(serviceName, definition);

    writeFileSync(filePath, doc.toString());
    validate(filePath);
  } catch (err) {
    restoreBackup(backup, filePath);
    throw err;
  }
}

/**
 * Remove an app service from docker-compose.yml.
 */
export async function removeAppService(prefix: string): Promise<void> {
  const filePath = DOCKER_COMPOSE_PATH;
  const backup = createBackup(filePath);
  const serviceName = `${prefix}-app`;

  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseDocument(content);

    const services = doc.get("services") as YAMLMap;
    if (!services || !services.has(serviceName)) {
      throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);
    }

    services.delete(serviceName);

    writeFileSync(filePath, doc.toString());
    validate(filePath);
  } catch (err) {
    restoreBackup(backup, filePath);
    throw err;
  }
}

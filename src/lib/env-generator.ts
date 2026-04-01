import { readFile, writeFile } from "node:fs/promises";
import { ENV_TEMPLATE_PATH, BASE_DIR, DOMAIN_SUFFIX, PROJECT_SUBDIR } from "../config.js";
import type { Instance } from "../types.js";

export function setEnvValue(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }
  return `${content.trimEnd()}\n${key}=${value}\n`;
}

export async function generateEnv(instance: Instance): Promise<string> {
  const template = await readFile(ENV_TEMPLATE_PATH, "utf-8");
  const envPath = `${BASE_DIR}/${instance.prefix}/${PROJECT_SUBDIR}/.env`;

  let content = template
    .replace(/\{\{PREFIX\}\}/g, instance.prefix)
    .replace(/\{\{DISPLAY_NAME\}\}/g, instance.display_name)
    .replace(/\{\{TIMEZONE\}\}/g, instance.timezone)
    .replace(/\{\{DB_NAME\}\}/g, instance.db_name)
    .replace(/\{\{REDIS_DB\}\}/g, String(instance.redis_db))
    .replace(/\{\{REDIS_CACHE_DB\}\}/g, String(instance.redis_cache_db))
    .replace(/\{\{VITE_PORT\}\}/g, String(instance.vite_port))
    .replace(/\{\{DOMAIN_SUFFIX\}\}/g, DOMAIN_SUFFIX);

  // Staging overrides from environment variables
  const appEnv = process.env.DEVMACHINE_PREVIEW_APP_ENV?.trim() || "staging";
  const appDebug = process.env.DEVMACHINE_PREVIEW_APP_DEBUG?.trim() || "false";
  const logLevel = process.env.DEVMACHINE_PREVIEW_LOG_LEVEL?.trim();

  content = setEnvValue(content, "APP_ENV", appEnv);
  content = setEnvValue(content, "APP_DEBUG", appDebug);
  if (logLevel) {
    content = setEnvValue(content, "LOG_LEVEL", logLevel);
  }

  // S3-compatible storage — point all S3 disks at a local MinIO container
  if (appEnv !== "local") {
    const minioKey = process.env.DEVMACHINE_MINIO_KEY?.trim() || "minioadmin";
    const minioSecret = process.env.DEVMACHINE_MINIO_SECRET?.trim() || "minioadmin";
    const minioBucket = process.env.DEVMACHINE_MINIO_BUCKET?.trim() || "uploads";
    const minioEndpoint = process.env.DEVMACHINE_MINIO_ENDPOINT?.trim() || "http://minio:9000";
    const minioRegion = process.env.DEVMACHINE_MINIO_REGION?.trim() || "us-east-1";

    content = setEnvValue(content, "AWS_ACCESS_KEY_ID", minioKey);
    content = setEnvValue(content, "AWS_SECRET_ACCESS_KEY", minioSecret);
    content = setEnvValue(content, "AWS_BUCKET", minioBucket);
    content = setEnvValue(content, "AWS_ENDPOINT", minioEndpoint);
    content = setEnvValue(content, "AWS_DEFAULT_REGION", minioRegion);
    content = setEnvValue(content, "AWS_USE_PATH_STYLE_ENDPOINT", "true");
  }

  await writeFile(envPath, content, "utf-8");
  return envPath;
}

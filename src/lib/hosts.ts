import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { HOSTS_FILE, HOSTS_UPDATE_ENABLED, instanceHostname } from "../config.js";
import { validateHostname } from "./sanitize.js";

export async function addHostEntry(prefix: string): Promise<string> {
  if (!HOSTS_UPDATE_ENABLED) return "Hosts update disabled";
  const hostname = instanceHostname(prefix);
  validateHostname(hostname);
  const content = await readFile(HOSTS_FILE, "utf-8");
  if (content.includes(hostname)) return `Host entry for ${hostname} already exists`;
  execSync(`echo "127.0.0.1 ${hostname}" | sudo tee -a ${HOSTS_FILE}`, { stdio: "pipe" });
  return `Added ${hostname} to ${HOSTS_FILE}`;
}

export async function removeHostEntry(prefix: string): Promise<string> {
  if (!HOSTS_UPDATE_ENABLED) return "Hosts update disabled";
  const hostname = instanceHostname(prefix);
  execSync(`sudo sed -i '/${hostname}/d' ${HOSTS_FILE}`, { stdio: "pipe" });
  return `Removed ${hostname} from ${HOSTS_FILE}`;
}

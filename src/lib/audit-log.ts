import { appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "../config.js";

const AUDIT_LOG_PATH = join(BASE_DIR, "audit.jsonl");
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Append a structured JSON entry to the audit log.
 * Auto-rotates when the log exceeds 10MB.
 */
export function auditLog(event: string, data: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    pid: process.pid,
    ...data,
  });

  try {
    if (existsSync(AUDIT_LOG_PATH)) {
      const stats = statSync(AUDIT_LOG_PATH);
      if (stats.size > MAX_SIZE_BYTES) {
        renameSync(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.${Date.now()}.old`);
      }
    }
    appendFileSync(AUDIT_LOG_PATH, entry + "\n");
  } catch (err) {
    // Best-effort logging — log to stderr but never crash the caller
    process.stderr.write(`[audit-log] Failed to write: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

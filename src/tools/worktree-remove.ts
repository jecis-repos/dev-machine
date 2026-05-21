/**
 * worktree-remove — Tear down a worktree + drop its dedicated DB.
 *
 * Best-effort, mirrors `WaveCleanupService::cleanup()`: errors are
 * surfaced in the response payload but the registry entry is removed
 * regardless so a half-cleaned worktree doesn't get stuck.
 */

import { removeWorktree } from "../lib/worktree.js";
import {
  getWorktree,
  removeWorktreeFromRegistry,
} from "../lib/worktree-registry.js";
import type { WorktreeRemoveInput } from "../types.js";

export async function worktreeRemove(input: WorktreeRemoveInput): Promise<string> {
  const taskId = input.task_id?.trim();
  if (!taskId) {
    return JSON.stringify({ ok: false, errors: ["task_id is required."] });
  }

  const worktree = await getWorktree(taskId);
  if (!worktree) {
    return JSON.stringify({
      ok: false,
      errors: [`worktree with task_id '${taskId}' is not registered.`],
    });
  }

  const result = await removeWorktree({
    task_id: taskId,
    worktree_path: worktree.worktree_path,
    db_database: worktree.db_database,
  });

  // Always deregister — best-effort cleanup semantics. A subsequent
  // `worktree-create` for the same task_id will idempotently retry.
  try {
    await removeWorktreeFromRegistry(taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      ok: false,
      task_id: taskId,
      errors: [
        ...result.errors,
        `failed to deregister worktree: ${msg}`,
      ],
    });
  }

  return JSON.stringify({
    ok: result.ok,
    task_id: taskId,
    errors: result.errors,
  });
}

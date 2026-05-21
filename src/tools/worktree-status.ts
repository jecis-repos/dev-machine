/**
 * worktree-status — Health check for a registered worktree.
 *
 * Returns `{ ok, registered, worktree_path_exists, db_reachable, errors }`.
 * `ok` is true only when both the filesystem path and the DB are reachable.
 */

import { statusWorktree } from "../lib/worktree.js";
import { getWorktree } from "../lib/worktree-registry.js";
import type { WorktreeStatusInput } from "../types.js";

export async function worktreeStatus(input: WorktreeStatusInput): Promise<string> {
  const taskId = input.task_id?.trim();
  if (!taskId) {
    return JSON.stringify({ ok: false, errors: ["task_id is required."] });
  }

  const worktree = await getWorktree(taskId);
  if (!worktree) {
    return JSON.stringify({
      ok: false,
      task_id: taskId,
      registered: false,
      worktree_path_exists: false,
      db_reachable: false,
      errors: [`worktree with task_id '${taskId}' is not registered.`],
    });
  }

  const result = await statusWorktree(worktree);
  return JSON.stringify(result);
}

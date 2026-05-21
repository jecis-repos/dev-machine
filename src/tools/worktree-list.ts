/**
 * worktree-list — Return all registered worktrees as JSON.
 */

import { loadWorktreeRegistry } from "../lib/worktree-registry.js";

export async function worktreeList(): Promise<string> {
  const registry = await loadWorktreeRegistry();
  return JSON.stringify({
    ok: true,
    count: registry.worktrees.length,
    worktrees: registry.worktrees,
    errors: [],
  });
}

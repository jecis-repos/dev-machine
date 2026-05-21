/**
 * Worktree registry — JSON-backed, file-locked.
 *
 * Mirrors the API of `registry.ts` but for the {@link Worktree} model and
 * its own JSON file (so the two registries do not contend on a single
 * lock). Use `WORKTREE_REGISTRY_PATH` from `config.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { WORKTREE_REGISTRY_PATH } from "../config.js";
import type { Worktree, WorktreeRegistry } from "../types.js";
import { withRegistryLock } from "./file-lock.js";

/**
 * Computed lazily (not at module top-level) so test harnesses can override
 * `WORKTREE_REGISTRY_PATH` via `vi.mock` without TDZ issues from hoisted
 * mock factories.
 */
function worktreeLockPath(): string {
  return `${WORKTREE_REGISTRY_PATH}.lock`;
}

/**
 * Load the worktree registry from disk. Returns an empty registry if the
 * file is missing or unreadable (mirrors `loadRegistry()`).
 */
export async function loadWorktreeRegistry(): Promise<WorktreeRegistry> {
  try {
    const content = readFileSync(WORKTREE_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(content) as WorktreeRegistry;
    if (!parsed || !Array.isArray(parsed.worktrees)) {
      return { worktrees: [] };
    }
    return parsed;
  } catch {
    return { worktrees: [] };
  }
}

function writeWorktreeRegistry(registry: WorktreeRegistry): void {
  writeFileSync(WORKTREE_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Add (or replace, by `task_id`) a worktree in the registry. File-locked.
 */
export async function addWorktree(worktree: Worktree): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await loadWorktreeRegistry();
    const existing = registry.worktrees.findIndex(
      (w: Worktree) => w.task_id === worktree.task_id,
    );
    if (existing >= 0) {
      registry.worktrees[existing] = worktree;
    } else {
      registry.worktrees.push(worktree);
    }
    writeWorktreeRegistry(registry);
  }, worktreeLockPath());
}

/**
 * Remove a worktree from the registry by `task_id`. File-locked.
 */
export async function removeWorktreeFromRegistry(taskId: string): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await loadWorktreeRegistry();
    registry.worktrees = registry.worktrees.filter(
      (w: Worktree) => w.task_id !== taskId,
    );
    writeWorktreeRegistry(registry);
  }, worktreeLockPath());
}

/**
 * Look up a worktree by `task_id`. Returns `undefined` if not registered.
 */
export async function getWorktree(taskId: string): Promise<Worktree | undefined> {
  const registry = await loadWorktreeRegistry();
  return registry.worktrees.find((w: Worktree) => w.task_id === taskId);
}

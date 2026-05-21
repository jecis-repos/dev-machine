/**
 * worktree-create — Provision a git worktree + dedicated pgvector DB
 * for a fix-loop coding agent.
 *
 * Idempotent (matches the Atelier `WorktreeProvisioner` contract):
 * re-invoking with the same `task_id` removes any prior worktree +
 * branch and drops + recreates the DB.
 *
 * Returns a JSON-stringified `{ ok, worktree?, errors }` payload that
 * the tool wrapper places into a single text content block.
 */

import { provisionWorktree } from "../lib/worktree.js";
import { addWorktree } from "../lib/worktree-registry.js";
import type { WorktreeCreateInput } from "../types.js";

export async function worktreeCreate(input: WorktreeCreateInput): Promise<string> {
  const result = await provisionWorktree(input);

  if (result.ok && result.worktree) {
    try {
      await addWorktree(result.worktree);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        ok: false,
        worktree: result.worktree,
        errors: [
          ...result.errors,
          `failed to register worktree in registry: ${msg}`,
        ],
      });
    }
    return JSON.stringify({
      ok: true,
      worktree: result.worktree,
      errors: result.errors,
    });
  }

  return JSON.stringify({
    ok: false,
    worktree: result.worktree,
    errors: result.errors,
  });
}

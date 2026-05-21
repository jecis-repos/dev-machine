/**
 * `dispatch-fix-loop-wave` MCP tool.
 *
 * Drives the dispatch half of Atelier's fix-loop L5-L9 pattern: takes a
 * wave id + the cluster JSONB specs that the Atelier `PlanFixLoopWave`
 * Action already persisted, builds a per-cluster prompt, and hands each
 * one off to a coding-agent CLI bridge. The MCP tool layer is a thin
 * adapter — all spawn logic lives in `lib/fix-loop-bridges.ts`.
 *
 * Differs from the PHP `DispatchFixLoopWaveAction` in three ways:
 *
 *   1. No DB write-back. The Atelier caller (or the operator) owns the
 *      `fix_loop_waves` row; this tool returns per-cluster dispatch
 *      results that the caller folds into the JSONB.
 *   2. The PHP version targets `agents.dispatch_intent` and surfaces an
 *      `agent_routing_log` row id. We spawn the CLI directly and mint a
 *      local UUID instead.
 *   3. The prompt template names `diff_path` / `report_path` /
 *      `.failed` so the agent knows where to land its output — the PHP
 *      version delegates that to the routing layer.
 */

import {
  type DispatchClusterToBridgeResult,
  buildPromptForCluster,
  dispatchClusterToBridge,
  type FixLoopClusterSpec,
} from "../lib/fix-loop-bridges.js";
import {
  type CodingAgentBridge,
  FIXLOOP_DEFAULT_BRIDGE,
} from "../config.js";

/* ------------------------------------------------------------------ */
/*  Tool I/O                                                           */
/* ------------------------------------------------------------------ */

export interface DispatchFixLoopWaveInput {
  /** Wave identifier — opaque to this tool; echoed back unmodified. */
  wave: string;
  /** Cluster specs to dispatch. Shape matches the FixLoopWave JSONB. */
  clusters: FixLoopClusterSpec[];
  /** Override the configured default bridge for this dispatch. */
  bridge?: CodingAgentBridge;
}

export interface DispatchEntry {
  cluster: string;
  /** Locally-generated UUID, or `null` if the spawn raised. */
  dispatch_id: string | null;
  /** `dispatched` on success, `dispatch-failed` otherwise. */
  status: "dispatched" | "dispatch-failed";
  /** Spawned process id (absent for `mock` and on failure). */
  pid?: number;
  /** Error message captured when status is `dispatch-failed`. */
  error?: string;
}

export interface DispatchFixLoopWaveResult {
  ok: boolean;
  wave: string;
  bridge: CodingAgentBridge;
  dispatches: DispatchEntry[];
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

/**
 * Dispatch every cluster in the input to the configured bridge.
 *
 * Per-cluster failures DO NOT abort the wave — mirrors the PHP
 * "continue + track" pattern. The aggregate `ok` is `true` whenever at
 * least one cluster dispatched successfully; callers that want strict
 * all-or-nothing semantics should inspect the `dispatches` array.
 */
export async function dispatchFixLoopWave(
  input: DispatchFixLoopWaveInput,
): Promise<DispatchFixLoopWaveResult> {
  const bridge: CodingAgentBridge = input.bridge ?? FIXLOOP_DEFAULT_BRIDGE;
  const dispatches: DispatchEntry[] = [];

  for (const cluster of input.clusters ?? []) {
    const cid = cluster.cluster ?? "";
    const prompt = buildPromptForCluster(cluster);

    try {
      const result: DispatchClusterToBridgeResult =
        await dispatchClusterToBridge({
          bridge,
          prompt,
          cwd: cluster.worktree_path,
          diff_path: cluster.diff_path,
          report_path: cluster.report_path,
        });

      dispatches.push({
        cluster: cid,
        dispatch_id: result.dispatch_id,
        status: "dispatched",
        ...(result.pid !== undefined ? { pid: result.pid } : {}),
      });
    } catch (err) {
      dispatches.push({
        cluster: cid,
        dispatch_id: null,
        status: "dispatch-failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anySuccess = dispatches.some((d) => d.status === "dispatched");

  return {
    ok: anySuccess || dispatches.length === 0,
    wave: input.wave,
    bridge,
    dispatches,
  };
}

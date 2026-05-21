/**
 * `harvest-fix-loop-wave` MCP tool.
 *
 * Scans disk for each cluster's expected diff/report artifacts (or
 * failure sentinels) and returns the updated cluster specs + an
 * aggregate summary. The caller folds the result back into the Atelier
 * `fix_loop_waves.clusters` JSONB and decides whether to transition the
 * wave's state machine (`dispatched` → `harvesting`).
 *
 * All scanning logic lives in `lib/fix-loop-harvest.ts`; this tool is a
 * thin MCP adapter so it can be registered in `src/tools/index.ts`
 * without leaking implementation detail.
 */

import {
  harvestClusters,
  type HarvestSummary,
} from "../lib/fix-loop-harvest.js";
import type { FixLoopClusterSpec } from "../lib/fix-loop-bridges.js";

/* ------------------------------------------------------------------ */
/*  Tool I/O                                                           */
/* ------------------------------------------------------------------ */

export interface HarvestFixLoopWaveInput {
  /** Wave identifier — opaque to this tool; echoed back unmodified. */
  wave: string;
  /**
   * Cluster specs (the same shape stored on `fix_loop_waves.clusters`).
   * The tool reads `diff_path` / `report_path` from each spec, never
   * the wave row itself.
   */
  clusters: FixLoopClusterSpec[];
}

export interface HarvestFixLoopWaveResult {
  ok: boolean;
  wave: string;
  clusters: FixLoopClusterSpec[];
  summary: HarvestSummary;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

/**
 * Idempotent: re-running with the same on-disk state returns the same
 * result. Safe to poll on a timer until `in_flight === 0`.
 */
export async function harvestFixLoopWave(
  input: HarvestFixLoopWaveInput,
): Promise<HarvestFixLoopWaveResult> {
  const { updated, summary } = harvestClusters(input.clusters ?? []);

  return {
    ok: true,
    wave: input.wave,
    clusters: updated,
    summary,
  };
}

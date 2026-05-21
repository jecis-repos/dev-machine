/**
 * Pure disk-scanning harvester for the fix-loop harvest verb.
 *
 * Ports the cluster-status-resolution half of Atelier's
 * `HarvestFixLoopAction` to a side-effect-free helper. There is no
 * `FixLoopWave` model in dev-machine — the wave + cluster JSONB lives
 * in Atelier — so this helper takes cluster specs in, scans their
 * `diff_path` / `report_path` / sentinels, and returns the updated
 * specs plus an aggregate summary. The MCP tool layer is what an
 * Atelier client calls remotely to drive the in-DB state machine.
 *
 * Status precedence (highest → lowest):
 *   1. `.retry-failed` sentinel at `${diff_path}.retry-failed`
 *      → `retry-failed`
 *   2. `.failed` sentinel at `${diff_path}.failed`
 *      → `failed-no-report`
 *   3. `diff_path` exists AND is non-empty
 *      → `harvested` (PHP only checks `is_file`; the Node port adds
 *         non-empty so an interrupted `touch $diff` doesn't fake
 *         success)
 *   4. Otherwise
 *      → `dispatched` (still in flight)
 *
 * The summary returns counts (`harvested`, `failed`, `in_flight`) per
 * the Node tool spec. Note: this is a divergence from the PHP original,
 * which returns lists of cluster ids — surfaced in the final report.
 */

import { existsSync, statSync, readFileSync } from "node:fs";

import type { FixLoopClusterSpec } from "./fix-loop-bridges.js";

/* ------------------------------------------------------------------ */
/*  Public surface                                                     */
/* ------------------------------------------------------------------ */

export interface HarvestSummary {
  /** Count of clusters whose status resolved to `harvested`. */
  harvested: number;
  /**
   * Count of clusters in any terminal-failure status: `failed-no-report`
   * or `retry-failed`. Matches the spec's bucket.
   */
  failed: number;
  /** Count of clusters still in `dispatched` (no diff, no sentinel). */
  in_flight: number;
}

export interface HarvestResult {
  updated: FixLoopClusterSpec[];
  summary: HarvestSummary;
}

/**
 * Scan disk for every cluster's expected artifacts. Returns the spec
 * list with `status` (and, on harvest, `report`) populated, plus a
 * summary of counts.
 *
 * Pure with respect to its inputs — only reads from disk, never writes.
 * Safe to call repeatedly; an already-`harvested` cluster stays
 * `harvested` because its `diff_path` remains on disk.
 */
export function harvestClusters(
  clusters: FixLoopClusterSpec[],
): HarvestResult {
  const updated: FixLoopClusterSpec[] = [];
  let harvested = 0;
  let failed = 0;
  let in_flight = 0;

  for (const cluster of clusters) {
    const resolved = resolveClusterStatus(cluster);
    updated.push(resolved.cluster);

    switch (resolved.bucket) {
      case "harvested":
        harvested += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "in_flight":
        in_flight += 1;
        break;
    }
  }

  return {
    updated,
    summary: { harvested, failed, in_flight },
  };
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

type HarvestBucket = "harvested" | "failed" | "in_flight";

interface ResolvedCluster {
  cluster: FixLoopClusterSpec;
  bucket: HarvestBucket;
}

/**
 * Resolve a single cluster's status by inspecting the filesystem in
 * the documented precedence order. Returns a new spec object (does not
 * mutate the input).
 */
function resolveClusterStatus(cluster: FixLoopClusterSpec): ResolvedCluster {
  const diffPath = cluster.diff_path ?? "";
  const reportPath = cluster.report_path ?? "";

  // 1. .retry-failed wins over everything — explicit operator signal.
  if (diffPath !== "" && existsSync(`${diffPath}.retry-failed`)) {
    return {
      cluster: { ...cluster, status: "retry-failed" },
      bucket: "failed",
    };
  }

  // 2. .failed sentinel — agent reported permanent failure.
  if (diffPath !== "" && existsSync(`${diffPath}.failed`)) {
    return {
      cluster: { ...cluster, status: "failed-no-report" },
      bucket: "failed",
    };
  }

  // 3. Non-empty diff means the agent landed something usable.
  if (diffPath !== "" && isNonEmptyFile(diffPath)) {
    const next: FixLoopClusterSpec = { ...cluster, status: "harvested" };
    if (reportPath !== "" && existsSync(reportPath)) {
      // Match PHP behavior: capture first 2000 chars of the report
      // inline on the cluster spec. Larger reports stay on disk.
      try {
        next.report = readFileSync(reportPath, "utf-8").slice(0, 2000);
      } catch {
        // Unreadable report → harvested status stands, just no inline
        // preview. The on-disk file is still authoritative.
      }
    }
    return { cluster: next, bucket: "harvested" };
  }

  // 4. Default: still in flight. Status preserved as `dispatched` for
  //    parity with the PHP original.
  return {
    cluster: { ...cluster, status: "dispatched" },
    bucket: "in_flight",
  };
}

function isNonEmptyFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Coding-agent bridge spawner for the fix-loop dispatch verb.
 *
 * Ports the dispatch half of Atelier's `DispatchFixLoopWaveAction`. The
 * PHP original calls `agents.dispatch_intent`, an Atelier MCP Action
 * that brokers an `agent_routing_log` row and hands off to a bridge
 * process. This Node port replaces that indirection: it spawns the
 * coding-agent CLI directly, detached, and treats the dispatch as fire-
 * and-forget. The agent is expected to write its `diff_path` /
 * `report_path` (or a `.failed` sentinel) to disk asynchronously; the
 * harvest verb later scans for those artifacts.
 *
 * Bridge semantics:
 *   - `claude-code` — spawns `${FIXLOOP_CLAUDE_CODE_BIN} -p <prompt>`
 *   - `codex`       — spawns `${FIXLOOP_CODEX_BIN} exec <prompt>`
 *   - `amp`         — spawns `${FIXLOOP_AMP_BIN} -x <prompt>`
 *                     (Sourcegraph Amp non-interactive mode)
 *   - `crush`       — spawns `${FIXLOOP_CRUSH_BIN} run <prompt>`
 *                     (Charm Crush non-interactive mode)
 *   - `mock`        — does NOT spawn; synthesizes a non-empty diff and
 *                     a report file so a harvest round-trip yields
 *                     `harvested`. Useful for tests.
 *
 * The `dispatch_id` returned is a locally-generated UUID. It is opaque
 * to the bridge — the harvest verb correlates clusters back to their
 * dispatch via file paths, not this id.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type CodingAgentBridge,
  FIXLOOP_AMP_BIN,
  FIXLOOP_CLAUDE_CODE_BIN,
  FIXLOOP_CODEX_BIN,
  FIXLOOP_CRUSH_BIN,
} from "../config.js";

/* ------------------------------------------------------------------ */
/*  Public surface                                                     */
/* ------------------------------------------------------------------ */

export interface DispatchClusterToBridgeInput {
  bridge: CodingAgentBridge;
  prompt: string;
  /** Working directory passed to spawn (the cluster's worktree). */
  cwd: string;
  /** Where the agent is instructed to write its unified diff. */
  diff_path: string;
  /** Where the agent is instructed to write its markdown report. */
  report_path: string;
  /**
   * Soft cap (informational only — dispatch is fire-and-forget so the
   * parent never waits). Reserved for future use; included so the tool
   * surface matches the spec.
   */
  timeout_ms?: number;
}

export interface DispatchClusterToBridgeResult {
  ok: true;
  /** UUID minted locally — does not come from the bridge. */
  dispatch_id: string;
  /** Process id of the spawned CLI (absent for `mock`). */
  pid?: number;
}

/**
 * Dispatch one cluster to a coding-agent bridge. Returns immediately
 * once the CLI has been spawned (or, for `mock`, once the synthetic
 * diff/report files have been written). Completion is signaled by the
 * agent writing to `diff_path`; observe via `harvestClusters`.
 */
export async function dispatchClusterToBridge(
  input: DispatchClusterToBridgeInput,
): Promise<DispatchClusterToBridgeResult> {
  const dispatch_id = randomUUID();

  // Ensure the worktree dir + diff parent exist before any writer
  // attaches a stream / writeFile. createWriteStream() emits a silent
  // 'error' event if the parent is missing, which would lose logs.
  await mkdir(input.cwd, { recursive: true });
  await mkdir(dirname(input.diff_path), { recursive: true });
  await mkdir(dirname(input.report_path), { recursive: true });

  if (input.bridge === "mock") {
    // Synthesize a non-empty diff so a `dispatch` → `harvest` round
    // trip resolves to `harvested` (the harvest helper requires
    // non-empty diffs — see fix-loop-harvest.ts). Empty would leave
    // every mock dispatch stuck in `in_flight`.
    await writeFile(input.diff_path, "mock diff\n", "utf-8");
    await writeFile(input.report_path, "mock harvest payload", "utf-8");
    return { ok: true, dispatch_id };
  }

  const { bin, args } = resolveBridgeCommand(input.bridge, input.prompt);

  const logPath = `${input.cwd}/agent.log`;
  const logStream = createWriteStream(logPath, { flags: "a" });

  const child = spawn(bin, args, {
    cwd: input.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe stdout/stderr to the log file. Trade-off: piping keeps the
  // parent attached to the child's stdout/stderr fds until the agent
  // closes them, so `child.unref()` alone does not make the parent
  // fully detachable. For fire-and-forget shutdown (P5 smoke), the
  // operator should send SIGTERM to the parent — or we can revisit by
  // passing raw fds via `stdio: ['ignore', fd, fd]` to inherit them
  // into the detached child directly. The current shape is fine for
  // long-running MCP server use; log capture is the higher priority.
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // unref() so the parent (the MCP server) can exit even if the agent
  // is still running.
  child.unref();

  return { ok: true, dispatch_id, pid: child.pid };
}

/* ------------------------------------------------------------------ */
/*  Bridge → argv mapping                                              */
/* ------------------------------------------------------------------ */

interface ResolvedBridgeCommand {
  bin: string;
  args: string[];
}

/**
 * Map a bridge identifier to (binary, argv). Argv stays deliberately
 * minimal so tests can assert exact shape. `cwd` is NOT passed as a
 * flag — it goes through `spawn`'s options.
 */
function resolveBridgeCommand(
  bridge: Exclude<CodingAgentBridge, "mock">,
  prompt: string,
): ResolvedBridgeCommand {
  switch (bridge) {
    case "claude-code":
      // `claude -p <prompt>` runs Claude Code in headless print mode.
      return { bin: FIXLOOP_CLAUDE_CODE_BIN, args: ["-p", prompt] };
    case "codex":
      // `codex exec <prompt>` is the non-interactive Codex CLI entry.
      return { bin: FIXLOOP_CODEX_BIN, args: ["exec", prompt] };
    case "amp":
      // `amp -x <prompt>` is Sourcegraph Amp's one-shot execution flag.
      return { bin: FIXLOOP_AMP_BIN, args: ["-x", prompt] };
    case "crush":
      // `crush run <prompt>` invokes Charm Crush non-interactively.
      return { bin: FIXLOOP_CRUSH_BIN, args: ["run", prompt] };
  }
}

/* ------------------------------------------------------------------ */
/*  Prompt template — ported from PHP DispatchFixLoopWaveAction        */
/* ------------------------------------------------------------------ */

/**
 * Cluster spec consumed by the prompt builder. Matches the JSONB shape
 * stored on `fix_loop_waves.clusters` (see Atelier
 * `app/Modules/Dev/Models/FixLoopWave.php`).
 */
export interface FixLoopClusterSpec {
  cluster: string;
  task_id: string;
  worktree_path: string;
  db_database: string;
  tests: string[];
  diff_path: string;
  report_path: string;
  status?: string;
  dispatch_id?: string | null;
  retry_count?: number;
  report?: string;
}

/**
 * Default fix-loop prompt. Direct port of
 * `DispatchFixLoopWaveAction::DEFAULT_INTENT_TEMPLATE` with two
 * additions over the PHP original:
 *
 *   - `{diff_path}` / `{report_path}` placeholders — the PHP version
 *     delegates output capture to `agents.dispatch_intent`, but this
 *     Node port relies on the agent writing to disk. The prompt must
 *     name the target paths explicitly.
 *   - `.failed` sentinel instruction — the PHP harvest checks for this
 *     sentinel; the prompt now tells the agent to create it on
 *     unrecoverable failure.
 */
export const DEFAULT_INTENT_TEMPLATE = [
  "You are the coding agent for fix-loop cluster `{cluster_id}`.",
  "",
  "Worktree: {worktree_path}",
  "Database: {db_database}",
  "",
  "Failing tests to drive to green:",
  "{tests}",
  "",
  "Constraints: no commits, no pushes, leave the worktree dirty,",
  "Pint clean, PHPStan clean. Stop when the listed tests pass.",
  "",
  "Write your unified diff to: {diff_path}",
  "Write your markdown report to: {report_path}",
  "If you cannot complete the work, write `{diff_path}.failed` with a",
  "short reason; the harvester treats that as a permanent failure.",
].join("\n");

/**
 * Substitute the supported placeholders into the template. Mirrors
 * `DispatchFixLoopWaveAction::renderIntent` — `{tests}` is one-per-line
 * for chat-UI readability.
 */
export function buildPromptForCluster(
  cluster: FixLoopClusterSpec,
  template: string = DEFAULT_INTENT_TEMPLATE,
): string {
  const tests = cluster.tests ?? [];
  const testsBlock =
    tests.length === 0 ? "(none)" : tests.map((t) => `- ${t}`).join("\n");

  return template
    .split("{cluster_id}")
    .join(cluster.cluster ?? "")
    .split("{worktree_path}")
    .join(cluster.worktree_path ?? "")
    .split("{db_database}")
    .join(cluster.db_database ?? "")
    .split("{diff_path}")
    .join(cluster.diff_path ?? "")
    .split("{report_path}")
    .join(cluster.report_path ?? "")
    .split("{tests}")
    .join(testsBlock);
}

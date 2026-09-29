/**
 * dev-machine TUI — Terminal dashboard for managing Docker-based local dev environments.
 *
 * MVP features: Dashboard, Action menu, Job queue, Activity log, Result panel,
 * Monitor tab, System doctor, First-run wizard, Splash screen, Instance power,
 * Hotkeys, AI Ops command palette.
 */

import blessed from 'blessed';
import { execFile, execFileSync } from 'child_process';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

import {
  buildProjectFromBranch,
  compareGithubBranches,
  createGithubBranch,
  createGithubPullRequest,
  getDockerStatusDashboard,
  getProjectInstanceStatus,
  listGithubBranches,
  runDockerExec,
  runDockerLogs,
  runDockerRestartServices,
  mcpCreateInstancePassthrough,
  mcpListInstancesPassthrough,
  mcpRemoveInstancePassthrough,
  backupCreatePassthrough,
  backupListPassthrough,
  backupRestorePassthrough,
  viewLogsPassthrough,
  instanceHealthPassthrough,
  runArtisanPassthrough,
  runDockerMaintenance,
  runProjectBootstrap,
  runSystemDoctor,
  runSystemInstall,
  runLaravelControl,
  type BridgeCallOptions,
  type DockerMaintenanceAction,
  type DockerStatusDashboard,
  type ProjectBootstrapMode,
  type ProjectInstanceStatus,
} from '../bridge/tui-bridge.js';
import { BASE_DIR, type CreateInstanceInput, type RemoveInstanceInput } from '../config.js';
import { inferAIOpsPlan, fuzzyMatchActions, type AIOpsPlan } from './ai-ops-planner.js';

/* ================================================================== */
/*  Types & Interfaces                                                 */
/* ================================================================== */

interface ActionEntry {
  category: ActionCategoryKey;
  kind: ActionKind;
  label: string;
  bypassQueue?: boolean;
  run: (context?: ActionExecutionContext) => Promise<void>;
}

interface ActionExecutionContext {
  jobId?: number;
  signal?: AbortSignal;
}

type ActionJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
type ActionKind = 'control' | 'maintenance';

type ActionCategoryKey =
  | 'dashboard'
  | 'setup'
  | 'docker'
  | 'github'
  | 'build'
  | 'laravel'
  | 'mcp'
  | 'backup';

interface ActionCategory {
  key: ActionCategoryKey;
  title: string;
  colorTag: string;
}

interface ActionMenuEntry {
  kind: 'category' | 'action';
  label: string;
  action?: ActionEntry;
  category: ActionCategoryKey;
}

type ActivityTabKey = 'log' | 'result' | 'monitor';
type IncidentSeverity = 'info' | 'warn' | 'critical';

interface MonitorProcessRow {
  pid: string;
  cpu: number;
  mem: number;
  command: string;
}

interface MonitorDockerUsageRow {
  name: string;
  cpu: number;
  memPct: number;
  memUsage: string;
}

interface SectionRuntimeStats {
  runs: number;
  success: number;
  failed: number;
  totalDurationMs: number;
  lastDurationMs?: number;
  lastResult?: 'success' | 'failed';
  lastRunAt?: string;
}

type InstallPackageManager = 'auto' | 'brew' | 'apt' | 'dnf' | 'pacman';

interface TuiState {
  firstRunCompleted: boolean;
  githubToken?: string;
  packageManager: InstallPackageManager;
  monitorSplitPercent: number;
  monitorTopPercent: number;
}

interface ActionJob {
  id: number;
  action: ActionEntry;
  status: ActionJobStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  cancelRequested: boolean;
  abortController?: AbortController;
  logLines: string[];
  logPath?: string;
}

interface AIOpsSuggestion {
  actionLabel: string;
  reason: string;
  severity: IncidentSeverity;
}

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const TUI_STATE_PATH = join(BASE_DIR, 'mcp-server', '.tui-state.json');
const ACTIVITY_LOG_DIR = join(BASE_DIR, 'docs', 'logs');
const JOB_LOG_DIR = join(ACTIVITY_LOG_DIR, 'jobs');
const ACTIVITY_LOG_MAX_LINES = 6000;
const ACTIVITY_LOG_COPY_DEFAULT_LINES = 1200;
const MONITOR_LIGHT_INTERVAL_MS = 1000;
const MONITOR_HEAVY_REFRESH_MS = 10000;
const MONITOR_SHELL_TIMEOUT_MS = 5000;
const MONITOR_HISTORY_POINTS = 120;
const MONITOR_SPLIT_MIN_PERCENT = 30;
const MONITOR_SPLIT_MAX_PERCENT = 70;
const MONITOR_TOP_MIN_PERCENT = 25;
const MONITOR_TOP_MAX_PERCENT = 65;
const ALERT_CPU_PERCENT = 90;
const ALERT_MEM_PERCENT = 90;
const ALERT_LOAD_PERCENT = 85;

const ACTION_CATEGORIES: ActionCategory[] = [
  { key: 'dashboard', title: 'Dashboard', colorTag: 'cyan-fg' },
  { key: 'setup', title: 'Setup and Tooling', colorTag: 'green-fg' },
  { key: 'docker', title: 'Docker Maintenance', colorTag: 'yellow-fg' },
  { key: 'github', title: 'GitHub', colorTag: 'blue-fg' },
  { key: 'build', title: 'Build and Provision', colorTag: 'magenta-fg' },
  { key: 'laravel', title: 'Laravel Controls', colorTag: 'white-fg' },
  { key: 'mcp', title: 'MCP Passthrough', colorTag: 'red-fg' },
  { key: 'backup', title: 'Backup & Restore', colorTag: 'cyan-fg' },
];

const DEFAULT_TUI_STATE: TuiState = {
  firstRunCompleted: false,
  packageManager: 'auto',
  monitorSplitPercent: 50,
  monitorTopPercent: 35,
};

/* ================================================================== */
/*  Utility functions                                                  */
/* ================================================================== */

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function tryParseJson(value: string): unknown | null {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function truncateText(value: string, maxLines = 220, maxChars = 28000): string {
  const normalized = value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const clippedLines = lines.slice(0, maxLines);
  let clipped = clippedLines.join('\n');
  if (clipped.length > maxChars) clipped = clipped.slice(0, maxChars);
  if (lines.length > maxLines || normalized.length > clipped.length) {
    const lineDiff = Math.max(0, lines.length - maxLines);
    clipped += `\n... truncated (${lineDiff} more lines)`;
  }
  return clipped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(value: string, max = 24): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function formatDurationMs(milliseconds?: number): string {
  if (!milliseconds || milliseconds <= 0) return '0ms';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

async function sleepMs(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function timestampForFileName(): string {
  const now = new Date();
  const pad = (v: number): string => String(v).padStart(2, '0');
  return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
}

function sanitizeForFileName(value: string, max = 40): string {
  const s = value.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'job').slice(0, max);
}

function parseYesNoWithDefault(value: string | null, defaultYes: boolean): boolean {
  if (!value || !value.trim()) return defaultYes;
  const n = value.trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(n)) return true;
  if (['n', 'no', 'false', '0'].includes(n)) return false;
  return defaultYes;
}

function yesNoFromInput(value: string | null): boolean {
  if (!value) return false;
  return parseYesNoWithDefault(value, false);
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}

function renderSparkline(values: number[], width: number): string {
  const chars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
  const targetWidth = Math.max(12, width);
  if (values.length === 0) return '\u00b7'.repeat(targetWidth);
  const sampled: number[] = [];
  if (values.length <= targetWidth) {
    sampled.push(...values);
  } else {
    for (let i = 0; i < targetWidth; i += 1) {
      const index = Math.floor((i / Math.max(1, targetWidth - 1)) * Math.max(0, values.length - 1));
      sampled.push(values[index] ?? 0);
    }
  }
  while (sampled.length < targetWidth) sampled.unshift(sampled[0] ?? 0);
  return sampled.map(v => {
    const norm = clamp(v, 0, 100);
    const idx = Math.min(chars.length - 1, Math.floor((norm / 100) * chars.length));
    return chars[idx];
  }).join('');
}

function buildHorizontalBar(value: number, max: number, width = 10): string {
  if (max <= 0) return '\u2591'.repeat(width);
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * width);
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(Math.max(0, width - filled))}`;
}

function renderPercentBadge(value: number): string {
  const shown = `${value.toFixed(1)}%`;
  if (value >= 90) return `{red-fg}${shown}{/red-fg}`;
  if (value >= 75) return `{yellow-fg}${shown}{/yellow-fg}`;
  return `{green-fg}${shown}{/green-fg}`;
}

function severityTag(severity: IncidentSeverity): string {
  if (severity === 'critical') return '{red-fg}critical{/red-fg}';
  if (severity === 'warn') return '{yellow-fg}warn{/yellow-fg}';
  return '{cyan-fg}info{/cyan-fg}';
}

function sanitizeDockerServiceName(value: string): string | null {
  const n = value.trim();
  if (!n) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n)) return null;
  return n;
}

/* ================================================================== */
/*  Splash Screen (simplified — title card, version, loading bar)      */
/* ================================================================== */

function buildSplashBar(percent: number, width: number): string {
  const safe = clamp(Math.round(percent), 0, 100);
  const filled = clamp(Math.round((safe / 100) * width), 0, width);
  return `[${'#'.repeat(filled)}${'.'.repeat(Math.max(0, width - filled))}] ${String(safe).padStart(3, ' ')}%`;
}

function getScreenSize(): { cols: number; rows: number } {
  const fromScreen = screen as unknown as { cols?: number; rows?: number };
  const cols = Number(fromScreen.cols ?? process.stdout.columns ?? 120);
  const rows = Number(fromScreen.rows ?? process.stdout.rows ?? 40);
  return {
    cols: Number.isFinite(cols) ? Math.max(80, cols) : 120,
    rows: Number.isFinite(rows) ? Math.max(24, rows) : 40,
  };
}

async function runStartupSplashScreen(): Promise<void> {
  if (process.env.DEVMACHINE_TUI_SKIP_SPLASH === '1') return;

  const { cols, rows } = getScreenSize();
  if (cols < 80 || rows < 24) return;

  const overlay = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    style: { fg: 'white', bg: 'black' },
    content: '',
  });

  let skipRequested = false;
  const requestSkip = (): void => { skipRequested = true; };
  for (const k of ['escape', 'enter', 'space']) screen.key(k, requestSkip);

  const titleLines = [
    '    ____                __  ___           __    _          ',
    '   / __ \\___  _   __  /  |/  /___ ______/ /_  (_)___  ___ ',
    '  / / / / _ \\| | / / / /|_/ / __ `/ ___/ __ \\/ / __ \\/ _ \\',
    ' / /_/ /  __/| |/ / / /  / / /_/ / /__/ / / / / / / /  __/',
    '/_____/\\___/ |___/ /_/  /_/\\__,_/\\___/_/ /_/_/_/ /_/\\___/ ',
  ];
  const titleWidth = Math.max(...titleLines.map(l => l.length));
  const barWidth = Math.min(60, cols - 10);
  const totalFrames = 40;
  const frameDelay = 60;

  const version = 'v1.0.0';
  const subtitle = 'Local Dev Environment Manager';

  for (let frame = 0; frame <= totalFrames; frame += 1) {
    if (skipRequested) break;
    const progress = (frame / totalFrames) * 100;
    const lines: string[] = [];

    // Top padding
    const topPad = Math.max(2, Math.floor((rows - titleLines.length - 8) / 2));
    for (let i = 0; i < topPad; i += 1) lines.push('');

    // Title
    for (const tl of titleLines) {
      const pad = Math.max(0, Math.floor((cols - titleWidth) / 2));
      lines.push(' '.repeat(pad) + `{cyan-fg}${tl}{/cyan-fg}`);
    }
    lines.push('');

    // Subtitle + version
    const subPad = Math.max(0, Math.floor((cols - subtitle.length) / 2));
    lines.push(' '.repeat(subPad) + `{green-fg}${subtitle}{/green-fg}`);
    const verPad = Math.max(0, Math.floor((cols - version.length) / 2));
    lines.push(' '.repeat(verPad) + `{yellow-fg}${version}{/yellow-fg}`);
    lines.push('');

    // Progress bar
    const bar = buildSplashBar(progress, barWidth);
    const barPad = Math.max(0, Math.floor((cols - bar.length) / 2));
    lines.push(' '.repeat(barPad) + `{white-fg}${bar}{/white-fg}`);

    // Status text
    const status = progress < 30 ? 'Initializing...'
      : progress < 60 ? 'Loading modules...'
      : progress < 90 ? 'Connecting to Docker...'
      : 'Ready!';
    const statusPad = Math.max(0, Math.floor((cols - status.length) / 2));
    lines.push(' '.repeat(statusPad) + (progress >= 90 ? `{green-fg}${status}{/green-fg}` : `{gray-fg}${status}{/gray-fg}`));

    // Skip hint
    lines.push('');
    const hint = 'Press Enter/Esc to skip';
    const hintPad = Math.max(0, Math.floor((cols - hint.length) / 2));
    lines.push(' '.repeat(hintPad) + `{gray-fg}${hint}{/gray-fg}`);

    overlay.setContent(lines.join('\n'));
    screen.render();
    await sleepMs(frameDelay);
  }

  // Hold final frame briefly
  if (!skipRequested) await sleepMs(600);

  for (const k of ['escape', 'enter', 'space']) screen.unkey(k, requestSkip);
  overlay.detach();
  screen.render();
}

/* ================================================================== */
/*  Screen Layout                                                      */
/* ================================================================== */

const screen = blessed.screen({
  smartCSR: true,
  title: 'dev-machine Control Center',
  fullUnicode: true,
  dockBorders: true,
});

const dockerPanel = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '45%',
  height: '45%',
  label: ' Docker Status ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
});

const instancesPanel = blessed.listtable({
  parent: screen,
  top: 0,
  left: '45%',
  width: '55%',
  height: '45%',
  label: ' Project Instances ',
  border: 'line',
  tags: true,
  keys: true,
  align: 'left',
  noCellBorders: true,
  style: {
    border: { fg: 'white' },
    header: { fg: 'black', bg: 'white', bold: true },
    cell: { fg: 'bright-white', bg: 'black', selected: { fg: 'black', bg: 'yellow' } },
    selected: { fg: 'black', bg: 'yellow', bold: true },
  },
});

const sectionPanel = blessed.box({
  parent: screen,
  top: '45%',
  left: 0,
  width: '45%',
  height: '8%',
  label: ' Section Charts ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  scrollable: true,
  alwaysScroll: true,
  style: { border: { fg: 'cyan' } },
});

const jobsPanel = blessed.box({
  parent: screen,
  top: '53%',
  left: 0,
  width: '45%',
  height: '7%',
  label: ' Jobs ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const instancePowerPanel = blessed.box({
  parent: screen,
  top: '60%',
  left: 0,
  width: '45%',
  height: '5%',
  label: ' Instance Power ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const actionMenu = blessed.list({
  parent: screen,
  top: '65%',
  bottom: 1,
  left: 0,
  width: '45%',
  label: ' Actions (By Category) ',
  border: 'line',
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  style: {
    border: { fg: 'cyan' },
    item: { fg: 'white' },
    selected: { fg: 'black', bg: 'yellow' },
  },
});

const logPanel = blessed.log({
  parent: screen,
  top: '45%',
  bottom: 1,
  left: '45%',
  width: '55%',
  label: ' Activity Log ',
  border: 'line',
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  scrollable: true,
  alwaysScroll: true,
  scrollback: ACTIVITY_LOG_MAX_LINES,
  scrollbar: { ch: ' ', track: { bg: 'gray' }, style: { bg: 'cyan' } },
  style: { border: { fg: 'cyan' } },
});

const resultPanel = blessed.box({
  parent: screen,
  top: '45%',
  bottom: 1,
  left: '45%',
  width: '55%',
  label: ' Activity Result ',
  border: 'line',
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  scrollable: true,
  alwaysScroll: true,
  hidden: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const monitorPanel = blessed.box({
  parent: screen,
  top: '45%',
  bottom: 1,
  left: '45%',
  width: '55%',
  label: ' Activity Monitor ',
  border: 'line',
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  hidden: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const monitorSummaryBox = blessed.box({
  parent: monitorPanel,
  top: 0,
  left: 0,
  width: '50%',
  height: '35%',
  label: ' System ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const monitorTrendsBox = blessed.box({
  parent: monitorPanel,
  top: 0,
  left: '50%',
  width: '50%',
  height: '35%',
  label: ' Trends ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const monitorProcessesBox = blessed.box({
  parent: monitorPanel,
  top: '35%',
  left: 0,
  width: '50%',
  height: '65%',
  label: ' Processes ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const monitorDockerBox = blessed.box({
  parent: monitorPanel,
  top: '35%',
  left: '50%',
  width: '50%',
  height: '65%',
  label: ' Docker ',
  border: 'line',
  tags: true,
  padding: { left: 1, right: 1 },
  style: { border: { fg: 'cyan' } },
});

const footer = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  height: 1,
  width: '100%',
  tags: true,
  style: { fg: 'black', bg: 'white' },
  content: ' {bold}Keys:{/bold} Up/Down navigate | Tab next category | Enter run | i instance-power | / ai-ops | j queue | ? search | [/]/1-3 tabs | r refresh | y copy-log | e export | q quit ',
});

/* ================================================================== */
/*  Global state                                                       */
/* ================================================================== */

let isBusy = false;
let currentTaskLabel: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let tuiStateSaveTimer: NodeJS.Timeout | null = null;
let tuiState: TuiState = { ...DEFAULT_TUI_STATE };
let nextJobId = 1;
const actionJobs: ActionJob[] = [];
let activeJobId: number | null = null;
const activityLogLines: string[] = [];
let activeActivityTab: ActivityTabKey = 'log';
let renderQueued = false;
let dashboardRefreshPromise: Promise<void> | null = null;
let lastCpuSample: { idle: number; total: number } | null = null;
let lastCpuCoreSamples: Array<{ idle: number; total: number }> | null = null;
let monitorSplitPercent = DEFAULT_TUI_STATE.monitorSplitPercent;
let monitorTopPercent = DEFAULT_TUI_STATE.monitorTopPercent;
const monitorCpuHistory: number[] = [];
const monitorMemHistory: number[] = [];
const monitorLoadHistory: number[] = [];
const monitorHeavySnapshot: {
  collecting: boolean;
  lastCollectedAt: number;
  diskUsage: string | null;
  dockerStats: string | null;
  topProcesses: string | null;
  lastError: string | null;
} = {
  collecting: false,
  lastCollectedAt: 0,
  diskUsage: null,
  dockerStats: null,
  topProcesses: null,
  lastError: null,
};

const githubContext: { token?: string } = {};
const installableTargets = new Set(['git', 'docker', 'mkcert', 'make', 'claude', 'codex', 'brew']);
const systemInstallAllTargets = ['git', 'docker', 'mkcert', 'make', 'claude', 'codex', 'brew', 'iterm2', 'ohmyzsh', 'spaceship', 'zsh_plugins'];
const macTerminalSuiteTargets = ['brew', 'iterm2', 'ohmyzsh', 'spaceship', 'zsh_plugins'];
const sectionRuntimeStats = initializeSectionRuntimeStats();
let displayedInstances: ProjectInstanceStatus[] = [];
let latestDockerStatus: DockerStatusDashboard | null = null;
let lastInstancesTableSignature = '';
const panelContentCache = new WeakMap<object, string>();
const activeAlerts = new Map<string, { key: string; title: string; detail: string; severity: IncidentSeverity; since: string; lastSeen: string }>();

/* ================================================================== */
/*  Panel content helpers                                              */
/* ================================================================== */

function setPanelContentCached(panel: { setContent: (content: string) => void }, content: string): boolean {
  const key = panel as unknown as object;
  const previous = panelContentCache.get(key);
  if (previous === content) return false;
  panelContentCache.set(key, content);
  panel.setContent(content);
  return true;
}

function requestRender(): void {
  const state = screen as unknown as { destroyed?: boolean };
  if (state.destroyed || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const current = screen as unknown as { destroyed?: boolean };
    if (current.destroyed) return;
    screen.render();
  }, 0);
}

function getBoxInnerRows(box: blessed.Widgets.BoxElement, fallback = 8): number {
  const rawHeight = box.height as unknown;
  if (typeof rawHeight === 'number' && Number.isFinite(rawHeight)) return Math.max(3, Math.floor(rawHeight) - 2);
  if (typeof rawHeight === 'string') {
    if (rawHeight.endsWith('%')) {
      const pct = Number.parseFloat(rawHeight.replace('%', ''));
      const base = typeof monitorPanel.height === 'number' ? monitorPanel.height : Number(screen.height) || 30;
      if (Number.isFinite(pct) && Number.isFinite(base)) return Math.max(3, Math.floor((pct / 100) * base) - 2);
    }
    const parsed = Number.parseFloat(rawHeight);
    if (Number.isFinite(parsed)) return Math.max(3, Math.floor(parsed) - 2);
  }
  return Math.max(3, fallback);
}

/* ================================================================== */
/*  Dashboard data fetching + rendering                                */
/* ================================================================== */

function formatDockerPanel(status: DockerStatusDashboard): string {
  const composeState = status.composeValid ? '{green-fg}valid{/green-fg}' : '{red-fg}invalid{/red-fg}';
  const lines: string[] = [
    `{bold}Docker CLI{/bold}: ${status.dockerCli || 'Unavailable'}`,
    `{bold}Docker Engine{/bold}: ${status.dockerEngine || 'Unavailable'}`,
    `{bold}Compose Config{/bold}: ${composeState}`,
    `{bold}Services{/bold}: ${status.runningCount}/${status.serviceCount} running`,
    `{bold}Checked{/bold}: ${new Date(status.checkedAt).toLocaleString()}`,
    '',
    '{bold}Compose Services{/bold}',
  ];
  if (status.services.length === 0) {
    lines.push('No compose services found.');
  } else {
    for (const service of status.services.slice(0, 12)) {
      const marker = service.state.toLowerCase().includes('running') || service.status.toLowerCase().includes('up')
        ? '{green-fg}*{/green-fg}'
        : '{red-fg}*{/red-fg}';
      const health = service.health !== 'n/a' ? ` | health=${service.health}` : '';
      lines.push(`${marker} ${truncate(service.name, 20)} | ${service.state}${health}`);
    }
    if (status.services.length > 12) lines.push(`...and ${status.services.length - 12} more`);
  }
  if (status.issues.length > 0) {
    lines.push('', '{bold}Issues{/bold}');
    for (const issue of status.issues) lines.push(`{red-fg}- ${truncate(issue, 96)}{/red-fg}`);
  }
  return lines.join('\n');
}

function renderInstancesTable(instances: ProjectInstanceStatus[]): void {
  const rows: string[][] = [['Prefix', 'State', 'Branch', 'Vite', 'URL']];
  displayedInstances = [];
  if (instances.length === 0) {
    rows.push(['-', '{yellow-fg}none{/yellow-fg}', '-', '-', '-']);
  } else {
    const sorted = [...instances].sort((a, b) => {
      if (a.status === b.status) return a.prefix.localeCompare(b.prefix);
      return a.status === 'running' ? -1 : 1;
    });
    displayedInstances = sorted;
    for (const inst of sorted) {
      const statusStyled = inst.status === 'running'
        ? '{green-fg}{bold}running{/bold}{/green-fg}'
        : '{red-fg}{bold}stopped{/bold}{/red-fg}';
      rows.push([
        `{bold}${inst.prefix}{/bold}`,
        statusStyled,
        `{white-fg}${truncate(inst.branch, 26)}{/white-fg}`,
        `{cyan-fg}${String(inst.vitePort)}{/cyan-fg}`,
        `{blue-fg}${truncate(inst.url, 28)}{/blue-fg}`,
      ]);
    }
  }
  const signature = buildTableSignature(rows);
  if (signature !== lastInstancesTableSignature) {
    instancesPanel.setData(rows);
    lastInstancesTableSignature = signature;
  }
}

function buildTableSignature(rows: string[][]): string {
  return rows.map(row => row.join('\u001f')).join('\u001e');
}

function getSelectedInstanceFromTable(): ProjectInstanceStatus | null {
  if (displayedInstances.length === 0) return null;
  const selected = ((instancesPanel as unknown as { selected?: number }).selected) ?? 1;
  const index = Math.max(0, selected - 1);
  return displayedInstances[index] ?? displayedInstances[0] ?? null;
}

async function refreshDashboardInternal(): Promise<void> {
  const bridgeOptions = toBridgeCallOptions();
  const [dockerStatus, instances] = await Promise.all([
    getDockerStatusDashboard(bridgeOptions),
    getProjectInstanceStatus(bridgeOptions),
  ]);
  latestDockerStatus = dockerStatus;
  setPanelContentCached(dockerPanel, formatDockerPanel(dockerStatus));
  renderInstancesTable(instances);
  renderInstancePowerPanel();
  renderSectionCharts();
  renderJobsPanel();
  setFooterStatus(`Last refresh ${nowTime()}`);
  requestRender();
}

function refreshDashboard(): Promise<void> {
  if (dashboardRefreshPromise) return dashboardRefreshPromise;
  dashboardRefreshPromise = refreshDashboardInternal().finally(() => { dashboardRefreshPromise = null; });
  return dashboardRefreshPromise;
}

/* ================================================================== */
/*  Action menu — categories, entries, rendering                       */
/* ================================================================== */

function initializeSectionRuntimeStats(): Record<ActionCategoryKey, SectionRuntimeStats> {
  const stats = {} as Record<ActionCategoryKey, SectionRuntimeStats>;
  for (const category of ACTION_CATEGORIES) {
    stats[category.key] = { runs: 0, success: 0, failed: 0, totalDurationMs: 0 };
  }
  return stats;
}

function recordSectionActionResult(categoryKey: ActionCategoryKey, succeeded: boolean, durationMs: number): void {
  const stats = sectionRuntimeStats[categoryKey];
  if (!stats) return;
  stats.runs += 1;
  stats.totalDurationMs += Math.max(0, durationMs);
  stats.lastDurationMs = Math.max(0, durationMs);
  stats.lastRunAt = new Date().toISOString();
  if (succeeded) { stats.success += 1; stats.lastResult = 'success'; }
  else { stats.failed += 1; stats.lastResult = 'failed'; }
}

function getCategoryDisplayName(key: ActionCategoryKey): string {
  return ACTION_CATEGORIES.find(c => c.key === key)?.title ?? key;
}

function getActionKindCountsByCategory(entries: ActionEntry[]): Record<ActionCategoryKey, { control: number; maintenance: number }> {
  const counts = {} as Record<ActionCategoryKey, { control: number; maintenance: number }>;
  for (const c of ACTION_CATEGORIES) counts[c.key] = { control: 0, maintenance: 0 };
  for (const a of entries) {
    if (a.kind === 'maintenance') counts[a.category].maintenance += 1;
    else counts[a.category].control += 1;
  }
  return counts;
}

function renderSectionCharts(): void {
  const countsByCategory = getActionKindCountsByCategory(actions);
  const lines: string[] = [];
  for (const category of ACTION_CATEGORIES) {
    const stats = sectionRuntimeStats[category.key];
    const counts = countsByCategory[category.key];
    if (!stats && !counts) continue;
    const successBar = buildHorizontalBar(stats.success, stats.runs || 1, 8);
    const failBar = buildHorizontalBar(stats.failed, stats.runs || 1, 8);
    const avg = stats.runs > 0 ? stats.totalDurationMs / stats.runs : 0;
    const lastStatus = stats.lastResult === 'failed' ? '{red-fg}fail{/red-fg}'
      : stats.lastResult === 'success' ? '{green-fg}ok{/green-fg}' : '{gray-fg}-{/gray-fg}';
    lines.push(
      `{bold}${getCategoryDisplayName(category.key)}{/bold} ` +
      `{cyan-fg}C${counts.control}{/cyan-fg}/{yellow-fg}M${counts.maintenance}{/yellow-fg} ` +
      `${successBar} ${failBar} ${lastStatus} avg:${formatDurationMs(avg)}`,
    );
  }
  setPanelContentCached(sectionPanel, lines.length > 0 ? lines.join('\n') : 'No section metrics available.');
}

function buildActionMenuEntries(actionEntries: ActionEntry[]): ActionMenuEntry[] {
  const grouped = new Map<ActionCategoryKey, ActionEntry[]>();
  for (const c of ACTION_CATEGORIES) grouped.set(c.key, []);
  for (const entry of actionEntries) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  const menuEntries: ActionMenuEntry[] = [];
  for (const category of ACTION_CATEGORIES) {
    const catActions = grouped.get(category.key) ?? [];
    if (catActions.length === 0) continue;
    const ctrl = catActions.filter(e => e.kind === 'control').length;
    const maint = catActions.filter(e => e.kind === 'maintenance').length;
    menuEntries.push({
      kind: 'category',
      category: category.key,
      label: `{bold}{${category.colorTag}}[${category.title}]{/${category.colorTag}}{/bold} {cyan-fg}C${ctrl}{/cyan-fg}/{yellow-fg}M${maint}{/yellow-fg}`,
    });
    for (const a of catActions) {
      const marker = a.kind === 'maintenance' ? '{yellow-fg}M{/yellow-fg}' : '{cyan-fg}C{/cyan-fg}';
      menuEntries.push({ kind: 'action', category: category.key, label: `  [${marker}] ${a.label}`, action: a });
    }
  }
  return menuEntries;
}

function getSelectedActionMenuIndex(): number {
  return ((actionMenu as unknown as { selected?: number }).selected) ?? 0;
}

function isActionMenuEntrySelectable(index: number, entries: ActionMenuEntry[]): boolean {
  const e = entries[index];
  return Boolean(e && e.kind === 'action' && e.action);
}

function findSelectableIndex(fromIndex: number, direction: 1 | -1, entries: ActionMenuEntry[]): number {
  if (entries.length === 0) return -1;
  let index = fromIndex;
  for (let i = 0; i < entries.length; i += 1) {
    index += direction;
    if (index < 0) index = entries.length - 1;
    else if (index >= entries.length) index = 0;
    if (isActionMenuEntrySelectable(index, entries)) return index;
  }
  return -1;
}

function ensureSelectableActionMenuIndex(direction: 1 | -1, entries: ActionMenuEntry[]): void {
  const current = getSelectedActionMenuIndex();
  if (isActionMenuEntrySelectable(current, entries)) return;
  const next = findSelectableIndex(current, direction, entries);
  if (next >= 0) actionMenu.select(next);
}

function jumpToNextActionCategory(entries: ActionMenuEntry[]): void {
  const current = getSelectedActionMenuIndex();
  const currentEntry = entries[current];
  const currentCategory = currentEntry?.category;
  if (!currentCategory) return;
  const order = ACTION_CATEGORIES.map(c => c.key);
  const idx = order.indexOf(currentCategory);
  if (idx < 0) return;
  for (let step = 1; step <= order.length; step += 1) {
    const catKey = order[(idx + step) % order.length];
    const target = entries.findIndex(e => e.category === catKey && e.kind === 'action');
    if (target >= 0) { actionMenu.select(target); return; }
  }
}

function getSelectedCategoryKey(entries: ActionMenuEntry[]): ActionCategoryKey | null {
  const e = entries[getSelectedActionMenuIndex()];
  return e?.category ?? null;
}

/* ================================================================== */
/*  Job queue system                                                   */
/* ================================================================== */

function getJobStatusTag(status: ActionJobStatus): string {
  if (status === 'running') return '{yellow-fg}RUN{/yellow-fg}';
  if (status === 'queued') return '{cyan-fg}QUE{/cyan-fg}';
  if (status === 'success') return '{green-fg}OK {/green-fg}';
  if (status === 'cancelled') return '{magenta-fg}CAN{/magenta-fg}';
  return '{red-fg}ERR{/red-fg}';
}

function getJobById(jobId: number): ActionJob | null {
  return actionJobs.find(j => j.id === jobId) ?? null;
}

function getActiveJob(): ActionJob | null {
  return activeJobId != null ? getJobById(activeJobId) : null;
}

function isActiveJobCancellationRequested(): boolean {
  return Boolean(getActiveJob()?.cancelRequested);
}

function renderJobsPanel(): void {
  const queued = actionJobs.filter(j => j.status === 'queued').length;
  const running = actionJobs.filter(j => j.status === 'running').length;
  const completed = actionJobs.filter(j => ['success', 'failed', 'cancelled'].includes(j.status)).length;
  const lines: string[] = [`q:${queued} r:${running} done:${completed} total:${actionJobs.length}`];
  const maxRows = Math.max(1, getBoxInnerRows(jobsPanel, 5) - 1);
  const recent = actionJobs.slice(-maxRows).reverse();
  for (const job of recent) {
    const tag = getJobStatusTag(job.status);
    const dur = job.durationMs ? formatDurationMs(job.durationMs) : '-';
    const cancelTag = job.cancelRequested && job.status === 'running' ? ' {yellow-fg}cancel...{/yellow-fg}' : '';
    lines.push(`${tag} #${String(job.id).padStart(3, '0')} ${truncate(job.action.label, 21)} ${dur}${cancelTag}`);
  }
  setPanelContentCached(jobsPanel, lines.join('\n'));
}

function enqueueActionJob(action: ActionEntry): ActionJob {
  const job: ActionJob = {
    id: nextJobId,
    action,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    cancelRequested: false,
    logLines: [],
  };
  nextJobId += 1;
  actionJobs.push(job);
  renderJobsPanel();
  return job;
}

async function exportActionJobLog(job: ActionJob): Promise<string | null> {
  if (job.logLines.length === 0) return null;
  await mkdir(JOB_LOG_DIR, { recursive: true });
  const fileName = `job-${String(job.id).padStart(3, '0')}-${timestampForFileName()}-${sanitizeForFileName(job.action.label)}.log`;
  const logPath = join(JOB_LOG_DIR, fileName);
  await writeFile(logPath, job.logLines.join('\n') + '\n', 'utf-8');
  return logPath;
}

function clearFinishedJobs(): number {
  const before = actionJobs.length;
  for (let i = actionJobs.length - 1; i >= 0; i -= 1) {
    if (['success', 'failed', 'cancelled'].includes(actionJobs[i].status)) actionJobs.splice(i, 1);
  }
  renderJobsPanel();
  return before - actionJobs.length;
}

function cancelRunningJob(): boolean {
  const active = getActiveJob();
  if (!active || active.status !== 'running') return false;
  active.cancelRequested = true;
  active.abortController?.abort();
  appendLog(`Cancel requested for running job #${String(active.id).padStart(3, '0')}: ${active.action.label}`);
  renderJobsPanel();
  return true;
}

function startTaskProgress(label: string): void {
  currentTaskLabel = label;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { appendLog(`...${label} still running`); }, 15000);
}

function stopTaskProgress(): void {
  currentTaskLabel = null;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

async function processActionQueue(): Promise<void> {
  if (isBusy) return;
  const nextJob = actionJobs.find(j => j.status === 'queued');
  if (!nextJob) return;

  isBusy = true;
  activeJobId = nextJob.id;
  const abortController = new AbortController();
  nextJob.abortController = abortController;
  nextJob.status = 'running';
  nextJob.startedAt = new Date().toISOString();
  nextJob.logLines.push(`[${nowTime()}] Job queued at ${nextJob.queuedAt}`);
  startTaskProgress(`#${String(nextJob.id).padStart(3, '0')} ${nextJob.action.label}`);
  setFooterStatus(`Running job #${String(nextJob.id).padStart(3, '0')}: ${nextJob.action.label}`);
  renderJobsPanel();
  requestRender();

  const startedAt = Date.now();
  let succeeded = false;

  try {
    appendLog(`Running #${String(nextJob.id).padStart(3, '0')} ${nextJob.action.label}...`);
    await nextJob.action.run({ jobId: nextJob.id, signal: abortController.signal });
    succeeded = true;
    appendLog(`Completed #${String(nextJob.id).padStart(3, '0')} ${nextJob.action.label}`);
  } catch (error) {
    nextJob.error = toErrorMessage(error);
    if (nextJob.cancelRequested || abortController.signal.aborted) {
      appendLog(`Cancelled #${String(nextJob.id).padStart(3, '0')} ${nextJob.action.label}`);
    } else {
      appendLog(`ERROR #${String(nextJob.id).padStart(3, '0')}: ${nextJob.error}`);
    }
  } finally {
    nextJob.durationMs = Date.now() - startedAt;
    nextJob.finishedAt = new Date().toISOString();
    nextJob.abortController = undefined;
    if (nextJob.cancelRequested) nextJob.status = 'cancelled';
    else if (succeeded) nextJob.status = 'success';
    else nextJob.status = 'failed';

    const jobLogPath = await exportActionJobLog(nextJob).catch(() => null);
    if (jobLogPath) { nextJob.logPath = jobLogPath; appendLog(`Job #${String(nextJob.id).padStart(3, '0')} log saved: ${jobLogPath}`); }

    recordSectionActionResult(nextJob.action.category, nextJob.status === 'success', nextJob.durationMs);
    renderSectionCharts();
    renderJobsPanel();

    isBusy = false;
    activeJobId = null;
    stopTaskProgress();

    try { await refreshDashboard(); } catch (e) { appendLog(`Refresh failed: ${toErrorMessage(e)}`); }
    actionMenu.focus();

    if (actionJobs.some(j => j.status === 'queued')) {
      setImmediate(() => void processActionQueue());
    }
  }
}

function runManagedAction(action: ActionEntry): void {
  if (action.bypassQueue) {
    if (isBusy) {
      appendLog(`Cannot run "${action.label}" while job is running: ${currentTaskLabel ?? 'unknown task'}`);
      return;
    }
    void (async () => {
      try { appendLog(`Running ${action.label}...`); await action.run(); appendLog(`Completed ${action.label}`); }
      catch (error) { appendLog(`ERROR: ${toErrorMessage(error)}`); }
      finally { renderJobsPanel(); requestRender(); }
    })();
    return;
  }
  const job = enqueueActionJob(action);
  appendLog(`Queued job #${String(job.id).padStart(3, '0')}: ${action.label}`);
  if (isBusy) { appendLog(`Current running job: ${currentTaskLabel ?? 'unknown task'}`); return; }
  void processActionQueue();
}

/* ================================================================== */
/*  Activity log + Result panel + Monitor tab                          */
/* ================================================================== */

function appendLog(message: string): void {
  const lines = message.split('\n');
  const activeJob = activeJobId != null ? getJobById(activeJobId) : null;
  for (const line of lines) {
    const stamped = `[${nowTime()}] ${line}`;
    activityLogLines.push(stamped);
    if (activityLogLines.length > ACTIVITY_LOG_MAX_LINES) activityLogLines.shift();
    if (activeJob) activeJob.logLines.push(stamped);
    logPanel.log(stamped);
  }
  if (activeActivityTab === 'log') requestRender();
}

function setResultContent(title: string, output: string): void {
  setPanelContentCached(resultPanel, formatResultContent(title, output));
}

function formatResultContent(title: string, output: string): string {
  const raw = output.trim();
  if (!raw) return `{bold}${title}{/bold}\n(no output)`;
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.checks) && obj.project) return summarizeDoctorResult(obj);
    if (Array.isArray(obj.results) && obj.package_manager) return summarizeInstallResult(obj);
    return `{bold}${title}{/bold}\n${truncateText(JSON.stringify(obj, null, 2))}`;
  }
  return `{bold}${title}{/bold}\n${truncateText(raw)}`;
}

function summarizeDoctorResult(parsed: Record<string, unknown>): string {
  const lines: string[] = ['{bold}System Doctor{/bold}'];
  lines.push(`Checked: ${String(parsed.checked_at ?? '-')}`);
  lines.push(`OS/Arch: ${String(parsed.os ?? '-')} / ${String(parsed.arch ?? '-')}`);
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  if (checks.length > 0) {
    lines.push('', '{bold}Checks{/bold}');
    for (const check of checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
      const row = check as Record<string, unknown>;
      const ok = row.installed === true ? '{green-fg}ok{/green-fg}' : '{red-fg}missing{/red-fg}';
      const name = String(row.name ?? 'unknown');
      const version = String(row.version ?? '').trim();
      lines.push(`- ${name}: ${ok}${version ? ` (${version})` : ''}`);
    }
  }
  const missing = Array.isArray(parsed.missing) ? parsed.missing.filter((i): i is string => typeof i === 'string') : [];
  lines.push('', `Missing: ${missing.length > 0 ? missing.join(', ') : 'none'}`);
  const project = parsed.project;
  if (project && typeof project === 'object' && !Array.isArray(project)) {
    const p = project as Record<string, unknown>;
    const cv = p.compose_valid === true ? '{green-fg}true{/green-fg}' : '{red-fg}false{/red-fg}';
    const svcs = Array.isArray(p.services) ? p.services : [];
    const running = svcs.filter(s => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
      const r = s as Record<string, unknown>;
      return String(r.state ?? '').toLowerCase().includes('running') || String(r.status ?? '').toLowerCase().includes('up');
    }).length;
    lines.push(`Compose valid: ${cv} | Services: ${running}/${svcs.length} running`);
  }
  return lines.join('\n');
}

function summarizeInstallResult(parsed: Record<string, unknown>): string {
  const lines: string[] = ['{bold}System Install{/bold}'];
  lines.push(`Package manager: ${String(parsed.package_manager ?? '-')}`);
  lines.push(`Executed: ${String(parsed.executed_at ?? '-')}`);
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (results.length > 0) {
    lines.push('', '{bold}Targets{/bold}');
    for (const entry of results) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const target = String(row.target ?? 'unknown');
      const installedAfter = row.installed_after === true;
      const changed = row.changed === true;
      const state = installedAfter ? '{green-fg}ok{/green-fg}' : '{red-fg}failed{/red-fg}';
      lines.push(`- ${target}: ${state} (${changed ? 'updated' : 'no-change'})`);
    }
  }
  return lines.join('\n');
}

function presentActionOutput(title: string, output: string): void {
  const raw = String(output ?? '').trim();
  if (!raw) return;
  const activeJob = getActiveJob();
  if (activeJob) {
    const preview = truncateText(raw, 120, 12000);
    activeJob.logLines.push(`[${nowTime()}] [result:${title}]`);
    for (const line of preview.split('\n')) activeJob.logLines.push(`[${nowTime()}] ${line}`);
  }
  setResultContent(title, raw);
  const lineCount = raw.split('\n').length;
  const looksStructured = raw.startsWith('{') || raw.startsWith('[');
  if (looksStructured || lineCount > 18 || raw.length > 1800) {
    if (activeActivityTab === 'log') setActivityTab('result');
    appendLog(`[${title}] Output sent to Result tab (${lineCount} lines).`);
    return;
  }
  appendLog(raw);
}

function activityTabLabel(tab: ActivityTabKey, text: string): string {
  if (activeActivityTab === tab) return `{black-fg}{yellow-bg} ${text} {/yellow-bg}{/black-fg}`;
  return `{gray-fg}${text}{/gray-fg}`;
}

function renderActivityTabHeader(): void {
  const label = ` Activity ${activityTabLabel('log', 'Log')} | ${activityTabLabel('result', 'Result')} | ${activityTabLabel('monitor', 'Monitor')} `;
  logPanel.setLabel(label);
  resultPanel.setLabel(label);
  monitorPanel.setLabel(label);
}

function setActivityTab(tab: ActivityTabKey): void {
  activeActivityTab = tab;
  if (tab === 'log') { logPanel.show(); resultPanel.hide(); monitorPanel.hide(); }
  else if (tab === 'result') { logPanel.hide(); resultPanel.show(); monitorPanel.hide(); }
  else { logPanel.hide(); resultPanel.hide(); monitorPanel.show(); }
  renderActivityTabHeader();
  if (tab === 'monitor') { updateMonitorPanel(); void refreshMonitorHeavySnapshot(true); }
  requestRender();
}

function cycleActivityTab(direction: 1 | -1): void {
  const order: ActivityTabKey[] = ['log', 'result', 'monitor'];
  const index = order.indexOf(activeActivityTab);
  const next = (index + direction + order.length) % order.length;
  setActivityTab(order[next]);
}

function canHandleActivityTabHotkeys(): boolean {
  const focused = screen.focused;
  return focused === actionMenu || focused === logPanel || focused === resultPanel
    || focused === monitorPanel || focused === dockerPanel || focused === instancesPanel
    || focused === jobsPanel || focused === instancePowerPanel;
}

function hasModalOrInputFocus(): boolean {
  const focused = screen.focused;
  if (!focused) return false;
  return focused !== actionMenu && focused !== logPanel && focused !== resultPanel
    && focused !== monitorPanel && focused !== dockerPanel && focused !== instancesPanel
    && focused !== jobsPanel && focused !== instancePowerPanel;
}

function setFooterStatus(status: string): void {
  const alertSuffix = activeAlerts.size > 0 ? ` | alerts:${activeAlerts.size}` : '';
  setPanelContentCached(
    footer,
    ` {bold}Keys:{/bold} Up/Down navigate | Tab next category | Enter run | i instance-power | / ai-ops | j queue | ? search | [/]/1-3 tabs | r refresh | y copy-log | e export | q quit | ${status}${alertSuffix}`,
  );
}

function getActivityLogText(maxLines = 0): string {
  const lines = maxLines > 0 ? activityLogLines.slice(-maxLines) : activityLogLines;
  return lines.join('\n') + '\n';
}

/* ================================================================== */
/*  Monitor tab (CPU/memory/disk sparklines)                           */
/* ================================================================== */

function sampleCpuUsage(): { total: number | null; perCore: number[] } {
  const cores = os.cpus();
  const coreSamples = cores.map(core => {
    const total = core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
    return { idle: core.times.idle, total };
  });
  const idle = coreSamples.reduce((sum, s) => sum + s.idle, 0);
  const total = coreSamples.reduce((sum, s) => sum + s.total, 0);
  if (!lastCpuSample || !lastCpuCoreSamples || lastCpuCoreSamples.length !== coreSamples.length) {
    lastCpuSample = { idle, total };
    lastCpuCoreSamples = coreSamples;
    return { total: null, perCore: [] };
  }
  const idleDiff = idle - lastCpuSample.idle;
  const totalDiff = total - lastCpuSample.total;
  const totalUsage = totalDiff <= 0 ? 0 : clamp((1 - idleDiff / totalDiff) * 100, 0, 100);
  const perCore = coreSamples.map((sample, i) => {
    const prev = lastCpuCoreSamples?.[i];
    if (!prev) return 0;
    const d = sample.total - prev.total;
    return d <= 0 ? 0 : clamp((1 - (sample.idle - prev.idle) / d) * 100, 0, 100);
  });
  lastCpuSample = { idle, total };
  lastCpuCoreSamples = coreSamples;
  return { total: totalUsage, perCore };
}

function pushHistory(history: number[], value: number): void {
  history.push(clamp(value, 0, 100));
  if (history.length > MONITOR_HISTORY_POINTS) history.shift();
}

function parseDockerUsageRows(raw: string | null): MonitorDockerUsageRow[] {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const parts = line.split(/\s{2,}/).map(p => p.trim());
    const name = parts[0] ?? '';
    const cpuStr = parts[1]?.replace('%', '') ?? '0';
    const memStr = parts[2] ?? '0';
    const memPctStr = parts[6]?.replace('%', '') ?? '0';
    return { name, cpu: parseFloat(cpuStr) || 0, memPct: parseFloat(memPctStr) || 0, memUsage: memStr };
  });
}

function parseTopProcessRows(raw: string | null): MonitorProcessRow[] {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).slice(0, 15).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      pid: parts[0] ?? '?',
      cpu: parseFloat(parts[1] ?? '0') || 0,
      mem: parseFloat(parts[2] ?? '0') || 0,
      command: parts.slice(3).join(' ') || 'unknown',
    };
  });
}

async function safeShellAsync(command: string, timeout = MONITOR_SHELL_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    execFile('sh', ['-lc', command], { cwd: BASE_DIR, timeout, encoding: 'utf-8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      resolve(stdout.trim());
    });
  });
}

async function refreshMonitorHeavySnapshot(force = false): Promise<void> {
  if (monitorHeavySnapshot.collecting) return;
  const now = Date.now();
  if (!force && now - monitorHeavySnapshot.lastCollectedAt < MONITOR_HEAVY_REFRESH_MS) return;
  monitorHeavySnapshot.collecting = true;
  try {
    const [disk, docker, top] = await Promise.all([
      safeShellAsync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\" used)\"}'"),
      safeShellAsync('docker stats --no-stream --format "{{.Name}}  {{.CPUPerc}}  {{.MemUsage}}  {{.MemPerc}}" 2>/dev/null'),
      safeShellAsync('ps -eo pid,%cpu,%mem,comm --sort=-%cpu --no-headers 2>/dev/null | head -12'),
    ]);
    monitorHeavySnapshot.diskUsage = disk;
    monitorHeavySnapshot.dockerStats = docker;
    monitorHeavySnapshot.topProcesses = top;
    monitorHeavySnapshot.lastError = null;
    monitorHeavySnapshot.lastCollectedAt = Date.now();
  } catch (error) {
    monitorHeavySnapshot.lastError = toErrorMessage(error);
  } finally {
    monitorHeavySnapshot.collecting = false;
  }
}

function getMonitorSparkWidth(): number {
  const trendWidth = Number(monitorTrendsBox.width);
  if (Number.isFinite(trendWidth) && trendWidth > 12) return clamp(Math.floor(trendWidth) - 10, 18, 48);
  const width = typeof screen.width === 'number' ? screen.width : 120;
  return clamp(Math.floor(width * 0.22), 18, 48);
}

function collectMonitorAlerts(cpuUsage: number, memUsagePercent: number, normalizedLoad: number): void {
  const now = new Date().toISOString();
  const check = (key: string, title: string, value: number, threshold: number): void => {
    if (value >= threshold) {
      const detail = `${value.toFixed(1)}% (threshold ${threshold}%)`;
      const sev: IncidentSeverity = value >= 95 ? 'critical' : 'warn';
      const existing = activeAlerts.get(key);
      if (!existing) {
        activeAlerts.set(key, { key, title, detail, severity: sev, since: now, lastSeen: now });
      } else {
        existing.detail = detail;
        existing.severity = sev;
        existing.lastSeen = now;
      }
    } else {
      activeAlerts.delete(key);
    }
  };
  check('host-cpu-high', 'CPU High', cpuUsage, ALERT_CPU_PERCENT);
  check('host-mem-high', 'Memory High', memUsagePercent, ALERT_MEM_PERCENT);
  check('host-load-high', 'Load High', normalizedLoad, ALERT_LOAD_PERCENT);
}

function updateMonitorPanel(): void {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = Math.max(0, memTotal - memFree);
  const memUsagePercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const cpuSample = sampleCpuUsage();
  const cpuUsage = cpuSample.total ?? 0;
  const load = os.loadavg();
  const coreCount = Math.max(1, os.cpus().length);
  const normalizedLoad = clamp((load[0] / coreCount) * 100, 0, 100);
  const uptimeSeconds = os.uptime();
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const sparkWidth = getMonitorSparkWidth();

  pushHistory(monitorCpuHistory, cpuUsage);
  pushHistory(monitorMemHistory, memUsagePercent);
  pushHistory(monitorLoadHistory, normalizedLoad);
  collectMonitorAlerts(cpuUsage, memUsagePercent, normalizedLoad);

  const heavyAge = monitorHeavySnapshot.lastCollectedAt > 0
    ? `${Math.max(0, Math.round((Date.now() - monitorHeavySnapshot.lastCollectedAt) / 1000))}s ago` : 'pending';
  const summaryLines: string[] = [];
  summaryLines.push(`{bold}Host{/bold} ${truncate(os.hostname(), 26)}`);
  summaryLines.push(`{gray-fg}${os.platform()} ${os.release()} ${os.arch()}{/gray-fg}`);
  summaryLines.push(`{bold}Time{/bold} ${timestamp}`);
  summaryLines.push(`{bold}Uptime{/bold} ${uptimeHours}h ${uptimeMinutes}m`);
  summaryLines.push(`{bold}Cores{/bold} ${coreCount}`);
  summaryLines.push(`{bold}Heavy{/bold} ${heavyAge}${monitorHeavySnapshot.collecting ? ' (refresh)' : ''}`);
  if (monitorHeavySnapshot.diskUsage) summaryLines.push(`{bold}Disk{/bold} ${monitorHeavySnapshot.diskUsage}`);
  if (monitorHeavySnapshot.lastError) summaryLines.push(`{yellow-fg}${truncate(monitorHeavySnapshot.lastError, 42)}{/yellow-fg}`);
  if (activeAlerts.size > 0) {
    summaryLines.push('{bold}Alerts{/bold}');
    for (const alert of Array.from(activeAlerts.values()).slice(0, 3)) {
      summaryLines.push(`- ${severityTag(alert.severity)} ${truncate(alert.title, 18)} ${truncate(alert.detail, 20)}`);
    }
    if (activeAlerts.size > 3) summaryLines.push(`...+${activeAlerts.size - 3} more`);
  } else {
    summaryLines.push('{bold}Alerts{/bold} none');
  }
  setPanelContentCached(monitorSummaryBox, summaryLines.join('\n'));

  const trendLines: string[] = [];
  trendLines.push(`CPU  ${renderPercentBadge(cpuUsage)} ${buildHorizontalBar(cpuUsage, 100, 14)} ${load.map(v => v.toFixed(2)).join(' / ')}`);
  trendLines.push(`     {cyan-fg}${renderSparkline(monitorCpuHistory, sparkWidth)}{/cyan-fg}`);
  trendLines.push(`RAM  ${renderPercentBadge(memUsagePercent)} ${buildHorizontalBar(memUsagePercent, 100, 14)} ${(memUsed / (1024 ** 3)).toFixed(1)}G/${(memTotal / (1024 ** 3)).toFixed(1)}G`);
  trendLines.push(`     {magenta-fg}${renderSparkline(monitorMemHistory, sparkWidth)}{/magenta-fg}`);
  trendLines.push(`LOAD ${renderPercentBadge(normalizedLoad)} ${buildHorizontalBar(normalizedLoad, 100, 14)} 1m/core`);
  trendLines.push(`     {yellow-fg}${renderSparkline(monitorLoadHistory, sparkWidth)}{/yellow-fg}`);
  if (cpuSample.perCore.length > 0) {
    const coreLines = cpuSample.perCore.map((v, i) => ({ index: i, value: v })).sort((a, b) => b.value - a.value).slice(0, 3)
      .map(c => `c${String(c.index).padStart(2, '0')} ${buildHorizontalBar(c.value, 100, 8)} ${c.value.toFixed(0)}%`);
    trendLines.push(...coreLines);
  } else {
    trendLines.push('{gray-fg}Sampling cores...{/gray-fg}');
  }
  setPanelContentCached(monitorTrendsBox, trendLines.join('\n'));

  const processRows = parseTopProcessRows(monitorHeavySnapshot.topProcesses);
  const processMaxRows = Math.max(3, getBoxInnerRows(monitorProcessesBox, 10) - 2);
  const processLines: string[] = ['PID   CMD             CPU        MEM'];
  if (processRows.length > 0) {
    for (const row of processRows.slice(0, processMaxRows)) {
      processLines.push(
        `${row.pid.padStart(5, ' ')} ${truncate(row.command, 14).padEnd(14, ' ')} ` +
        `${buildHorizontalBar(row.cpu, 100, 6)} ${row.cpu.toFixed(0).padStart(3, ' ')}% ${row.mem.toFixed(0).padStart(3, ' ')}%`,
      );
    }
  } else {
    processLines.push('process snapshot unavailable');
  }
  setPanelContentCached(monitorProcessesBox, processLines.join('\n'));

  const dockerMaxRows = Math.max(3, getBoxInnerRows(monitorDockerBox, 10) - 2);
  const dockerRows = parseDockerUsageRows(monitorHeavySnapshot.dockerStats);
  const dockerLines: string[] = ['NAME             CPU            MEM'];
  if (dockerRows.length > 0) {
    for (const row of dockerRows.slice(0, dockerMaxRows)) {
      dockerLines.push(
        `${truncate(row.name, 15).padEnd(15, ' ')} ${buildHorizontalBar(row.cpu, 100, 6)} ${row.cpu.toFixed(0).padStart(3, ' ')}% ${row.memPct.toFixed(0).padStart(3, ' ')}%`,
      );
    }
  } else {
    dockerLines.push('docker stats unavailable');
  }
  setPanelContentCached(monitorDockerBox, dockerLines.join('\n'));
  void refreshMonitorHeavySnapshot();
}

function applyMonitorLayout(): void {
  monitorSplitPercent = clamp(monitorSplitPercent, MONITOR_SPLIT_MIN_PERCENT, MONITOR_SPLIT_MAX_PERCENT);
  monitorTopPercent = clamp(monitorTopPercent, MONITOR_TOP_MIN_PERCENT, MONITOR_TOP_MAX_PERCENT);
  const leftW = `${monitorSplitPercent}%`;
  const rightW = `${100 - monitorSplitPercent}%`;
  const topH = `${monitorTopPercent}%`;
  const botH = `${100 - monitorTopPercent}%`;
  const rightL = `${monitorSplitPercent}%`;
  const botT = `${monitorTopPercent}%`;
  monitorSummaryBox.left = 0; monitorSummaryBox.top = 0; monitorSummaryBox.width = leftW; monitorSummaryBox.height = topH;
  monitorTrendsBox.left = rightL; monitorTrendsBox.top = 0; monitorTrendsBox.width = rightW; monitorTrendsBox.height = topH;
  monitorProcessesBox.left = 0; monitorProcessesBox.top = botT; monitorProcessesBox.width = leftW; monitorProcessesBox.height = botH;
  monitorDockerBox.left = rightL; monitorDockerBox.top = botT; monitorDockerBox.width = rightW; monitorDockerBox.height = botH;
}

/* ================================================================== */
/*  Instance power controls                                            */
/* ================================================================== */

function renderInstancePowerPanel(): void {
  const selected = getSelectedInstanceFromTable();
  if (!selected) {
    setPanelContentCached(instancePowerPanel, 'No instance selected. Refresh dashboard to load instances.');
    return;
  }
  const statusTag = selected.status === 'running' ? '{green-fg}running{/green-fg}' : '{red-fg}stopped{/red-fg}';
  setPanelContentCached(instancePowerPanel, [
    `${selected.prefix} (${statusTag}) ${truncate(selected.branch, 20)}`,
    `{gray-fg}i{/gray-fg}=quick controls | logs restart shell artisan`,
  ].join('\n'));
}

function getAvailableDockerServiceNames(): Set<string> {
  const services = latestDockerStatus?.services ?? [];
  return new Set(services.map(s => s.name).filter((n): n is string => typeof n === 'string' && n.length > 0));
}

function getInstanceWorkerServices(prefix: string): string[] {
  const candidates = [`${prefix}-worker`, `${prefix}-workers`, `${prefix}-queue`, `${prefix}-horizon`];
  const available = getAvailableDockerServiceNames();
  return candidates.filter(s => available.has(s));
}

function uniqueServices(services: string[]): string[] {
  return Array.from(new Set(services.filter(Boolean)));
}

async function openInstanceQuickControls(context?: ActionExecutionContext): Promise<void> {
  const selected = getSelectedInstanceFromTable();
  const prefix = selected?.prefix ?? await promptInput('Instance prefix for quick controls:');
  if (!prefix) { appendLog('Instance quick controls cancelled.'); return; }

  const appService = `${prefix}-app`;
  const workerServices = getInstanceWorkerServices(prefix);
  const choice = await pickFromList(`Instance Power: ${prefix}`, [
    'Show App Logs (tail 200)',
    'Restart App Container',
    'Restart App + Worker Services',
    'Restart Full Instance Route (App + Worker + Caddy)',
    'Run Artisan: migrate --force',
    'Run Artisan: optimize:clear',
    'Run Artisan: queue:restart',
    'Run Shell Command In App',
  ]);
  if (!choice) { appendLog('Instance quick controls cancelled.'); return; }

  const options = toBridgeCallOptions(context);
  if (choice === 'Show App Logs (tail 200)') {
    presentActionOutput(`Instance ${prefix}: Logs`, await runDockerLogs(appService, 200, true, options));
  } else if (choice === 'Restart App Container') {
    presentActionOutput(`Instance ${prefix}: Restart App`, await runDockerRestartServices([appService], options));
  } else if (choice === 'Restart App + Worker Services') {
    const services = uniqueServices([appService, ...workerServices]);
    if (workerServices.length === 0) appendLog(`No worker services detected for ${prefix}; restarting app container only.`);
    presentActionOutput(`Instance ${prefix}: Restart App+Workers`, await runDockerRestartServices(services, options));
  } else if (choice === 'Restart Full Instance Route (App + Worker + Caddy)') {
    const services = uniqueServices([appService, ...workerServices, 'caddy']);
    presentActionOutput(`Instance ${prefix}: Restart Full Route`, await runDockerRestartServices(services, options));
  } else if (choice === 'Run Artisan: migrate --force') {
    presentActionOutput(`Instance ${prefix}: Artisan migrate`, await runLaravelControl({ prefix, artisanCommand: 'migrate --force' }, options));
  } else if (choice === 'Run Artisan: optimize:clear') {
    presentActionOutput(`Instance ${prefix}: Artisan optimize:clear`, await runLaravelControl({ prefix, artisanCommand: 'optimize:clear' }, options));
  } else if (choice === 'Run Artisan: queue:restart') {
    presentActionOutput(`Instance ${prefix}: Artisan queue:restart`, await runLaravelControl({ prefix, artisanCommand: 'queue:restart' }, options));
  } else {
    const command = await promptInput('Shell command for app container:', 'php -v', true);
    if (!command) { appendLog('Shell command cancelled.'); return; }
    const user = await promptInput('Container user (default sail):', 'sail', true);
    presentActionOutput(`Instance ${prefix}: Shell`, await runDockerExec(appService, command, 300000, user || 'sail', options));
  }
}

/* ================================================================== */
/*  AI Ops Command Palette                                             */
/* ================================================================== */

function findActionByLabel(label: string): ActionEntry | null {
  return actions.find(e => e.label === label) ?? null;
}

function suggestAIOpsNextActions(plan: AIOpsPlan): AIOpsSuggestion[] {
  const suggestions: AIOpsSuggestion[] = [];
  const add = (label: string, reason: string, severity: IncidentSeverity = 'info'): void => {
    if (plan.actionLabels.includes(label)) return;
    if (!findActionByLabel(label)) return;
    if (suggestions.some(s => s.actionLabel === label)) return;
    suggestions.push({ actionLabel: label, reason, severity });
  };

  if (activeAlerts.size > 0) {
    add('System Doctor: Check Prerequisites', `${activeAlerts.size} active alerts require review.`, 'warn');
  }
  if (latestDockerStatus && latestDockerStatus.runningCount < latestDockerStatus.serviceCount) {
    add('Docker Maintenance: Compose PS', 'Not all docker services are running; inspect compose status.', 'warn');
    add('Quick Fix: Triage Unhealthy Service', 'One-click triage can capture logs before remediation.', 'warn');
  }
  const queuedOrRunning = actionJobs.filter(j => j.status === 'queued' || j.status === 'running').length;
  if (queuedOrRunning > 0 || isBusy) {
    add('Jobs: Manage Queue', `There are ${queuedOrRunning} queued/running jobs.`, 'info');
  }
  if (suggestions.length === 0) {
    add('Refresh Dashboard', 'No active anomalies detected; refresh for a fresh baseline.', 'info');
  }
  return suggestions;
}

function buildAIOpsPostQueueSummary(intent: string, plan: AIOpsPlan, queuedActions: string[], suggestions: AIOpsSuggestion[]): string {
  const lines: string[] = ['{bold}AI Ops Execution Summary{/bold}'];
  lines.push(`intent: ${intent}`, `plan: ${plan.title}`, `risk: ${plan.risk}`, `queued_actions: ${queuedActions.length}`);
  if (latestDockerStatus) lines.push(`docker_services_running: ${latestDockerStatus.runningCount}/${latestDockerStatus.serviceCount}`);
  const running = displayedInstances.filter(e => e.status === 'running').length;
  lines.push(`instances_running: ${running}/${displayedInstances.length}`, `active_alerts: ${activeAlerts.size}`);
  if (queuedActions.length > 0) { lines.push('', '{bold}Queued Actions{/bold}'); for (const l of queuedActions) lines.push(`- ${l}`); }
  if (suggestions.length > 0) {
    lines.push('', '{bold}Next Best Actions{/bold}');
    for (const s of suggestions.slice(0, 8)) lines.push(`- ${s.actionLabel} (${severityTag(s.severity)}): ${s.reason}`);
  }
  return lines.join('\n');
}

async function runAIOpsCommandPalette(): Promise<void> {
  const intent = await promptInput('AI Ops intent:', '', false);
  if (!intent) { appendLog('AI Ops palette cancelled.'); return; }

  const plan = inferAIOpsPlan(intent);
  const suggestions = suggestAIOpsNextActions(plan);
  const lines: string[] = [];
  lines.push('{bold}AI Ops Plan{/bold}');
  lines.push(`intent: ${intent}`, `title: ${plan.title}`, `risk: ${plan.risk}`);
  if (plan.typedApprovalPhrase) lines.push(`high_risk_approval: required ("${plan.typedApprovalPhrase}")`);
  lines.push('', '{bold}Actions{/bold}');
  for (const label of plan.actionLabels) {
    const exists = findActionByLabel(label) ? '{green-fg}available{/green-fg}' : '{red-fg}missing{/red-fg}';
    lines.push(`- ${label} (${exists})`);
  }
  if (plan.notes.length > 0) { lines.push('', '{bold}Notes{/bold}'); for (const n of plan.notes) lines.push(`- ${n}`); }
  if (suggestions.length > 0) {
    lines.push('', '{bold}Next Best Actions{/bold}');
    for (const s of suggestions) lines.push(`- ${s.actionLabel} (${severityTag(s.severity)}): ${s.reason}`);
  }
  setResultContent('AI Ops Command Palette', lines.join('\n'));
  setActivityTab('result');
  appendLog(`AI Ops plan generated: ${plan.title} (risk=${plan.risk}, suggestions=${suggestions.length})`);

  const approve = await promptInput('Execute this plan now? (y/N):', 'n', true);
  if (!parseYesNoWithDefault(approve, false)) { appendLog('AI Ops execution skipped.'); return; }
  if (plan.typedApprovalPhrase) {
    const approved = await confirmTypedAction(`High-risk AI Ops plan "${plan.title}" requires typed approval.`, plan.typedApprovalPhrase);
    if (!approved) { appendLog('AI Ops high-risk approval failed; execution blocked.'); return; }
    appendLog(`AI Ops high-risk approval accepted for plan: ${plan.title}`);
  }

  const queuedActions: string[] = [];
  for (const label of plan.actionLabels) {
    const action = findActionByLabel(label);
    if (!action) { appendLog(`AI Ops skipped missing action: ${label}`); continue; }
    if (action.bypassQueue) {
      try { appendLog(`AI Ops running interactive action: ${label}`); await action.run(); queuedActions.push(`${label} (interactive)`); }
      catch (e) { appendLog(`AI Ops interactive action failed (${label}): ${toErrorMessage(e)}`); }
      continue;
    }
    runManagedAction(action);
    queuedActions.push(label);
  }
  setResultContent('AI Ops Summary', buildAIOpsPostQueueSummary(intent, plan, queuedActions, suggestions));
  setActivityTab('result');
}

/* ================================================================== */
/*  First-run wizard                                                   */
/* ================================================================== */

function extractInstallableMissingTargets(doctorOutput: string): string[] {
  const parsed = parseJsonObject(doctorOutput);
  if (!parsed || !Array.isArray(parsed.missing)) return [];
  return parsed.missing.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => installableTargets.has(v));
}

function isDoctorComposeValid(doctorOutput: string): boolean {
  const parsed = parseJsonObject(doctorOutput);
  if (!parsed?.project || typeof parsed.project !== 'object' || Array.isArray(parsed.project)) return false;
  return (parsed.project as Record<string, unknown>).compose_valid === true;
}

interface WizardRepairStep {
  label: string;
  command: string;
  run: (context?: ActionExecutionContext) => Promise<string>;
}

function buildWizardRepairSteps(doctorOutput: string): WizardRepairStep[] {
  const steps: WizardRepairStep[] = [];
  const missingTargets = extractInstallableMissingTargets(doctorOutput);
  if (missingTargets.length > 0) {
    steps.push({
      label: `Install missing tooling: ${missingTargets.join(', ')}`,
      command: `system_install targets=${missingTargets.join(',')}`,
      run: async (ctx) => runSystemInstall(missingTargets, tuiState.packageManager, toBridgeCallOptions(ctx)),
    });
  }
  if (!isDoctorComposeValid(doctorOutput)) {
    steps.push({
      label: 'Repair docker compose config and bring stack up',
      command: 'project_bootstrap mode=up',
      run: async (ctx) => runProjectBootstrap('up', toBridgeCallOptions(ctx)),
    });
  }
  return steps;
}

async function runWizardRepairMode(doctorOutput: string, context?: ActionExecutionContext): Promise<void> {
  const steps = buildWizardRepairSteps(doctorOutput);
  if (steps.length === 0) { appendLog('Repair mode: no automatic fixes needed.'); return; }
  const summaryLines: string[] = ['{bold}Repair Plan{/bold}'];
  for (const s of steps) { summaryLines.push(`- ${s.label}`); summaryLines.push(`  cmd: ${s.command}`); }
  setResultContent('Wizard: Repair Plan', summaryLines.join('\n'));
  setActivityTab('result');
  appendLog(`Repair mode prepared ${steps.length} suggested fix steps.`);

  const options = ['Run All Repair Steps', ...steps.map(s => `Run: ${s.label}`), 'Skip Repair Steps'];
  const choice = await pickFromList('Setup Wizard: Repair Mode', options);
  if (!choice || choice === 'Skip Repair Steps') { appendLog('Repair mode skipped.'); return; }
  if (choice === 'Run All Repair Steps') {
    for (const step of steps) {
      if (isActiveJobCancellationRequested()) { appendLog('Repair mode cancelled.'); return; }
      appendLog(`Repair step: ${step.label}`);
      presentActionOutput(`Repair: ${step.label}`, await step.run(context));
    }
    appendLog('Repair mode completed.');
    return;
  }
  const selected = steps.find(s => `Run: ${s.label}` === choice);
  if (!selected) { appendLog('Repair mode selection cancelled.'); return; }
  appendLog(`Repair step: ${selected.label}`);
  presentActionOutput(`Repair: ${selected.label}`, await selected.run(context));
}

async function runFirstRunWizard(force = false, context?: ActionExecutionContext): Promise<void> {
  if (!force && tuiState.firstRunCompleted) return;
  appendLog(force ? 'Starting setup wizard...' : 'First run detected. Starting setup wizard.');
  const cont = await promptInput(force ? 'Run setup wizard now? (Y/n):' : 'Run first-time setup wizard now? (Y/n):', 'y', true);
  if (!parseYesNoWithDefault(cont, true)) { appendLog('Setup wizard skipped.'); return; }

  const token = await promptInput('Default GitHub token override (optional; blank uses gh auth token or env):', githubContext.token ?? tuiState.githubToken ?? '', true);
  const pkgChoice = await pickFromList('Default Package Manager', ['auto', 'brew', 'apt', 'dnf', 'pacman']);
  githubContext.token = token || undefined;
  tuiState.githubToken = githubContext.token;
  tuiState.packageManager = (pkgChoice ?? tuiState.packageManager) as InstallPackageManager;
  await saveTuiState();

  appendLog('Wizard step: running system doctor...');
  let doctorOutput = await runSystemDoctor(true, toBridgeCallOptions(context));
  presentActionOutput('Wizard: System Doctor', doctorOutput);

  const repairAns = await promptInput('Run wizard repair mode suggestions now? (Y/n):', 'y', true);
  if (parseYesNoWithDefault(repairAns, true)) {
    await runWizardRepairMode(doctorOutput, context);
    doctorOutput = await runSystemDoctor(true, toBridgeCallOptions(context));
    presentActionOutput('Wizard: System Doctor (Post-Repair)', doctorOutput);
  } else { appendLog('Repair mode skipped.'); }

  const missingTargets = extractInstallableMissingTargets(doctorOutput);
  if (missingTargets.length > 0) {
    appendLog(`Wizard detected missing installable targets: ${missingTargets.join(', ')}`);
    const installAns = await promptInput('Install missing targets now? (Y/n):', 'y', true);
    if (parseYesNoWithDefault(installAns, true)) {
      presentActionOutput('Wizard: System Install', await runSystemInstall(missingTargets, tuiState.packageManager, toBridgeCallOptions(context)));
    } else { appendLog('Skipped automatic dependency installation.'); }
  } else { appendLog('No missing installable targets detected.'); }

  const bootstrapAns = await promptInput('Run project bootstrap now? (Y/n):', 'y', true);
  if (parseYesNoWithDefault(bootstrapAns, true)) {
    const mode = (await pickFromList('Bootstrap Mode', ['install', 'up', 'fresh']) ?? 'install') as ProjectBootstrapMode;
    appendLog(`Wizard step: running project bootstrap (${mode})...`);
    presentActionOutput('Wizard: Project Bootstrap', await runProjectBootstrap(mode, toBridgeCallOptions(context)));
  } else { appendLog('Skipped project bootstrap.'); }

  tuiState.firstRunCompleted = true;
  await saveTuiState();
  appendLog('Setup wizard completed.');
}

/* ================================================================== */
/*  Prompt and picker UI helpers                                       */
/* ================================================================== */

async function promptInput(label: string, initial = '', allowEmpty = false): Promise<string | null> {
  return new Promise(resolve => {
    const prompt = blessed.prompt({
      parent: screen, border: 'line', width: '70%', height: 9, top: 'center', left: 'center',
      label: ' Input ', keys: true, vi: true, tags: true, style: { border: { fg: 'yellow' } },
    });
    prompt.input(label, initial, (_err, value) => {
      prompt.destroy(); actionMenu.focus(); requestRender();
      if (value == null) { resolve(null); return; }
      const n = String(value).trim();
      if (!allowEmpty && !n) { resolve(null); return; }
      resolve(n);
    });
  });
}

async function pickFromList(title: string, items: string[]): Promise<string | null> {
  return new Promise(resolve => {
    const list = blessed.list({
      parent: screen, label: ` ${title} `, top: 'center', left: 'center', width: '70%', height: '70%',
      border: 'line', keys: true, vi: true, mouse: true,
      style: { border: { fg: 'yellow' }, selected: { fg: 'black', bg: 'yellow' } },
      items, scrollable: true, alwaysScroll: true,
    });
    const finish = (value: string | null): void => {
      list.destroy(); actionMenu.focus(); requestRender(); resolve(value);
    };
    list.focus(); list.select(0); requestRender();
    list.key(['enter'], () => {
      const idx = ((list as unknown as { selected?: number }).selected) ?? 0;
      const sel = list.getItem(idx);
      finish(sel ? sel.getText() : null);
    });
    list.key(['escape', 'q'], () => finish(null));
    list.on('cancel', () => finish(null));
  });
}

async function confirmTypedAction(promptLabel: string, phrase: string): Promise<boolean> {
  const confirm = await promptInput(`${promptLabel} Type "${phrase}" to confirm:`, '', true);
  return (confirm ?? '').trim() === phrase;
}

async function pickRemoteBranchWithSearch(title: string, limit = 250, context?: ActionExecutionContext): Promise<string | null> {
  const branches = await listGithubBranches(limit, undefined, undefined, githubContext.token, toBridgeCallOptions(context));
  if (branches.length === 0) { appendLog('No branches found from remote.'); return null; }
  const unique = Array.from(new Set(branches));
  const picked = await pickFromList(title, unique.slice(0, 200));
  return picked;
}

async function pickRemoteBranchSafe(title: string, limit = 250, context?: ActionExecutionContext): Promise<string | null> {
  try { return await pickRemoteBranchWithSearch(title, limit, context); }
  catch (e) { appendLog(`Branch search unavailable: ${toErrorMessage(e)}`); return null; }
}

/* ================================================================== */
/*  Bridge call helper                                                 */
/* ================================================================== */

function toBridgeCallOptions(context?: ActionExecutionContext): BridgeCallOptions {
  const options: BridgeCallOptions = {};
  if (context?.signal) options.signal = context.signal;
  return options;
}

/* ================================================================== */
/*  State persistence                                                  */
/* ================================================================== */

async function loadTuiState(): Promise<void> {
  try {
    const content = await readFile(TUI_STATE_PATH, 'utf-8');
    const parsed = parseJsonObject(content);
    if (!parsed) return;
    tuiState = {
      firstRunCompleted: typeof parsed.firstRunCompleted === 'boolean' ? parsed.firstRunCompleted : DEFAULT_TUI_STATE.firstRunCompleted,
      githubToken: typeof parsed.githubToken === 'string' ? parsed.githubToken : undefined,
      packageManager: typeof parsed.packageManager === 'string' && ['auto', 'brew', 'apt', 'dnf', 'pacman'].includes(parsed.packageManager)
        ? parsed.packageManager as InstallPackageManager : DEFAULT_TUI_STATE.packageManager,
      monitorSplitPercent: typeof parsed.monitorSplitPercent === 'number'
        ? clamp(parsed.monitorSplitPercent, MONITOR_SPLIT_MIN_PERCENT, MONITOR_SPLIT_MAX_PERCENT) : DEFAULT_TUI_STATE.monitorSplitPercent,
      monitorTopPercent: typeof parsed.monitorTopPercent === 'number'
        ? clamp(parsed.monitorTopPercent, MONITOR_TOP_MIN_PERCENT, MONITOR_TOP_MAX_PERCENT) : DEFAULT_TUI_STATE.monitorTopPercent,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[TUI] Failed to load state from ${TUI_STATE_PATH}: ${msg}\n`);
    tuiState = { ...DEFAULT_TUI_STATE };
  }
  githubContext.token = tuiState.githubToken || undefined;
  monitorSplitPercent = tuiState.monitorSplitPercent;
  monitorTopPercent = tuiState.monitorTopPercent;
}

async function saveTuiState(): Promise<void> {
  await mkdir(dirname(TUI_STATE_PATH), { recursive: true });
  const tmpPath = `${TUI_STATE_PATH}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(tuiState, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, TUI_STATE_PATH);
}

/* ================================================================== */
/*  Clipboard and export helpers                                       */
/* ================================================================== */

function tryClipboardCommand(command: string, args: string[], text: string): boolean {
  try {
    execFileSync(command, args, { input: text, encoding: 'utf-8', stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function copyActivityLogToClipboard(maxLines = ACTIVITY_LOG_COPY_DEFAULT_LINES): { ok: boolean; method?: string } {
  const text = getActivityLogText(maxLines);
  if (!text.trim()) return { ok: false };
  if (process.platform === 'darwin' && tryClipboardCommand('pbcopy', [], text)) return { ok: true, method: 'pbcopy' };
  if (tryClipboardCommand('wl-copy', [], text)) return { ok: true, method: 'wl-copy' };
  if (tryClipboardCommand('xclip', ['-selection', 'clipboard'], text)) return { ok: true, method: 'xclip' };
  if (tryClipboardCommand('xsel', ['--clipboard', '--input'], text)) return { ok: true, method: 'xsel' };
  return { ok: false };
}

async function exportActivityLogSnapshot(maxLines = 0): Promise<string> {
  await mkdir(ACTIVITY_LOG_DIR, { recursive: true });
  const logPath = join(ACTIVITY_LOG_DIR, `tui-activity-${timestampForFileName()}.log`);
  await writeFile(logPath, getActivityLogText(maxLines), 'utf-8');
  return logPath;
}

async function copyActivityLogFlow(maxLines = ACTIVITY_LOG_COPY_DEFAULT_LINES): Promise<void> {
  const copied = copyActivityLogToClipboard(maxLines);
  if (copied.ok) { appendLog(`Activity log copied to clipboard via ${copied.method}.`); return; }
  const snapshotPath = await exportActivityLogSnapshot(maxLines);
  appendLog(`Clipboard unavailable. Activity log exported to ${snapshotPath}`);
}

/* ================================================================== */
/*  Docker action helpers                                              */
/* ================================================================== */

async function runDockerAction(action: DockerMaintenanceAction, label: string, context?: ActionExecutionContext): Promise<void> {
  appendLog(`Running ${label}...`);
  const output = await runDockerMaintenance(action, toBridgeCallOptions(context));
  presentActionOutput(label, output || `${label} completed.`);
}

/* ================================================================== */
/*  Runbook quick fixes                                                */
/* ================================================================== */

async function runRunbookStuckQueue(context?: ActionExecutionContext): Promise<void> {
  const selected = getSelectedInstanceFromTable();
  const prefix = selected?.prefix ?? await promptInput('Queue runbook instance prefix:', '', false);
  if (!prefix) { appendLog('Runbook cancelled.'); return; }
  appendLog(`[Runbook] Stuck queue recovery for ${prefix} started.`);
  const options = toBridgeCallOptions(context);
  const outputs: string[] = [`Quick Fix: Stuck Queue Recovery (${prefix})`, ''];
  outputs.push('== queue:restart ==', await runLaravelControl({ prefix, artisanCommand: 'queue:restart' }, options), '');
  outputs.push('== optimize:clear ==', await runLaravelControl({ prefix, artisanCommand: 'optimize:clear' }, options), '');
  const services = uniqueServices([`${prefix}-app`, ...getInstanceWorkerServices(prefix)]);
  outputs.push(`== restart services (${services.join(', ') || `${prefix}-app`}) ==`, await runDockerRestartServices(services, options), '');
  outputs.push('== post-check doctor ==', await runSystemDoctor(false, options));
  presentActionOutput('Quick Fix: Recover Stuck Queue', outputs.join('\n'));
  appendLog(`[Runbook] Stuck queue recovery completed.`);
}

async function runRunbookServiceUnhealthy(context?: ActionExecutionContext): Promise<void> {
  const serviceOptions = latestDockerStatus?.services.map(e => e.name).filter(Boolean) ?? [];
  const pickedService = serviceOptions.length > 0 ? await pickFromList('Quick Fix: Pick Unhealthy Service', serviceOptions) : null;
  const serviceRaw = pickedService ?? await promptInput('Service name (docker compose):', '', false);
  const service = serviceRaw ? sanitizeDockerServiceName(serviceRaw) : null;
  if (!service) { appendLog('Runbook cancelled.'); return; }
  appendLog(`[Runbook] Unhealthy service triage for ${service} started.`);
  const options = toBridgeCallOptions(context);
  const outputs: string[] = [`Quick Fix: Service Unhealthy (${service})`, ''];
  outputs.push('== recent logs ==', await runDockerLogs(service, 220, true, options), '');
  outputs.push('== restart service ==', await runDockerRestartServices([service], options), '');
  outputs.push('== compose ps ==', await runDockerMaintenance('compose_ps', options));
  presentActionOutput('Quick Fix: Unhealthy Service', outputs.join('\n'));
  appendLog(`[Runbook] Service unhealthy triage completed.`);
}

async function runRunbookBuildFailure(context?: ActionExecutionContext): Promise<void> {
  const failedBranch = await pickRemoteBranchSafe('Quick Fix: Failed Branch', 250, context) ?? await promptInput('Failed branch name:', '', false);
  if (!failedBranch) { appendLog('Runbook cancelled.'); return; }
  const baseBranch = await pickRemoteBranchSafe('Quick Fix: Compare Against', 250, context) ?? await promptInput('Compare base branch:', 'main', false);
  if (!baseBranch) { appendLog('Runbook cancelled.'); return; }
  appendLog(`[Runbook] Build failure triage for ${failedBranch} started.`);
  const options = toBridgeCallOptions(context);
  const outputs: string[] = [`Quick Fix: Branch Build Failure (${failedBranch})`, ''];
  outputs.push('== branch compare ==', await compareGithubBranches({ base: baseBranch, head: failedBranch, token: githubContext.token }, options), '');
  outputs.push('== environment doctor ==', await runSystemDoctor(false, options));
  presentActionOutput('Quick Fix: Build Failure Triage', outputs.join('\n'));
  appendLog(`[Runbook] Build failure triage completed.`);
}

/* ================================================================== */
/*  System install flow                                                */
/* ================================================================== */

function isMacOsHost(): boolean { return process.platform === 'darwin'; }

function parseTargetInput(raw: string): string[] {
  const allowed = new Set(systemInstallAllTargets);
  return raw.split(',').map(v => v.trim()).filter(v => v.length > 0 && allowed.has(v));
}

async function runSystemInstallFlow(context?: ActionExecutionContext): Promise<void> {
  const options = [
    'Recommended: Missing Required Tooling',
    'Core Tooling (git,docker,mkcert,make,claude,codex)',
    'Custom Targets (comma-separated)',
  ];
  if (isMacOsHost()) options.push('macOS: Full Terminal Suite');
  const pick = await pickFromList('Install Target Set', options);
  if (!pick) return;

  let targets: string[] | undefined;
  if (pick === 'Recommended: Missing Required Tooling') {
    const doc = await runSystemDoctor(false, toBridgeCallOptions(context));
    targets = extractInstallableMissingTargets(doc);
    if (targets.length === 0) { appendLog('No missing required tooling detected by System Doctor.'); return; }
  } else if (pick === 'Core Tooling (git,docker,mkcert,make,claude,codex)') {
    targets = ['git', 'docker', 'mkcert', 'make', 'claude', 'codex'];
  } else if (pick === 'Custom Targets (comma-separated)') {
    const raw = await promptInput(`Targets (comma separated): ${systemInstallAllTargets.join(',')}`, '', true);
    if (!raw) { appendLog('Install target selection cancelled.'); return; }
    targets = parseTargetInput(raw);
    if (targets.length === 0) { appendLog('No valid targets selected.'); return; }
  } else if (pick === 'macOS: Full Terminal Suite') {
    targets = [...macTerminalSuiteTargets];
  }

  const managerChoices: InstallPackageManager[] = isMacOsHost() ? ['auto', 'brew'] : ['auto', 'brew', 'apt', 'dnf', 'pacman'];
  const managerChoice = await pickFromList('Package Manager', managerChoices);
  const packageManager = (managerChoice ?? tuiState.packageManager) as InstallPackageManager;
  tuiState.packageManager = packageManager;
  await saveTuiState();

  appendLog(`Running installer tasks (${targets ? targets.join(', ') : 'defaults'})...`);
  presentActionOutput('System Install', await runSystemInstall(targets, packageManager, toBridgeCallOptions(context)));
}

/* ================================================================== */
/*  Action search and queue controls                                   */
/* ================================================================== */

async function openActionSearch(): Promise<void> {
  const query = await promptInput('Search actions:', '', false);
  if (!query) return;
  const allLabels = actions.map(a => a.label);
  const matched = fuzzyMatchActions(query, allLabels);
  if (matched.length === 0) { appendLog(`No actions matching "${query}".`); return; }
  const picked = await pickFromList(`Results for "${query}"`, matched);
  if (!picked) return;
  const action = actions.find(a => a.label === picked);
  if (action) runManagedAction(action);
}

async function openQueueControls(): Promise<void> {
  const choice = await pickFromList('Queue Controls', [
    'Cancel Running Job',
    'Clear Finished',
    'View Job Log',
  ]);
  if (!choice) return;
  if (choice === 'Cancel Running Job') { if (!cancelRunningJob()) appendLog('No running job to cancel.'); }
  else if (choice === 'Clear Finished') { const c = clearFinishedJobs(); appendLog(c > 0 ? `Cleared ${c} finished jobs.` : 'No finished jobs to clear.'); }
  else if (choice === 'View Job Log') {
    const candidates = actionJobs.filter(j => ['queued', 'running', 'success', 'failed', 'cancelled'].includes(j.status));
    if (candidates.length === 0) { appendLog('No jobs.'); return; }
    const labels = candidates.map(j => `#${String(j.id).padStart(3, '0')} [${j.status}] ${j.action.label}`);
    const picked = await pickFromList('View Job Log', labels);
    if (!picked) return;
    const idx = labels.indexOf(picked);
    const job = candidates[idx];
    if (job) {
      setResultContent(`Job #${String(job.id).padStart(3, '0')} Log`, job.logLines.length > 0 ? job.logLines.join('\n') : '(no log lines)');
      setActivityTab('result');
    }
  }
}

/* ================================================================== */
/*  Section controls                                                   */
/* ================================================================== */

function getActionsForCategory(key: ActionCategoryKey): ActionEntry[] {
  return actions.filter(e => e.category === key);
}

function getMaintenanceActionsForCategory(key: ActionCategoryKey): ActionEntry[] {
  return actions.filter(e => e.category === key && e.kind === 'maintenance');
}

function logSectionMetrics(key: ActionCategoryKey): void {
  const stats = sectionRuntimeStats[key];
  const maint = getMaintenanceActionsForCategory(key).length;
  const total = getActionsForCategory(key).length;
  const avg = stats.runs > 0 ? stats.totalDurationMs / stats.runs : 0;
  appendLog(`[${getCategoryDisplayName(key)}] actions=${total} maintenance=${maint} runs=${stats.runs} success=${stats.success} failed=${stats.failed} avg=${formatDurationMs(avg)} last=${stats.lastResult ?? '-'}`);
}

async function runSectionMaintenance(key: ActionCategoryKey, context?: ActionExecutionContext): Promise<void> {
  const maint = getMaintenanceActionsForCategory(key);
  if (maint.length === 0) { appendLog(`[${getCategoryDisplayName(key)}] no maintenance actions configured.`); return; }
  appendLog(`[${getCategoryDisplayName(key)}] running ${maint.length} maintenance actions...`);
  for (const action of maint) {
    if (isActiveJobCancellationRequested()) { appendLog(`[${getCategoryDisplayName(key)}] maintenance cancelled.`); return; }
    appendLog(`  -> ${action.label}`);
    await action.run(context);
  }
}

async function openSectionControls(key: ActionCategoryKey): Promise<void> {
  if (isBusy) { appendLog(`Cannot open section controls while running: ${currentTaskLabel ?? 'unknown task'}`); return; }
  const choice = await pickFromList(`${getCategoryDisplayName(key)} Controls`, [
    'Run Section Maintenance', 'View Section Metrics', 'Run Specific Action',
  ]);
  if (!choice) return;
  if (choice === 'View Section Metrics') { logSectionMetrics(key); return; }
  if (choice === 'Run Section Maintenance') {
    runManagedAction({ category: key, kind: 'maintenance', label: `${getCategoryDisplayName(key)}: Run Section Maintenance`, run: async (ctx) => runSectionMaintenance(key, ctx) });
    return;
  }
  const sectionActions = getActionsForCategory(key);
  if (sectionActions.length === 0) { appendLog(`[${getCategoryDisplayName(key)}] no actions available.`); return; }
  const picked = await pickFromList(`${getCategoryDisplayName(key)} Actions`, sectionActions.map(e => `[${e.kind}] ${e.label}`));
  if (!picked) return;
  const normalized = picked.replace(/^\[(control|maintenance)\]\s*/i, '').trim();
  const action = sectionActions.find(e => e.label === normalized);
  if (!action) { appendLog(`Action not found: ${normalized}`); return; }
  runManagedAction(action);
}

/* ================================================================== */
/*  Action definitions                                                 */
/* ================================================================== */

const actions: ActionEntry[] = [
  // -- Dashboard --
  { category: 'dashboard', kind: 'control', label: 'Refresh Dashboard', run: async () => { await refreshDashboard(); appendLog('Dashboard refreshed.'); } },
  { category: 'dashboard', kind: 'control', label: 'Activity Log: Copy to Clipboard', run: async () => { await copyActivityLogFlow(); } },
  { category: 'dashboard', kind: 'control', label: 'Activity Log: Export Snapshot', run: async () => { const p = await exportActivityLogSnapshot(); appendLog(`Activity log exported to ${p}`); } },
  {
    category: 'dashboard', kind: 'control', label: 'Disk Usage: Per Instance', bypassQueue: true,
    run: async () => {
      appendLog('Collecting per-instance disk usage...');
      const instances = displayedInstances;
      const lines: string[] = ['{bold}Disk Usage Per Instance{/bold}', ''];
      let totalMb = 0;
      for (const inst of instances) {
        if (!inst.prefix) continue;
        const dirPath = `${BASE_DIR}/${inst.prefix}`;
        try {
          const result = await execFileAsync('du', ['-sm', dirPath], { timeout: 30000 });
          const mb = parseInt(result.stdout.trim().split(/\s+/)[0] || '0', 10);
          const tag = inst.status === 'running' ? '{green-fg}UP{/green-fg}' : '{red-fg}DN{/red-fg}';
          totalMb += mb;
          lines.push(`${tag} ${inst.prefix.padEnd(16)} ${String(mb).padStart(6)}MB  ${truncate(inst.branch, 30)}`);
        } catch { lines.push(`{gray-fg}?{/gray-fg}  ${inst.prefix.padEnd(16)}     ?MB  ${truncate(inst.branch, 30)}`); }
      }
      lines.push('', `Total: ${totalMb}MB across ${instances.length} instances`);
      setResultContent('Disk Usage', lines.join('\n'));
      setActivityTab('result');
    },
  },

  // -- Setup --
  { category: 'setup', kind: 'maintenance', label: 'Setup Wizard: First-Run Onboarding', run: async (ctx) => { await runFirstRunWizard(true, ctx); } },
  {
    category: 'setup', kind: 'maintenance', label: 'System Doctor: Check Prerequisites',
    run: async (ctx) => {
      const includeCompose = await promptInput('Include docker compose service snapshot? (Y/n):', 'y', true);
      presentActionOutput('System Doctor', await runSystemDoctor(!includeCompose || yesNoFromInput(includeCompose), toBridgeCallOptions(ctx)));
    },
  },
  { category: 'setup', kind: 'maintenance', label: 'System Install: Missing Tooling', run: async (ctx) => { await runSystemInstallFlow(ctx); } },
  {
    category: 'setup', kind: 'maintenance', label: 'Project Bootstrap: Bring Up Stack',
    run: async (ctx) => {
      const mode = (await pickFromList('Bootstrap Mode', ['up', 'install', 'fresh']) ?? 'up') as ProjectBootstrapMode;
      appendLog(`Running project bootstrap mode: ${mode}`);
      presentActionOutput('Project Bootstrap', await runProjectBootstrap(mode, toBridgeCallOptions(ctx)));
    },
  },
  { category: 'setup', kind: 'control', label: 'Quick Fix: Recover Stuck Queue', run: async (ctx) => { await runRunbookStuckQueue(ctx); } },
  { category: 'setup', kind: 'control', label: 'Quick Fix: Triage Unhealthy Service', run: async (ctx) => { await runRunbookServiceUnhealthy(ctx); } },
  { category: 'setup', kind: 'control', label: 'Quick Fix: Triage Branch Build Failure', run: async (ctx) => { await runRunbookBuildFailure(ctx); } },

  // -- Docker --
  { category: 'docker', kind: 'maintenance', label: 'Docker Maintenance: Compose Up', run: async (ctx) => runDockerAction('compose_up', 'docker compose up -d', ctx) },
  { category: 'docker', kind: 'maintenance', label: 'Docker Maintenance: Compose Down', run: async (ctx) => runDockerAction('compose_down', 'docker compose down', ctx) },
  { category: 'docker', kind: 'maintenance', label: 'Docker Maintenance: Compose PS', run: async (ctx) => runDockerAction('compose_ps', 'docker compose ps', ctx) },
  { category: 'docker', kind: 'maintenance', label: 'Docker Maintenance: Recreate Caddy', run: async (ctx) => runDockerAction('restart_caddy', 'docker compose up -d caddy', ctx) },
  {
    category: 'docker', kind: 'maintenance', label: 'Docker Maintenance: System Prune',
    run: async (ctx) => {
      const confirmed = await confirmTypedAction('Docker system prune is destructive.', 'prune');
      if (!confirmed) { appendLog('Docker system prune cancelled.'); return; }
      await runDockerAction('system_prune', 'docker system prune', ctx);
    },
  },
  {
    category: 'docker', kind: 'maintenance', label: 'Bulk Restart: All App Containers',
    run: async (ctx) => {
      const running = displayedInstances.filter(i => i.status === 'running');
      if (running.length === 0) { appendLog('No running instances to restart.'); return; }
      const confirm = await promptInput(`Restart ${running.length} app containers? (y/N):`, 'n', true);
      if (!parseYesNoWithDefault(confirm, false)) { appendLog('Bulk restart cancelled.'); return; }
      const services = running.map(i => `${i.prefix}-app`);
      appendLog(`Restarting ${services.length} app containers...`);
      presentActionOutput('Bulk Restart', await runDockerRestartServices(services, toBridgeCallOptions(ctx)));
    },
  },

  // -- GitHub --
  {
    category: 'github', kind: 'control', label: 'GitHub Context: Configure Token',
    run: async () => {
      const token = await promptInput('GitHub token override (optional; blank uses gh auth token or env):', githubContext.token ?? tuiState.githubToken ?? '', true);
      githubContext.token = token || undefined;
      tuiState.githubToken = githubContext.token;
      await saveTuiState();
      appendLog('GitHub context updated.');
    },
  },
  {
    category: 'github', kind: 'control', label: 'GitHub Branches: List',
    run: async (ctx) => {
      const limitText = await promptInput('Branch limit (default 20):', '20', true);
      const limit = Math.max(1, parseInt(limitText ?? '20', 10) || 20);
      const branches = await listGithubBranches(limit, undefined, undefined, githubContext.token, toBridgeCallOptions(ctx));
      presentActionOutput('GitHub Branches: List', `Fetched ${branches.length} branches:\n${branches.join('\n')}`);
    },
  },
  {
    category: 'github', kind: 'control', label: 'GitHub Branches: Create',
    run: async (ctx) => {
      const name = await promptInput('New branch name:');
      if (!name) { appendLog('Branch creation cancelled.'); return; }
      const base = await pickRemoteBranchSafe('Pick Source Branch', 250, ctx) ?? await promptInput('Base/source branch:', 'main', false);
      if (!base) { appendLog('Branch creation cancelled.'); return; }
      presentActionOutput('GitHub Branches: Create', await createGithubBranch({ name, base, token: githubContext.token }, toBridgeCallOptions(ctx)));
    },
  },
  {
    category: 'github', kind: 'control', label: 'Release Cockpit: Compare Branches',
    run: async (ctx) => {
      const base = await pickRemoteBranchSafe('Base Branch', 250, ctx) ?? await promptInput('Base branch:', 'main', false);
      if (!base) { appendLog('Compare cancelled.'); return; }
      const head = await pickRemoteBranchSafe('Head Branch', 250, ctx) ?? await promptInput('Head branch:', '', false);
      if (!head) { appendLog('Compare cancelled.'); return; }
      presentActionOutput('Branch Compare', await compareGithubBranches({ base, head, token: githubContext.token }, toBridgeCallOptions(ctx)));
    },
  },
  {
    category: 'github', kind: 'control', label: 'Release Cockpit: Promote Branch (Create PR)',
    run: async (ctx) => {
      const head = await pickRemoteBranchSafe('Head Branch (to merge)', 250, ctx) ?? await promptInput('Head branch:', '', false);
      if (!head) { appendLog('Promote cancelled.'); return; }
      const base = await pickRemoteBranchSafe('Base Branch (target)', 250, ctx) ?? await promptInput('Base branch:', 'main', false);
      if (!base) { appendLog('Promote cancelled.'); return; }
      const title = await promptInput('PR title:', `Merge ${head} into ${base}`, false);
      if (!title) { appendLog('Promote cancelled.'); return; }
      const body = await promptInput('PR body (optional):', '', true);
      const draftAns = await promptInput('Create as draft? (y/N):', 'n', true);
      const confirmed = await confirmTypedAction('Creating a pull request requires confirmation.', 'create pr');
      if (!confirmed) { appendLog('PR creation cancelled.'); return; }
      presentActionOutput('Create PR', await createGithubPullRequest({ base, head, title, body: body || undefined, draft: yesNoFromInput(draftAns), token: githubContext.token }, toBridgeCallOptions(ctx)));
    },
  },

  // -- Build --
  {
    category: 'build', kind: 'control', label: 'Build Project From Branch',
    run: async (ctx) => {
      const branch = await pickRemoteBranchSafe('Pick Branch To Build', 250, ctx) ?? await promptInput('Branch to build:', '', false);
      if (!branch) { appendLog('Build cancelled.'); return; }
      const name = await promptInput('Instance prefix/name (optional):', '', true);
      const displayName = await promptInput('Display name (optional):', '', true);
      const timezone = await promptInput('Timezone (optional):', '', true);
      const dbSeed = (await promptInput('DB seed source (default/none):', 'default', true) ?? '').trim() || 'default';
      presentActionOutput('Build Project From Branch', await buildProjectFromBranch({
        branch, name: name || undefined, displayName: displayName || undefined,
        timezone: timezone || undefined, dbSeed: dbSeed || undefined, token: githubContext.token,
      }, toBridgeCallOptions(ctx)));
    },
  },

  // -- Laravel --
  { category: 'laravel', kind: 'control', label: 'Instance Power: Quick Controls', run: async (ctx) => { await openInstanceQuickControls(ctx); } },
  {
    category: 'laravel', kind: 'control', label: 'Jobs: Manage Queue', bypassQueue: true,
    run: async () => {
      const choice = await pickFromList('Jobs Queue', ['View Summary', 'Request Cancel Running Job', 'Clear Finished Jobs']);
      if (!choice) return;
      if (choice === 'View Summary') {
        renderJobsPanel();
        const q = actionJobs.filter(j => j.status === 'queued').length;
        const r = actionJobs.filter(j => j.status === 'running').length;
        const s = actionJobs.filter(j => j.status === 'success').length;
        const f = actionJobs.filter(j => j.status === 'failed').length;
        appendLog(`Jobs summary: queued=${q} running=${r} success=${s} failed=${f}`);
      } else if (choice === 'Request Cancel Running Job') {
        if (!cancelRunningJob()) appendLog('No running job to cancel.');
      } else { const c = clearFinishedJobs(); appendLog(`Cleared ${c} finished jobs.`); }
    },
  },
  {
    category: 'laravel', kind: 'control', label: 'View Logs',
    run: async (ctx) => {
      const instance = await promptInput('Instance prefix (or empty for audit):');
      const sourceAns = await promptInput('Source (laravel/docker/audit):', 'laravel', true);
      const source = (['laravel', 'docker', 'audit'] as const).includes(sourceAns as 'laravel' | 'docker' | 'audit') ? (sourceAns as 'laravel' | 'docker' | 'audit') : 'laravel';
      const filterAns = await promptInput('Filter (optional):', '', true);
      const linesAns = await promptInput('Lines (default 100):', '100', true);
      const lines = parseInt(linesAns || '100', 10) || 100;
      appendLog(`Fetching ${source} logs${instance ? ` for ${instance}` : ''}...`);
      presentActionOutput('View Logs', await viewLogsPassthrough({ instance: instance || undefined, source, lines, filter: filterAns || undefined }, toBridgeCallOptions(ctx)));
    },
  },
  {
    category: 'laravel', kind: 'control', label: 'Instance Health Check',
    run: async (ctx) => {
      const instance = await promptInput('Instance prefix:');
      if (!instance) { appendLog('Health check cancelled.'); return; }
      appendLog(`Running health check on ${instance}...`);
      presentActionOutput('Instance Health', await instanceHealthPassthrough(instance, toBridgeCallOptions(ctx)));
    },
  },
  {
    category: 'laravel', kind: 'control', label: 'Run Artisan Command',
    run: async (ctx) => {
      const instance = await promptInput('Instance prefix:');
      if (!instance) { appendLog('Artisan command cancelled.'); return; }
      const command = await promptInput('Artisan command (e.g. migrate:status):');
      if (!command) { appendLog('Artisan command cancelled.'); return; }
      appendLog(`Running artisan ${command} on ${instance}...`);
      presentActionOutput('Artisan Command', await runArtisanPassthrough({ instance, command }, toBridgeCallOptions(ctx)));
    },
  },

  // -- MCP --
  { category: 'mcp', kind: 'control', label: 'MCP Passthrough: List Instances', run: async (ctx) => { presentActionOutput('MCP: List Instances', await mcpListInstancesPassthrough(toBridgeCallOptions(ctx))); } },
  {
    category: 'mcp', kind: 'control', label: 'MCP Passthrough: Create Instance',
    run: async (ctx) => {
      const branch = await pickRemoteBranchSafe('Pick Branch For Instance', 250, ctx) ?? await promptInput('Branch:', '', false);
      if (!branch) { appendLog('Create instance cancelled.'); return; }
      const name = await promptInput('Instance name/prefix (optional):', '', true);
      const displayName = await promptInput('Display name (optional):', '', true);
      const timezone = await promptInput('Timezone (optional):', '', true);
      const dbSeed = (await promptInput('DB seed source (default/none):', 'default', true) ?? '').trim() || 'default';
      const payload: CreateInstanceInput = { branch };
      if (name) payload.name = name;
      if (displayName) payload.display_name = displayName;
      if (timezone) payload.timezone = timezone;
      if (dbSeed) payload.db_seed = dbSeed;
      appendLog(`Submitting create_instance for branch ${branch}...`);
      presentActionOutput('MCP: Create Instance', await mcpCreateInstancePassthrough(payload, toBridgeCallOptions(ctx)));
    },
  },
  {
    category: 'mcp', kind: 'control', label: 'MCP Passthrough: Remove Instance',
    run: async (ctx) => {
      const name = await promptInput('Instance prefix to remove:');
      if (!name) { appendLog('Remove instance cancelled.'); return; }
      const confirmed = await confirmTypedAction('Instance removal is destructive.', `remove ${name}`);
      if (!confirmed) { appendLog('Remove instance cancelled.'); return; }
      const keepDb = await promptInput('Keep database? (y/N):', 'n', true);
      const keepFiles = await promptInput('Keep files? (y/N):', 'n', true);
      appendLog(`Submitting remove_instance for ${name}...`);
      presentActionOutput('MCP: Remove Instance', await mcpRemoveInstancePassthrough({ name, keep_database: yesNoFromInput(keepDb), keep_files: yesNoFromInput(keepFiles) }, toBridgeCallOptions(ctx)));
    },
  },

  // -- Backup --
  {
    category: 'backup', kind: 'control', label: 'Backup: Create Backup',
    run: async (ctx) => {
      const label = await promptInput('Backup label (optional):', '', true);
      appendLog('Creating backup...');
      presentActionOutput('Backup: Create', await backupCreatePassthrough({ name: label || undefined }, toBridgeCallOptions(ctx)));
    },
  },
  { category: 'backup', kind: 'control', label: 'Backup: List Backups', run: async (ctx) => { presentActionOutput('Backup: List', await backupListPassthrough(toBridgeCallOptions(ctx))); } },
  {
    category: 'backup', kind: 'control', label: 'Backup: Restore From Backup',
    run: async (ctx) => {
      const backupId = await promptInput('Backup ID (or "latest"):');
      if (!backupId) { appendLog('Restore cancelled.'); return; }
      const confirmed = await confirmTypedAction('Restoring a backup will stop services and overwrite data.', `restore ${backupId}`);
      if (!confirmed) { appendLog('Restore cancelled.'); return; }
      const restoreDb = await promptInput('Restore databases? (Y/n):', 'y', true);
      const restoreFiles = await promptInput('Restore files? (Y/n):', 'y', true);
      appendLog(`Restoring from backup ${backupId}...`);
      presentActionOutput('Backup: Restore', await backupRestorePassthrough({
        backup_id: backupId, restore_databases: restoreDb?.toLowerCase() !== 'n', restore_files: restoreFiles?.toLowerCase() !== 'n',
      }, toBridgeCallOptions(ctx)));
    },
  },
];

let actionMenuEntries = buildActionMenuEntries(actions);

/* ================================================================== */
/*  Bootstrap + keybindings                                            */
/* ================================================================== */

async function runAction(menuIndex: number): Promise<void> {
  const entry = actionMenuEntries[menuIndex];
  if (!entry) return;
  if (entry.kind === 'category') { await openSectionControls(entry.category); return; }
  if (!entry.action) { appendLog('Select an action item to run it.'); return; }
  const action = entry.action;
  if (action.bypassQueue) {
    void (async () => {
      try { await action.run(); } catch (e) { appendLog(`ERROR: ${toErrorMessage(e)}`); }
      finally { renderJobsPanel(); requestRender(); }
    })();
    return;
  }
  runManagedAction(action);
}

function quit(): void { screen.destroy(); process.exit(0); }

async function bootstrap(): Promise<void> {
  await loadTuiState();
  applyMonitorLayout();

  actionMenuEntries = buildActionMenuEntries(actions);
  const firstActionIndex = actionMenuEntries.findIndex(e => e.kind === 'action');
  actionMenu.select(firstActionIndex >= 0 ? firstActionIndex : 0);
  actionMenu.focus();
  setResultContent('Activity Result', 'Run an action to see structured output here.');
  renderJobsPanel();
  renderInstancePowerPanel();
  updateMonitorPanel();
  setActivityTab('log');

  try { await runStartupSplashScreen(); } catch { /* splash failure is non-fatal */ }

  // Action menu events
  actionMenu.on('select', (_item, selected) => { void runAction(selected); });
  actionMenu.key(['up', 'k'], () => { setTimeout(() => { ensureSelectableActionMenuIndex(-1, actionMenuEntries); requestRender(); }, 0); });
  actionMenu.key(['down', 'j'], () => { setTimeout(() => { ensureSelectableActionMenuIndex(1, actionMenuEntries); requestRender(); }, 0); });
  actionMenu.key(['tab'], () => { jumpToNextActionCategory(actionMenuEntries); requestRender(); });
  actionMenu.key(['s'], () => { const cat = getSelectedCategoryKey(actionMenuEntries); if (cat) void openSectionControls(cat); });

  // Instance panel events
  instancesPanel.key(['up', 'down', 'j', 'k'], () => { setTimeout(() => { renderInstancePowerPanel(); requestRender(); }, 0); });
  instancesPanel.on('select', () => { renderInstancePowerPanel(); requestRender(); });

  // Activity tab hotkeys
  screen.key([']'], () => { if (canHandleActivityTabHotkeys()) cycleActivityTab(1); });
  screen.key(['['], () => { if (canHandleActivityTabHotkeys()) cycleActivityTab(-1); });
  screen.key(['1'], () => { if (canHandleActivityTabHotkeys()) setActivityTab('log'); });
  screen.key(['2'], () => { if (canHandleActivityTabHotkeys()) setActivityTab('result'); });
  screen.key(['3'], () => { if (canHandleActivityTabHotkeys()) setActivityTab('monitor'); });

  // Feature hotkeys
  screen.key(['i'], () => { runManagedAction({ category: 'laravel', kind: 'control', label: 'Instance Power: Quick Controls', run: async (ctx) => openInstanceQuickControls(ctx) }); });
  screen.key(['/'], () => { void runAIOpsCommandPalette().catch(e => appendLog(`AI Ops palette failed: ${toErrorMessage(e)}`)); });
  screen.key(['j'], () => { void openQueueControls().catch(e => appendLog(`Queue controls failed: ${toErrorMessage(e)}`)); });
  screen.key(['?'], () => { void openActionSearch().catch(e => appendLog(`Action search failed: ${toErrorMessage(e)}`)); });

  // Global hotkeys
  screen.key(['q', 'C-c'], () => quit());
  screen.key(['r'], () => { void refreshDashboard().catch(e => appendLog(`Refresh failed: ${toErrorMessage(e)}`)); });
  screen.key(['y'], () => { void copyActivityLogFlow().catch(e => appendLog(`Copy log failed: ${toErrorMessage(e)}`)); });
  screen.key(['e'], () => {
    void (async () => { const p = await exportActivityLogSnapshot(); appendLog(`Activity log exported to ${p}`); })()
      .catch(e => appendLog(`Export log failed: ${toErrorMessage(e)}`));
  });

  appendLog('dev-machine TUI started.');
  appendLog('Actions are grouped by category. Use Tab for category cycling and 1-3 for Activity tabs.');
  appendLog('Hotkeys: / ai-ops, i instance-power, j queue, ? search, r refresh, q quit.');
  await refreshDashboard();
  await runFirstRunWizard(false);
  await refreshDashboard();

  // Periodic refresh
  const refreshInterval = setInterval(() => {
    if (isBusy || hasModalOrInputFocus()) return;
    void refreshDashboard().catch(e => appendLog(`Auto-refresh failed: ${toErrorMessage(e)}`));
  }, 45000);

  // Monitor timer
  monitorTimer = setInterval(() => {
    if (activeActivityTab !== 'monitor' || hasModalOrInputFocus()) return;
    updateMonitorPanel();
    requestRender();
  }, MONITOR_LIGHT_INTERVAL_MS);

  // Resize handler
  screen.on('resize', () => {
    applyMonitorLayout();
    if (activeActivityTab === 'monitor') updateMonitorPanel();
    requestRender();
  });

  // Cleanup on destroy
  screen.once('destroy', () => {
    clearInterval(refreshInterval);
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (tuiStateSaveTimer) { clearTimeout(tuiStateSaveTimer); tuiStateSaveTimer = null; }
    stopTaskProgress();
  });
}

/* ================================================================== */
/*  Entry point                                                        */
/* ================================================================== */

export async function startTui(): Promise<void> {
  await bootstrap();
}

// Imports are started by the CLI; direct execution starts once here.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startTui().catch(error => {
    appendLog(`Fatal startup error: ${toErrorMessage(error)}`);
    setFooterStatus('Fatal startup error. Press q to quit.');
    process.exitCode = 1;
  });
}

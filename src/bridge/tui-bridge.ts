import { getDashboardSnapshot, isRunningState, runTuiBridgeAction } from './index.js';
import type { TuiBridgeAction } from './index.js';
import type { CreateInstanceInput, RemoveInstanceInput } from '../config.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ */
/*  Shared types                                                       */
/* ------------------------------------------------------------------ */

export interface DockerServiceStatus {
  name: string;
  state: string;
  status: string;
  health: string;
  ports: string;
}

export interface DockerStatusDashboard {
  dockerCli: string;
  dockerEngine: string;
  composeValid: boolean;
  checkedAt: string;
  serviceCount: number;
  runningCount: number;
  services: DockerServiceStatus[];
  issues: string[];
}

export interface ProjectInstanceStatus {
  prefix: string;
  displayName: string;
  branch: string;
  directory: string;
  dbName: string;
  vitePort: number;
  timezone: string;
  url: string;
  status: 'running' | 'stopped';
}

export type DockerMaintenanceAction =
  | 'compose_up'
  | 'compose_down'
  | 'compose_ps'
  | 'restart_caddy'
  | 'system_prune';

export type ProjectBootstrapMode = 'up' | 'install' | 'fresh';

export interface BridgeCallOptions {
  signal?: AbortSignal;
  forceSubprocess?: boolean;
  killAfterMs?: number;
  workspaceDir?: string;
}

export interface GithubBranchCreateInput {
  name: string;
  base?: string;
  owner?: string;
  repo?: string;
  token?: string;
}

export interface GithubBranchCompareInput {
  base: string;
  head: string;
  owner?: string;
  repo?: string;
  token?: string;
}

export interface GithubCreatePullRequestInput {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
  owner?: string;
  repo?: string;
  token?: string;
}

export interface BuildProjectFromBranchInput {
  branch: string;
  sourceBranch?: string;
  createBranchFromSource?: boolean;
  name?: string;
  displayName?: string;
  timezone?: string;
  dbSeed?: string;
  dbDumpPath?: string;
  owner?: string;
  repo?: string;
  token?: string;
}

export interface LaravelControlInput {
  prefix: string;
  artisanCommand: string;
  timeoutMs?: number;
}

export interface CreateBackupInput {
  name?: string;
}

export interface RestoreBackupInput {
  backup_id: string;
  restore_databases?: boolean;
  restore_files?: boolean;
}

interface BridgeResponse {
  action: string;
  result: unknown;
}

/* ------------------------------------------------------------------ */
/*  Subprocess bridge                                                  */
/* ------------------------------------------------------------------ */

const ACTION_RUNNER_PATH = fileURLToPath(new URL('./action-runner.js', import.meta.url));

function serializePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function stringifyBridgeResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (typeof value.output === 'string') {
      return value.output;
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result ?? '');
}

function stringifyBridgeResponse(response: unknown): string {
  return stringifyBridgeResult(asBridgeResponse(response).result);
}

async function runTuiBridgeActionSubprocess(
  action: TuiBridgeAction,
  payloadJson?: string,
  options?: BridgeCallOptions,
): Promise<BridgeResponse> {
  const payloadEncoded = payloadJson ? Buffer.from(payloadJson, 'utf-8').toString('base64') : '';
  const workspaceDir = options?.workspaceDir?.trim();
  const childEnv = { ...process.env };
  if (workspaceDir) {
    childEnv.DEVMACHINE_BASE_DIR = workspaceDir;
  }
  const child = spawn(process.execPath, [ACTION_RUNNER_PATH, action, payloadEncoded], {
    cwd: workspaceDir || process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let aborted = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const terminateChild = (): void => {
    if (child.killed) {
      return;
    }
    aborted = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, options?.killAfterMs ?? 3000);
  };

  if (options?.signal?.aborted) {
    terminateChild();
  }
  const onAbort = (): void => {
    terminateChild();
  };
  options?.signal?.addEventListener('abort', onAbort, { once: true });

  return new Promise((resolve, reject) => {
    child.on('error', (error) => {
      options?.signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      options?.signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }

      if (aborted || options?.signal?.aborted) {
        reject(new Error(`Bridge action "${action}" cancelled.`));
        return;
      }

      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `process exited with code ${String(code)}${signal ? ` (${signal})` : ''}`;
        reject(new Error(`Bridge action "${action}" failed: ${details}`));
        return;
      }

      const raw = stdout.trim();
      if (!raw) {
        resolve({ action, result: '' });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(asBridgeResponse(parsed));
      } catch {
        resolve({ action, result: raw });
      }
    });
  });
}

async function callBridgeAction(
  action: TuiBridgeAction,
  payload: Record<string, unknown>,
  options?: BridgeCallOptions,
): Promise<BridgeResponse> {
  const payloadJson = serializePayload(payload);
  if (options?.signal || options?.forceSubprocess || Boolean(options?.workspaceDir)) {
    return runTuiBridgeActionSubprocess(action, payloadJson, options);
  }
  const response = await runTuiBridgeAction(action, payloadJson);
  return asBridgeResponse(response);
}

function toLaravelPayload(command: string): { command: string; custom_command?: string } {
  const normalized = command.trim().replace(/\s+/g, ' ');
  switch (normalized) {
    case 'migrate':
    case 'migrate --force':
      return { command: 'migrate' };
    case 'test':
      return { command: 'test' };
    case 'optimize':
      return { command: 'optimize' };
    case 'optimize:clear':
    case 'optimize_clear':
      return { command: 'optimize_clear' };
    case 'queue:restart':
    case 'queue_restart':
      return { command: 'queue_restart' };
    default: {
      const custom = normalized.startsWith('php artisan ')
        ? normalized
        : `php artisan ${normalized}`;
      return { command: 'custom', custom_command: custom };
    }
  }
}

function asBridgeResponse(value: unknown): BridgeResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { action: 'unknown', result: value };
  }
  const row = value as Record<string, unknown>;
  return {
    action: typeof row.action === 'string' ? row.action : 'unknown',
    result: row.result,
  };
}

function parseBranchNames(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [];
  }
  const row = result as Record<string, unknown>;
  if (!Array.isArray(row.branches)) {
    return [];
  }
  return row.branches
    .map((branch) => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
        return '';
      }
      const b = branch as Record<string, unknown>;
      return typeof b.name === 'string' ? b.name : '';
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  Public TUI bridge functions                                        */
/* ------------------------------------------------------------------ */

export async function getDockerStatusDashboard(options?: BridgeCallOptions): Promise<DockerStatusDashboard> {
  if (options?.workspaceDir) {
    const response = await callBridgeAction('system_doctor', { include_compose_ps: true }, options);
    const bridge = asBridgeResponse(response).result as Record<string, unknown>;
    const project = bridge?.project as Record<string, unknown> | undefined;
    const servicesRaw = Array.isArray(project?.services) ? project?.services : [];
    const services = servicesRaw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .map((service) => ({
        name: String(service.service ?? service.name ?? ''),
        state: String(service.state ?? ''),
        status: String(service.status ?? service.state ?? ''),
        health: String(service.health ?? 'n/a'),
        ports: '',
      }));
    const runningCount = services.filter((service) => isRunningState(service.state) || isRunningState(service.status)).length;
    return {
      dockerCli: 'docker compose',
      dockerEngine: 'runtime',
      composeValid: project?.compose_valid === true,
      checkedAt: String(bridge.checked_at ?? new Date().toISOString()),
      serviceCount: services.length,
      runningCount,
      services,
      issues: [],
    };
  }

  const snapshot = await getDashboardSnapshot();
  const services = snapshot.docker.services.map((service) => ({
    name: service.service || service.name,
    state: service.state,
    status: service.status ?? service.state,
    health: service.health ?? 'n/a',
    ports: service.publishers
      .map((publisher) => {
        const target = publisher.target_port ?? 0;
        const published = publisher.published_port ?? 0;
        if (!published) {
          return '';
        }
        return `${published}->${target}/${publisher.protocol ?? 'tcp'}`;
      })
      .filter(Boolean)
      .join(', '),
  }));

  const runningCount = services.filter((service) => isRunningState(service.state) || isRunningState(service.status)).length;

  return {
    dockerCli: 'docker compose',
    dockerEngine: 'runtime',
    composeValid: !snapshot.docker.error,
    checkedAt: snapshot.generated_at,
    serviceCount: services.length,
    runningCount,
    services,
    issues: snapshot.docker.error ? [snapshot.docker.error] : [],
  };
}

export async function getProjectInstanceStatus(options?: BridgeCallOptions): Promise<ProjectInstanceStatus[]> {
  if (options?.workspaceDir) {
    const response = await callBridgeAction('mcp_list_instances', {}, options);
    const bridge = asBridgeResponse(response).result as Record<string, unknown>;
    const output = typeof bridge?.output === 'string' ? bridge.output : '';
    let parsed: unknown = null;
    try {
      parsed = output ? JSON.parse(output) : [];
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .map((instance) => ({
        prefix: String(instance.prefix ?? ''),
        displayName: String(instance.name ?? instance.display_name ?? ''),
        branch: String(instance.branch ?? ''),
        directory: '',
        dbName: String(instance.db ?? instance.db_name ?? ''),
        vitePort: Number(instance.vite_port ?? 0) || 0,
        timezone: String(instance.timezone ?? ''),
        url: String(instance.url ?? ''),
        status: String(instance.status ?? '').toLowerCase() === 'running' ? 'running' : 'stopped',
      }));
  }

  const snapshot = await getDashboardSnapshot();
  return snapshot.registry.instances.map((instance) => ({
    prefix: instance.prefix,
    displayName: instance.display_name,
    branch: instance.branch,
    directory: instance.directory,
    dbName: instance.db_name,
    vitePort: instance.vite_port,
    timezone: instance.timezone,
    url: instance.url,
    status: instance.running ? 'running' : 'stopped',
  }));
}

export async function runDockerMaintenance(action: DockerMaintenanceAction, options?: BridgeCallOptions): Promise<string> {
  const mapping: Record<DockerMaintenanceAction, { action: TuiBridgeAction; payload: Record<string, unknown> }> = {
    compose_up: { action: 'docker_up', payload: {} },
    compose_down: { action: 'docker_down', payload: {} },
    compose_ps: { action: 'docker_ps', payload: {} },
    restart_caddy: { action: 'docker_up', payload: { services: ['caddy'] } },
    system_prune: { action: 'docker_prune', payload: { all: true } },
  };

  const mapped = mapping[action];
  const response = await callBridgeAction(mapped.action, mapped.payload, options);
  return stringifyBridgeResponse(response);
}

export async function runDockerRestartServices(
  services: string[],
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction('docker_restart', { services }, options);
  return stringifyBridgeResponse(response);
}

export async function runDockerLogs(
  service: string,
  tail = 200,
  timestamps = true,
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction('docker_logs', { service, tail, timestamps }, options);
  return stringifyBridgeResponse(response);
}

export async function runDockerExec(
  service: string,
  command: string,
  timeoutMs = 300000,
  user = 'sail',
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction(
    'docker_exec',
    {
      service,
      command,
      timeout_ms: timeoutMs,
      user,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function listGithubBranches(
  limit = 20,
  owner?: string,
  repo?: string,
  token?: string,
  options?: BridgeCallOptions,
): Promise<string[]> {
  const perPage = Math.min(Math.max(limit, 1), 100);
  const response = await callBridgeAction(
    'github_list_branches',
    {
      owner,
      repo,
      token,
      page: 1,
      per_page: perPage,
    },
    options,
  );
  return parseBranchNames(asBridgeResponse(response).result);
}

export async function createGithubBranch(input: GithubBranchCreateInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'github_create_branch',
    {
      branch: input.name,
      source_branch: input.base ?? 'main',
      owner: input.owner,
      repo: input.repo,
      token: input.token,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function compareGithubBranches(
  input: GithubBranchCompareInput,
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction(
    'github_compare_branches',
    {
      base: input.base,
      head: input.head,
      owner: input.owner,
      repo: input.repo,
      token: input.token,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function createGithubPullRequest(
  input: GithubCreatePullRequestInput,
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction(
    'github_create_pr',
    {
      base: input.base,
      head: input.head,
      title: input.title,
      body: input.body,
      draft: input.draft,
      owner: input.owner,
      repo: input.repo,
      token: input.token,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function buildProjectFromBranch(input: BuildProjectFromBranchInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'build_project_from_branch',
    {
      branch: input.branch,
      source_branch: input.sourceBranch,
      create_branch_from_source: Boolean(input.createBranchFromSource),
      name: input.name,
      display_name: input.displayName,
      timezone: input.timezone,
      db_seed: input.dbSeed,
      db_dump_path: input.dbDumpPath,
      owner: input.owner,
      repo: input.repo,
      token: input.token,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function runLaravelControl(input: LaravelControlInput, options?: BridgeCallOptions): Promise<string> {
  const laravelPayload = toLaravelPayload(input.artisanCommand);
  const response = await callBridgeAction(
    'laravel_control',
    {
      prefix: input.prefix,
      command: laravelPayload.command,
      custom_command: laravelPayload.custom_command,
      timeout_ms: input.timeoutMs,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function mcpListInstancesPassthrough(options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction('mcp_list_instances', {}, options);
  return stringifyBridgeResponse(response);
}

export async function mcpCreateInstancePassthrough(input: CreateInstanceInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'mcp_create_instance',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function mcpRemoveInstancePassthrough(input: RemoveInstanceInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'mcp_remove_instance',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function runSystemDoctor(includeComposePs = true, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'system_doctor',
    { include_compose_ps: includeComposePs },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function runSystemInstall(
  targets?: string[],
  packageManager?: 'auto' | 'brew' | 'apt' | 'dnf' | 'pacman',
  options?: BridgeCallOptions,
): Promise<string> {
  const response = await callBridgeAction(
    'system_install',
    {
      targets,
      package_manager: packageManager,
    },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function runProjectBootstrap(mode: ProjectBootstrapMode = 'up', options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'project_bootstrap',
    { mode },
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function backupCreatePassthrough(input: CreateBackupInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'backup_create',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function backupListPassthrough(options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction('backup_list', {}, options);
  return stringifyBridgeResponse(response);
}

export async function backupRestorePassthrough(input: RestoreBackupInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'backup_restore',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

export interface ViewLogsInput {
  instance?: string;
  source?: 'laravel' | 'docker' | 'audit';
  lines?: number;
  filter?: string;
}

export async function viewLogsPassthrough(input: ViewLogsInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'view_logs',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

export async function instanceHealthPassthrough(instance: string, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'instance_health',
    { instance },
    options,
  );
  return stringifyBridgeResponse(response);
}

export interface RunArtisanInput {
  instance: string;
  command: string;
  timeout?: number;
}

export async function runArtisanPassthrough(input: RunArtisanInput, options?: BridgeCallOptions): Promise<string> {
  const response = await callBridgeAction(
    'run_artisan',
    input as unknown as Record<string, unknown>,
    options,
  );
  return stringifyBridgeResponse(response);
}

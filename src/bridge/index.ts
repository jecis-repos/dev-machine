import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { z } from 'zod';
import { loadRegistry } from '../lib/registry.js';
import { BASE_DIR, instanceHostname } from '../config.js';
import type { CreateInstanceInput, Instance, RemoveInstanceInput } from '../config.js';
import { createInstance } from '../tools/create-instance.js';
import { listInstances } from '../tools/list-instances.js';
import { removeInstanceTool } from '../tools/remove-instance.js';
import { createBackup } from '../tools/create-backup.js';
import { listBackups } from '../tools/list-backups.js';
import { restoreBackup } from '../tools/restore-backup.js';
import { viewLogs } from '../tools/view-logs.js';
import { instanceHealth } from '../tools/instance-health.js';
import { runCommand as runArtisan } from '../tools/run-command.js';
import { BridgeValidationError, BridgeDockerError, BridgeGithubError } from './errors.js';

/* ------------------------------------------------------------------ */
/*  Configurable defaults — no hardcoded owners or repo names          */
/* ------------------------------------------------------------------ */

/** GitHub owner. Override with DEVMACHINE_GITHUB_OWNER env var. */
const DEFAULT_GITHUB_OWNER = process.env.DEVMACHINE_GITHUB_OWNER?.trim() || '';

/** GitHub repo. Override with DEVMACHINE_GITHUB_REPO env var. */
const DEFAULT_GITHUB_REPO = process.env.DEVMACHINE_GITHUB_REPO?.trim() || '';

const GITHUB_API_BASE_URL = 'https://api.github.com';

/* ------------------------------------------------------------------ */
/*  Zod payload schemas                                                */
/* ------------------------------------------------------------------ */

const nonEmptyString = z.string().trim().min(1);

const DockerUpPayloadSchema = z.object({
  services: z.array(nonEmptyString).optional(),
}).strip();

const DockerDownPayloadSchema = z.object({
  volumes: z.boolean().optional(),
  remove_orphans: z.boolean().optional(),
}).strip();

const DockerRestartPayloadSchema = z.object({
  services: z.array(nonEmptyString).optional(),
}).strip();

const DockerPsPayloadSchema = z.object({
  services: z.array(nonEmptyString).optional(),
}).strip();

const DockerLogsPayloadSchema = z.object({
  service: nonEmptyString.optional(),
  tail: z.number().int().min(1).max(5000).optional(),
  timestamps: z.boolean().optional(),
}).strip();

const DockerPrunePayloadSchema = z.object({
  all: z.boolean().optional(),
  volumes: z.boolean().optional(),
}).strip();

const DockerExecPayloadSchema = z.object({
  service: nonEmptyString,
  command: nonEmptyString,
  timeout_ms: z.number().int().min(1).max(1_200_000).optional(),
  user: nonEmptyString.optional(),
}).strip();

const GithubListBranchesPayloadSchema = z.object({
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
}).strip();

const GithubCreateBranchPayloadSchema = z.object({
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
  branch: nonEmptyString,
  source_branch: nonEmptyString,
}).strip();

const GithubCompareBranchesPayloadSchema = z.object({
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
  base: nonEmptyString,
  head: nonEmptyString,
}).strip();

const GithubCreatePrPayloadSchema = z.object({
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
  base: nonEmptyString,
  head: nonEmptyString,
  title: nonEmptyString,
  body: z.string().optional(),
  draft: z.boolean().optional(),
}).strip();

const BuildProjectFromBranchPayloadSchema = z.object({
  branch: nonEmptyString,
  name: nonEmptyString.optional(),
  display_name: nonEmptyString.optional(),
  timezone: nonEmptyString.optional(),
  db_seed: nonEmptyString.optional(),
  db_dump_path: nonEmptyString.optional(),
  create_branch_from_source: z.boolean().optional(),
  source_branch: nonEmptyString.optional(),
  allow_gate_override: z.boolean().optional(),
  gate_override_reason: nonEmptyString.optional(),
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
}).strip();

type BuildProjectFromBranchPayload = z.infer<typeof BuildProjectFromBranchPayloadSchema>;

const LARAVEL_CONTROL_COMMANDS = [
  'migrate',
  'test',
  'optimize',
  'optimize_clear',
  'queue_restart',
  'custom',
] as const;

type LaravelControlCommand = (typeof LARAVEL_CONTROL_COMMANDS)[number];

const LaravelControlPayloadSchema = z.object({
  instance: nonEmptyString.optional(),
  prefix: nonEmptyString.optional(),
  command: z.enum(LARAVEL_CONTROL_COMMANDS),
  custom_command: nonEmptyString.optional(),
  timeout_ms: z.number().int().min(1).max(1_200_000).optional(),
}).strip().refine((payload) => Boolean(payload.instance || payload.prefix), {
  message: 'Provide "instance" or "prefix".',
});

const McpCreateInstancePayloadSchema = z.object({
  branch: nonEmptyString,
  name: nonEmptyString.optional(),
  display_name: nonEmptyString.optional(),
  timezone: nonEmptyString.optional(),
  db_seed: nonEmptyString.optional(),
  db_dump_path: nonEmptyString.optional(),
  token: nonEmptyString.optional(),
}).strip();

const McpRemoveInstancePayloadSchema = z.object({
  name: nonEmptyString,
  keep_database: z.boolean().optional(),
  keep_files: z.boolean().optional(),
}).strip();

const BackupCreatePayloadSchema = z.object({
  name: nonEmptyString.optional(),
}).strip();

const BackupRestorePayloadSchema = z.object({
  backup_id: nonEmptyString,
  restore_databases: z.boolean().optional(),
  restore_files: z.boolean().optional(),
}).strip();

const ViewLogsPayloadSchema = z.object({
  instance: nonEmptyString.optional(),
  source: z.enum(['laravel', 'docker', 'audit']).optional(),
  lines: z.number().int().min(1).max(1000).optional(),
  filter: nonEmptyString.optional(),
}).strip();

const InstanceHealthPayloadSchema = z.object({
  instance: nonEmptyString,
}).strip();

const RunArtisanPayloadSchema = z.object({
  instance: nonEmptyString,
  command: nonEmptyString,
  timeout: z.number().int().min(5000).max(600000).optional(),
}).strip();

/* ------------------------------------------------------------------ */
/*  System install targets                                             */
/* ------------------------------------------------------------------ */

const SYSTEM_INSTALL_TARGETS = [
  'git',
  'docker',
  'mkcert',
  'make',
  'claude',
  'codex',
  'brew',
  'iterm2',
  'ohmyzsh',
  'spaceship',
  'zsh_plugins',
] as const;

type SystemInstallTarget = (typeof SYSTEM_INSTALL_TARGETS)[number];

const SYSTEM_INSTALL_DEFAULT_TARGETS: SystemInstallTarget[] = [
  'git',
  'docker',
  'mkcert',
  'make',
  'claude',
  'codex',
];

const PROJECT_ZSH_CUSTOM_PLUGIN_REPOS = {
  'zsh-autosuggestions': 'https://github.com/zsh-users/zsh-autosuggestions.git',
  'zsh-syntax-highlighting': 'https://github.com/zsh-users/zsh-syntax-highlighting.git',
  'zsh-completions': 'https://github.com/zsh-users/zsh-completions.git',
} as const;

const PROJECT_ZSH_REQUIRED_PLUGINS = [
  'git',
  'docker',
  'docker-compose',
  'npm',
  'node',
  'nvm',
  'composer',
  'laravel',
  'zsh-autosuggestions',
  'zsh-syntax-highlighting',
  'zsh-completions',
] as const;

const SYSTEM_PACKAGE_MANAGERS = ['auto', 'brew', 'apt', 'dnf', 'pacman'] as const;
type SystemPackageManager = (typeof SYSTEM_PACKAGE_MANAGERS)[number];

const SYSTEM_BOOTSTRAP_MODES = ['up', 'install', 'fresh'] as const;
type SystemBootstrapMode = (typeof SYSTEM_BOOTSTRAP_MODES)[number];

const SystemDoctorPayloadSchema = z.object({
  include_compose_ps: z.boolean().optional(),
}).strip();

const SystemInstallPayloadSchema = z.object({
  targets: z.array(z.enum(SYSTEM_INSTALL_TARGETS)).optional(),
  package_manager: z.enum(SYSTEM_PACKAGE_MANAGERS).optional(),
}).strip();

const ProjectBootstrapPayloadSchema = z.object({
  mode: z.enum(SYSTEM_BOOTSTRAP_MODES).optional(),
}).strip();

/* ------------------------------------------------------------------ */
/*  Action registry                                                    */
/* ------------------------------------------------------------------ */

export const TUI_BRIDGE_ACTIONS = [
  'system_doctor',
  'system_install',
  'project_bootstrap',
  'docker_up',
  'docker_down',
  'docker_restart',
  'docker_ps',
  'docker_logs',
  'docker_prune',
  'docker_exec',
  'github_list_branches',
  'github_create_branch',
  'github_compare_branches',
  'github_create_pr',
  'build_project_from_branch',
  'laravel_control',
  'mcp_list_instances',
  'mcp_create_instance',
  'mcp_remove_instance',
  'backup_create',
  'backup_list',
  'backup_restore',
  'view_logs',
  'instance_health',
  'run_artisan',
] as const;

export type TuiBridgeAction = (typeof TUI_BRIDGE_ACTIONS)[number];

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

type PayloadRecord = Record<string, unknown>;

interface CommandExecutionError extends Error {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface BuildProjectPreflightCheck {
  name: string;
  passed: boolean;
  blocking: boolean;
  details: string;
}

interface BuildProjectPreflightOverride {
  requested: boolean;
  applied: boolean;
  reason?: string;
}

interface BuildProjectPreflightReport {
  checked_at: string;
  checks: BuildProjectPreflightCheck[];
  blockers: string[];
  passed: boolean;
  override: BuildProjectPreflightOverride;
}

interface GithubContext {
  owner: string;
  repo: string;
  token: string;
}

interface GithubBranch {
  name?: string;
  protected?: boolean;
  commit?: {
    sha?: string;
    url?: string;
  };
}

interface GithubRef {
  ref?: string;
  url?: string;
  object?: {
    sha?: string;
    type?: string;
    url?: string;
  };
}

interface GithubCompareCommit {
  sha?: string;
  commit?: {
    message?: string;
    author?: {
      name?: string;
      date?: string;
    };
  };
  author?: {
    login?: string;
  };
}

interface GithubCompareFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

interface GithubCompareResponse {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  html_url?: string;
  permalink_url?: string;
  commits?: GithubCompareCommit[];
  files?: GithubCompareFile[];
}

interface GithubPullRequestResponse {
  number?: number;
  state?: string;
  title?: string;
  html_url?: string;
  draft?: boolean;
  merged?: boolean;
  head?: {
    ref?: string;
  };
  base?: {
    ref?: string;
  };
}

interface DockerPublisherSnapshot {
  url?: string;
  target_port?: number;
  published_port?: number;
  protocol?: string;
}

export interface DockerServiceSnapshot {
  name: string;
  service: string;
  state: string;
  status?: string;
  health?: string;
  exit_code?: number;
  publishers: DockerPublisherSnapshot[];
}

export interface DashboardInstanceSnapshot extends Instance {
  url: string;
  service_name: string;
  service_state: string;
  running: boolean;
}

export interface DashboardSnapshot {
  generated_at: string;
  docker: {
    services: DockerServiceSnapshot[];
    error?: string;
  };
  registry: {
    count: number;
    instances: DashboardInstanceSnapshot[];
  };
}

/* ------------------------------------------------------------------ */
/*  Dashboard snapshot                                                 */
/* ------------------------------------------------------------------ */

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const registry = await loadRegistry();
  let dockerServices: DockerServiceSnapshot[] = [];
  let dockerError: string | undefined;

  try {
    dockerServices = getDockerServicesSnapshot();
  } catch (err: unknown) {
    dockerError = toErrorMessage(err);
  }

  const servicesByName = new Map<string, DockerServiceSnapshot>();
  for (const service of dockerServices) {
    servicesByName.set(service.service, service);
  }

  const instances: DashboardInstanceSnapshot[] = registry.instances.map((instance: Instance) => {
    const serviceName = `${instance.prefix}-app`;
    const serviceSnapshot = servicesByName.get(serviceName);
    const serviceState = serviceSnapshot?.state ?? 'missing';
    return {
      ...instance,
      url: `https://${instanceHostname(instance.prefix)}`,
      service_name: serviceName,
      service_state: serviceState,
      running: isRunningState(serviceState),
    };
  });

  const dockerBlock = dockerError
    ? { services: dockerServices, error: dockerError }
    : { services: dockerServices };

  return {
    generated_at: new Date().toISOString(),
    docker: dockerBlock,
    registry: {
      count: registry.instances.length,
      instances,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Main dispatcher                                                    */
/* ------------------------------------------------------------------ */

export async function runTuiBridgeAction(
  action: TuiBridgeAction,
  payloadJson?: string,
): Promise<{ action: TuiBridgeAction; result: unknown }> {
  const payload = parsePayload(payloadJson);

  switch (action) {
    case 'system_doctor':
      return { action, result: runSystemDoctor(payload) };
    case 'system_install':
      return { action, result: runSystemInstall(payload) };
    case 'project_bootstrap':
      return { action, result: runProjectBootstrap(payload) };
    case 'docker_up':
      return { action, result: runDockerUp(payload) };
    case 'docker_down':
      return { action, result: runDockerDown(payload) };
    case 'docker_restart':
      return { action, result: runDockerRestart(payload) };
    case 'docker_ps':
      return { action, result: runDockerPs(payload) };
    case 'docker_logs':
      return { action, result: runDockerLogs(payload) };
    case 'docker_prune':
      return { action, result: runDockerPrune(payload) };
    case 'docker_exec':
      return { action, result: runDockerExec(payload) };
    case 'github_list_branches':
      return { action, result: await runGithubListBranches(payload) };
    case 'github_create_branch':
      return { action, result: await runGithubCreateBranch(payload) };
    case 'github_compare_branches':
      return { action, result: await runGithubCompareBranches(payload) };
    case 'github_create_pr':
      return { action, result: await runGithubCreatePullRequest(payload) };
    case 'build_project_from_branch':
      return { action, result: await runBuildProjectFromBranch(payload) };
    case 'laravel_control':
      return { action, result: runLaravelControl(payload) };
    case 'mcp_list_instances':
      return { action, result: await runMcpListInstances() };
    case 'mcp_create_instance':
      return { action, result: await runMcpCreateInstance(payload) };
    case 'mcp_remove_instance':
      return { action, result: await runMcpRemoveInstance(payload) };
    case 'backup_create':
      return { action, result: await runBackupCreate(payload) };
    case 'backup_list':
      return { action, result: await runBackupList() };
    case 'backup_restore':
      return { action, result: await runBackupRestore(payload) };
    case 'view_logs':
      return { action, result: await runViewLogs(payload) };
    case 'instance_health':
      return { action, result: await runInstanceHealth(payload) };
    case 'run_artisan':
      return { action, result: await runRunArtisan(payload) };
    default:
      return assertNever(action);
  }
}

/* ------------------------------------------------------------------ */
/*  Payload parsing                                                    */
/* ------------------------------------------------------------------ */

function parsePayload(payloadJson?: string): PayloadRecord {
  if (!payloadJson || !payloadJson.trim()) {
    return {};
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch (err: unknown) {
    throw new BridgeValidationError(`Invalid payload JSON: ${toErrorMessage(err)}`);
  }

  if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    throw new Error('Payload JSON must decode to an object.');
  }

  return parsedPayload as PayloadRecord;
}

/* ------------------------------------------------------------------ */
/*  system_doctor                                                      */
/* ------------------------------------------------------------------ */

function runSystemDoctor(payload: PayloadRecord): Record<string, unknown> {
  const parsed = SystemDoctorPayloadSchema.parse(payload);
  type DoctorCheck = {
    name: string;
    installed: boolean;
    version?: string;
    compose_version?: string;
    install_hint?: string;
    optional?: boolean;
  };
  const checks: DoctorCheck[] = [];

  const nodeVersion = safeCommandOutput('node', ['--version']);
  checks.push({
    name: 'node',
    installed: Boolean(nodeVersion),
    version: nodeVersion ?? '',
    install_hint: 'Install Node.js LTS from https://nodejs.org/',
  });

  const npmVersion = safeCommandOutput('npm', ['--version']);
  checks.push({
    name: 'npm',
    installed: Boolean(npmVersion),
    version: npmVersion ?? '',
    install_hint: 'npm is bundled with Node.js.',
  });

  const gitVersion = safeCommandOutput('git', ['--version']);
  checks.push({
    name: 'git',
    installed: Boolean(gitVersion),
    version: gitVersion ?? '',
    install_hint: installHintFor('git'),
  });

  const dockerVersion = safeCommandOutput('docker', ['--version']);
  const dockerComposeVersion = safeCommandOutput('docker', ['compose', 'version']);
  checks.push({
    name: 'docker',
    installed: Boolean(dockerVersion),
    version: dockerVersion ?? '',
    compose_version: dockerComposeVersion ?? '',
    install_hint: installHintFor('docker'),
  });

  const makeVersion = safeCommandOutput('make', ['--version']);
  checks.push({
    name: 'make',
    installed: Boolean(makeVersion),
    version: firstLine(makeVersion) ?? '',
    install_hint: installHintFor('make'),
  });

  const mkcertVersion = safeCommandOutput('mkcert', ['-version']);
  checks.push({
    name: 'mkcert',
    installed: Boolean(mkcertVersion),
    version: mkcertVersion ?? '',
    install_hint: installHintFor('mkcert'),
  });

  const claudeVersion = safeCommandOutput('claude', ['--version']);
  checks.push({
    name: 'claude',
    installed: Boolean(claudeVersion),
    version: claudeVersion ?? '',
    install_hint: installHintFor('claude'),
  });

  const codexVersion = safeCommandOutput('codex', ['--version']);
  checks.push({
    name: 'codex',
    installed: Boolean(codexVersion),
    version: codexVersion ?? '',
    install_hint: installHintFor('codex'),
  });

  if (process.platform === 'darwin') {
    const brewVersion = safeCommandOutput('brew', ['--version']);
    checks.push({
      name: 'brew',
      installed: Boolean(brewVersion),
      version: firstLine(brewVersion) ?? '',
      install_hint: installHintFor('brew'),
    });

    checks.push({
      name: 'iterm2',
      installed: isIterm2Installed(),
      version: isIterm2Installed() ? 'installed' : '',
      install_hint: installHintFor('iterm2'),
      optional: true,
    });

    checks.push({
      name: 'ohmyzsh',
      installed: isOhMyZshInstalled(),
      version: isOhMyZshInstalled() ? 'installed' : '',
      install_hint: installHintFor('ohmyzsh'),
      optional: true,
    });

    checks.push({
      name: 'spaceship',
      installed: isSpaceshipInstalled(),
      version: isSpaceshipInstalled() ? 'configured' : '',
      install_hint: installHintFor('spaceship'),
      optional: true,
    });

    checks.push({
      name: 'zsh_plugins',
      installed: areProjectZshPluginsInstalled(),
      version: areProjectZshPluginsInstalled() ? 'configured' : '',
      install_hint: installHintFor('zsh_plugins'),
      optional: true,
    });
  }

  const missing = checks
    .filter((check) => !check.installed && !check.optional)
    .map((check) => String(check.name));

  const composeValid = Boolean(
    dockerVersion && dockerComposeVersion && safeCommandOutput('docker', ['compose', 'config', '--quiet'], 60000) !== undefined,
  );
  const composeServices = parsed.include_compose_ps
    ? parseDockerComposePs(safeCommandOutput('docker', ['compose', 'ps', '--format', 'json']) ?? '')
    : [];

  return {
    os: process.platform,
    arch: process.arch,
    checked_at: new Date().toISOString(),
    checks,
    missing,
    project: {
      compose_valid: composeValid,
      services: composeServices,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  system_install                                                     */
/* ------------------------------------------------------------------ */

function runSystemInstall(payload: PayloadRecord): Record<string, unknown> {
  const parsed = SystemInstallPayloadSchema.parse(payload);
  const targets = parsed.targets?.length ? parsed.targets : [...SYSTEM_INSTALL_DEFAULT_TARGETS];
  const packageManager = resolvePackageManager(parsed.package_manager ?? 'auto');
  const results: Array<Record<string, unknown>> = [];
  let brewBootstrapOutput: { installedBefore: boolean; outputLines: string[] } | null = null;

  if (process.platform === 'darwin' && packageManager === 'brew') {
    brewBootstrapOutput = installHomebrewIfMissing();
    if (targets.includes('brew')) {
      results.push({
        target: 'brew',
        installed_before: brewBootstrapOutput.installedBefore,
        installed_after: commandExists('brew'),
        changed: !brewBootstrapOutput.installedBefore,
        output: brewBootstrapOutput.outputLines.join('\n'),
      });
    }
  }

  for (const target of targets) {
    if (target === 'brew') {
      if (process.platform !== 'darwin') {
        results.push({
          target,
          installed_before: false,
          installed_after: false,
          changed: false,
          error: 'Homebrew target is only supported on macOS.',
        });
      } else if (!results.some((row) => row.target === 'brew')) {
        brewBootstrapOutput = brewBootstrapOutput ?? installHomebrewIfMissing();
        results.push({
          target: 'brew',
          installed_before: brewBootstrapOutput.installedBefore,
          installed_after: commandExists('brew'),
          changed: !brewBootstrapOutput.installedBefore,
          output: brewBootstrapOutput.outputLines.join('\n'),
        });
      }
      continue;
    }

    const installedBefore = isTargetInstalled(target);
    if (installedBefore) {
      results.push({
        target,
        installed_before: true,
        installed_after: true,
        changed: false,
        output: `${target} is already installed.`,
      });
      continue;
    }

    const commands = buildInstallCommands(target, packageManager);
    if (commands.length === 0) {
      results.push({
        target,
        installed_before: false,
        installed_after: false,
        changed: false,
        error: `No install command defined for ${target} on ${packageManager}.`,
      });
      continue;
    }

    const commandOutputs: string[] = [];
    try {
      for (const command of commands) {
        const output = runShell(command, 900000);
        commandOutputs.push(output || `[ok] ${command}`);
      }

      if (target === 'docker' && process.platform === 'linux' && commandExists('systemctl')) {
        try {
          const systemctlCommand = `${sudoPrefix()}systemctl enable --now docker`;
          const systemctlOutput = runShell(systemctlCommand, 180000);
          commandOutputs.push(systemctlOutput || '[ok] docker service enabled');
        } catch (err: unknown) {
          commandOutputs.push(`warning: could not enable docker service automatically: ${toErrorMessage(err)}`);
        }
      }

      results.push({
        target,
        installed_before: false,
        installed_after: isTargetInstalled(target),
        changed: true,
        commands,
        output: commandOutputs.join('\n').trim(),
      });
    } catch (err: unknown) {
      results.push({
        target,
        installed_before: false,
        installed_after: isTargetInstalled(target),
        changed: false,
        commands,
        error: toErrorMessage(err),
      });
    }

    if (target === 'ohmyzsh' || target === 'spaceship' || target === 'zsh_plugins') {
      const latest = results[results.length - 1];
      if (latest && typeof latest.error === 'string' && latest.error.trim().length > 0) {
        continue;
      }
      const configureNotes = configureProjectZshRc({
        ensureTheme: target === 'spaceship',
        ensurePlugins: target === 'ohmyzsh' || target === 'zsh_plugins',
      });
      const previousOutput = typeof latest?.output === 'string' ? latest.output : '';
      latest.output = [previousOutput, ...configureNotes].filter(Boolean).join('\n');
    }
  }

  return {
    os: process.platform,
    package_manager: packageManager,
    executed_at: new Date().toISOString(),
    results,
  };
}

/* ------------------------------------------------------------------ */
/*  project_bootstrap                                                  */
/* ------------------------------------------------------------------ */

function runProjectBootstrap(payload: PayloadRecord): Record<string, unknown> {
  const parsed = ProjectBootstrapPayloadSchema.parse(payload);
  const mode = parsed.mode ?? 'up';

  const commandByMode: Record<SystemBootstrapMode, { args: string[]; timeout: number }> = {
    up: { args: ['up'], timeout: 600000 },
    install: { args: ['install'], timeout: 1_800_000 },
    fresh: { args: ['fresh'], timeout: 1_800_000 },
  };

  const command = commandByMode[mode];
  const output = runCommand('make', command.args, command.timeout);

  return {
    mode,
    command: `make ${command.args.join(' ')}`,
    output: output || `make ${command.args.join(' ')} completed.`,
  };
}

/* ------------------------------------------------------------------ */
/*  Docker actions                                                     */
/* ------------------------------------------------------------------ */

function runDockerUp(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerUpPayloadSchema.parse(payload);
  const args = ['up', '-d', ...(parsed.services ?? [])];
  const output = runDockerCompose(args, 180000);

  return {
    command: `docker compose ${args.join(' ')}`,
    output: output || 'Docker compose up completed.',
  };
}

function runDockerDown(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerDownPayloadSchema.parse(payload);
  const args = ['down'];
  if (parsed.remove_orphans) {
    args.push('--remove-orphans');
  }
  if (parsed.volumes) {
    args.push('--volumes');
  }

  const output = runDockerCompose(args, 180000);
  return {
    command: `docker compose ${args.join(' ')}`,
    output: output || 'Docker compose down completed.',
  };
}

function runDockerRestart(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerRestartPayloadSchema.parse(payload);
  const args = ['restart', ...(parsed.services ?? [])];
  const output = runDockerCompose(args, 180000);

  return {
    command: `docker compose ${args.join(' ')}`,
    output: output || 'Docker compose restart completed.',
  };
}

function runDockerPs(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerPsPayloadSchema.parse(payload);
  const args = ['ps', '--format', 'json', ...(parsed.services ?? [])];
  const output = runDockerCompose(args);

  return {
    command: `docker compose ${args.join(' ')}`,
    services: parseDockerComposePs(output),
  };
}

function runDockerLogs(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerLogsPayloadSchema.parse(payload);
  const tail = parsed.tail ?? 200;
  const args = ['logs', '--no-color', '--tail', String(tail)];
  if (parsed.timestamps) {
    args.push('--timestamps');
  }
  if (parsed.service) {
    args.push(parsed.service);
  }

  const output = runDockerCompose(args, 180000);
  return {
    command: `docker compose ${args.join(' ')}`,
    output: output || 'No logs returned.',
  };
}

function runDockerPrune(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerPrunePayloadSchema.parse(payload);
  const args = ['system', 'prune', '-f'];
  if (parsed.all) {
    args.push('--all');
  }
  if (parsed.volumes) {
    args.push('--volumes');
  }

  const output = runCommand('docker', args, 300000);
  return {
    command: `docker ${args.join(' ')}`,
    output: output || 'Docker system prune completed.',
  };
}

function runDockerExec(payload: PayloadRecord): Record<string, unknown> {
  const parsed = DockerExecPayloadSchema.parse(payload);
  const timeoutMs = parsed.timeout_ms ?? 300000;
  const args = ['exec', '-T'];
  if (parsed.user) {
    args.push('-u', parsed.user);
  }
  args.push(parsed.service, 'sh', '-lc', parsed.command);
  const output = runDockerCompose(args, timeoutMs);

  return {
    command: `docker compose ${args.join(' ')}`,
    service: parsed.service,
    executed: parsed.command,
    output: output || 'Command completed with no output.',
  };
}

/* ------------------------------------------------------------------ */
/*  GitHub actions                                                     */
/* ------------------------------------------------------------------ */

async function runGithubListBranches(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = GithubListBranchesPayloadSchema.parse(payload);
  const owner = resolveGithubOwner(parsed.owner);
  const repo = resolveGithubRepo(parsed.repo);
  const perPage = parsed.per_page ?? 100;
  const page = parsed.page ?? 1;

  const token = resolveGithubTokenOptional(parsed.token);
  if (!token) {
    const remoteUrl = `https://github.com/${owner}/${repo}.git`;
    const output = runCommand('git', ['ls-remote', '--heads', remoteUrl], 120000);
    const branches = output
      .split('\n')
      .map((line) => line.split('\t')[1] ?? '')
      .map((ref) => ref.replace('refs/heads/', '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const pageSlice = branches.slice(start, end);

    return {
      owner,
      repo,
      page,
      per_page: perPage,
      source: 'git-ls-remote',
      branches: pageSlice.map((name) => ({ name, protected: false, sha: '' })),
    };
  }

  const context: GithubContext = { owner, repo, token };

  const query = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });

  const response = await githubRequest<GithubBranch[]>(
    `/repos/${context.owner}/${context.repo}/branches?${query.toString()}`,
    context.token,
    { method: 'GET' },
  );

  return {
    owner: context.owner,
    repo: context.repo,
    page,
    per_page: perPage,
    branches: response.map((branch) => ({
      name: branch.name ?? '',
      protected: Boolean(branch.protected),
      sha: branch.commit?.sha ?? '',
    })),
  };
}

async function runGithubCreateBranch(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = GithubCreateBranchPayloadSchema.parse(payload);
  const context = buildGithubContext(parsed.owner, parsed.repo, parsed.token);

  return createGithubBranch(context, parsed.branch, parsed.source_branch);
}

async function runGithubCompareBranches(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = GithubCompareBranchesPayloadSchema.parse(payload);
  const context = buildGithubContext(parsed.owner, parsed.repo, parsed.token);

  const comparePath =
    `/repos/${context.owner}/${context.repo}/compare/` +
    `${encodeURIComponent(parsed.base)}...${encodeURIComponent(parsed.head)}`;
  const response = await githubRequest<GithubCompareResponse>(comparePath, context.token, { method: 'GET' });

  const commits = Array.isArray(response.commits)
    ? response.commits.map((commit) => ({
      sha: commit.sha ?? '',
      message: commit.commit?.message ?? '',
      author: commit.author?.login ?? commit.commit?.author?.name ?? '',
      date: commit.commit?.author?.date ?? '',
    }))
    : [];
  const files = Array.isArray(response.files)
    ? response.files.map((file) => ({
      filename: file.filename ?? '',
      status: file.status ?? '',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
    }))
    : [];
  const latestCommit = commits.length > 0 ? commits[commits.length - 1] : null;

  return {
    owner: context.owner,
    repo: context.repo,
    base: parsed.base,
    head: parsed.head,
    status: response.status ?? 'unknown',
    ahead_by: response.ahead_by ?? 0,
    behind_by: response.behind_by ?? 0,
    total_commits: response.total_commits ?? commits.length,
    file_count: files.length,
    html_url: response.html_url ?? response.permalink_url ?? '',
    latest_commit: latestCommit,
    commits: commits.slice(-20),
    files: files.slice(0, 200),
  };
}

async function runGithubCreatePullRequest(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = GithubCreatePrPayloadSchema.parse(payload);
  const context = buildGithubContext(parsed.owner, parsed.repo, parsed.token);

  const requestPayload = {
    title: parsed.title,
    head: parsed.head,
    base: parsed.base,
    body: parsed.body ?? '',
    draft: Boolean(parsed.draft),
  };

  const response = await githubRequest<GithubPullRequestResponse>(
    `/repos/${context.owner}/${context.repo}/pulls`,
    context.token,
    {
      method: 'POST',
      body: JSON.stringify(requestPayload),
    },
  );

  return {
    owner: context.owner,
    repo: context.repo,
    number: response.number ?? 0,
    title: response.title ?? parsed.title,
    state: response.state ?? 'open',
    draft: Boolean(response.draft),
    base: response.base?.ref ?? parsed.base,
    head: response.head?.ref ?? parsed.head,
    html_url: response.html_url ?? '',
    merged: Boolean(response.merged),
  };
}

/* ------------------------------------------------------------------ */
/*  build_project_from_branch (combined GitHub + instance create)      */
/* ------------------------------------------------------------------ */

function normalizeDbSeed(value?: string): 'default' | 'none' | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'default';
  }
  if (['default', 'seed', 'yes'].includes(normalized)) {
    return 'default';
  }
  if (['none', 'skip', 'empty'].includes(normalized)) {
    return 'none';
  }
  return undefined;
}

function resolveDbDumpPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  return isAbsolute(trimmed) ? trimmed : join(BASE_DIR, trimmed);
}

function isSaneGitBranchName(branch: string): boolean {
  const candidate = branch.trim();
  if (!candidate) {
    return false;
  }

  if (safeCommandOutput('git', ['--version'])) {
    try {
      runCommand('git', ['check-ref-format', '--branch', candidate], 15000);
      return true;
    } catch {
      return false;
    }
  }

  if (candidate === 'HEAD') {
    return false;
  }
  if (candidate.startsWith('-') || candidate.startsWith('/') || candidate.endsWith('/')) {
    return false;
  }
  if (candidate.endsWith('.') || candidate.endsWith('.lock')) {
    return false;
  }
  if (candidate.includes('..') || candidate.includes('@{') || candidate.includes('//') || candidate.includes('\\')) {
    return false;
  }
  if (/[~^:?*[\]\s]/.test(candidate)) {
    return false;
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.'))) {
    return false;
  }

  return true;
}

function runBuildProjectFromBranchPreflight(parsed: BuildProjectFromBranchPayload): BuildProjectPreflightReport {
  const checks: BuildProjectPreflightCheck[] = [];
  const branch = parsed.branch.trim();
  const sourceBranch = parsed.source_branch?.trim();
  const overrideReason = parsed.gate_override_reason?.trim();

  const addCheck = (name: string, passed: boolean, details: string, blocking = true): void => {
    checks.push({ name, passed, blocking, details });
  };

  const consistencyIssues: string[] = [];
  if (parsed.create_branch_from_source && sourceBranch && sourceBranch === branch) {
    consistencyIssues.push('"branch" must differ from "source_branch" when "create_branch_from_source" is true.');
  }
  if (parsed.allow_gate_override && !overrideReason) {
    consistencyIssues.push('"gate_override_reason" is required when "allow_gate_override" is true.');
  }
  addCheck(
    'required_params_consistency',
    consistencyIssues.length === 0,
    consistencyIssues.length === 0
      ? 'Required parameter consistency checks passed.'
      : consistencyIssues.join(' '),
  );

  const hasRequiredSourceBranch = !parsed.create_branch_from_source || Boolean(sourceBranch);
  addCheck(
    'source_branch_presence',
    hasRequiredSourceBranch,
    hasRequiredSourceBranch
      ? 'Source branch requirement satisfied.'
      : '"source_branch" is required when "create_branch_from_source" is true.',
  );

  const invalidBranchNames: string[] = [];
  if (!isSaneGitBranchName(branch)) {
    invalidBranchNames.push(`branch="${branch}"`);
  }
  if (sourceBranch && !isSaneGitBranchName(sourceBranch)) {
    invalidBranchNames.push(`source_branch="${sourceBranch}"`);
  }
  addCheck(
    'branch_naming_sanity',
    invalidBranchNames.length === 0,
    invalidBranchNames.length === 0
      ? 'Provided branch names passed sanity checks.'
      : `Invalid branch name value(s): ${invalidBranchNames.join(', ')}`,
  );

  const normalizedSeed = normalizeDbSeed(parsed.db_seed);
  addCheck(
    'db_seed_validity',
    normalizedSeed !== undefined,
    normalizedSeed
      ? `db_seed resolved to "${normalizedSeed}".`
      : `Invalid db_seed "${parsed.db_seed}". Use one of: default, none (aliases are accepted).`,
  );

  const dbDumpPath = parsed.db_dump_path?.trim();
  if (!dbDumpPath) {
    addCheck(
      'custom_dump_path_existence',
      true,
      'No custom "db_dump_path" provided; default seed resolution will be used.',
    );
  } else {
    const resolvedDumpPath = resolveDbDumpPath(dbDumpPath);
    if (!existsSync(resolvedDumpPath)) {
      addCheck(
        'custom_dump_path_existence',
        false,
        `Custom db_dump_path does not exist: ${resolvedDumpPath}`,
      );
    } else {
      try {
        const stats = statSync(resolvedDumpPath);
        addCheck(
          'custom_dump_path_existence',
          stats.isFile(),
          stats.isFile()
            ? `Custom db_dump_path exists: ${resolvedDumpPath}`
            : `Custom db_dump_path exists but is not a file: ${resolvedDumpPath}`,
        );
      } catch (err: unknown) {
        addCheck(
          'custom_dump_path_existence',
          false,
          `Could not inspect db_dump_path "${resolvedDumpPath}": ${toErrorMessage(err)}`,
        );
      }
    }
  }

  const gitVersion = safeCommandOutput('git', ['--version']);
  addCheck(
    'git_availability',
    Boolean(gitVersion),
    gitVersion ?? `git CLI is not available. ${installHintFor('git')}`,
  );

  const dockerVersion = safeCommandOutput('docker', ['--version']);
  addCheck(
    'docker_availability',
    Boolean(dockerVersion),
    dockerVersion ?? `docker CLI is not available. ${installHintFor('docker')}`,
  );

  const composeVersion = dockerVersion ? safeCommandOutput('docker', ['compose', 'version']) : undefined;
  addCheck(
    'compose_availability',
    Boolean(composeVersion),
    composeVersion ?? `docker compose is not available. ${installHintFor('docker')}`,
  );

  const blockers = checks
    .filter((check) => check.blocking && !check.passed)
    .map((check) => `${check.name}: ${check.details}`);
  const overrideRequested = Boolean(parsed.allow_gate_override);
  const overrideApplied = blockers.length > 0 && overrideRequested && Boolean(overrideReason);

  return {
    checked_at: new Date().toISOString(),
    checks,
    blockers,
    passed: blockers.length === 0,
    override: {
      requested: overrideRequested,
      applied: overrideApplied,
      reason: overrideReason,
    },
  };
}

async function runBuildProjectFromBranch(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = BuildProjectFromBranchPayloadSchema.parse(payload);
  const gateReport = runBuildProjectFromBranchPreflight(parsed);
  if (!gateReport.passed && !gateReport.override.applied) {
    const blockerSummary = gateReport.blockers.join(' | ');
    throw new Error(
      `Preflight gate blocked build_project_from_branch: ${blockerSummary}. ` +
      'Set "allow_gate_override": true and provide "gate_override_reason" to bypass. ' +
      `Gate report: ${JSON.stringify(gateReport)}`,
    );
  }

  let branchResult: Record<string, unknown> | null = null;

  if (parsed.create_branch_from_source) {
    const sourceBranch = parsed.source_branch?.trim();
    if (!sourceBranch) {
      throw new Error('"source_branch" is required when "create_branch_from_source" is true.');
    }
    const context = buildGithubContext(parsed.owner, parsed.repo, parsed.token);
    branchResult = await createGithubBranch(context, parsed.branch, sourceBranch);
  }

  const createInput: CreateInstanceInput = {
    branch: parsed.branch,
    name: parsed.name,
    display_name: parsed.display_name,
    timezone: parsed.timezone,
    db_seed: parsed.db_seed,
    db_dump_path: parsed.db_dump_path,
  };
  const createResult = await withGithubTokenOverride(parsed.token, async () => createInstance(createInput));
  assertCreateInstanceSucceeded(createResult);

  return {
    branch: parsed.branch,
    branch_created: Boolean(branchResult),
    github_branch: branchResult,
    gate_report: gateReport,
    create_instance_result: createResult,
  };
}

/* ------------------------------------------------------------------ */
/*  Laravel control                                                    */
/* ------------------------------------------------------------------ */

function runLaravelControl(payload: PayloadRecord): Record<string, unknown> {
  const parsed = LaravelControlPayloadSchema.parse(payload);
  const prefix = (parsed.prefix ?? parsed.instance) as string;
  const serviceName = `${prefix}-app`;
  const command = resolveLaravelCommand(parsed.command, parsed.custom_command);
  const timeoutMs = parsed.timeout_ms ?? 300000;

  const output = runDockerCompose(['exec', '-T', '-u', 'sail', serviceName, 'sh', '-lc', command], timeoutMs);

  return {
    prefix,
    service: serviceName,
    command: parsed.command,
    executed: command,
    output: output || 'Command completed with no output.',
  };
}

/* ------------------------------------------------------------------ */
/*  Instance CRUD pass-through                                         */
/* ------------------------------------------------------------------ */

async function runMcpListInstances(): Promise<Record<string, unknown>> {
  const output = await listInstances();
  return { output };
}

async function runMcpCreateInstance(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = McpCreateInstancePayloadSchema.parse(payload);
  const input: CreateInstanceInput = {
    branch: parsed.branch,
    name: parsed.name,
    display_name: parsed.display_name,
    timezone: parsed.timezone,
    db_seed: parsed.db_seed,
    db_dump_path: parsed.db_dump_path,
  };

  const output = await withGithubTokenOverride(parsed.token, async () => createInstance(input));
  assertCreateInstanceSucceeded(output);
  return { output };
}

async function runMcpRemoveInstance(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = McpRemoveInstancePayloadSchema.parse(payload);
  const input: RemoveInstanceInput = {
    name: parsed.name,
    keep_database: parsed.keep_database,
    keep_files: parsed.keep_files,
  };

  const output = await removeInstanceTool(input);
  return { output };
}

/* ------------------------------------------------------------------ */
/*  Backup / restore                                                   */
/* ------------------------------------------------------------------ */

async function runBackupCreate(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = BackupCreatePayloadSchema.parse(payload);
  const output = await createBackup({ name: parsed.name });
  return { output };
}

async function runBackupList(): Promise<Record<string, unknown>> {
  const output = await listBackups();
  return { output };
}

async function runBackupRestore(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = BackupRestorePayloadSchema.parse(payload);
  const output = await restoreBackup({
    backup_id: parsed.backup_id,
    restore_databases: parsed.restore_databases,
    restore_files: parsed.restore_files,
  });
  return { output };
}

/* ------------------------------------------------------------------ */
/*  Logs / health / artisan                                            */
/* ------------------------------------------------------------------ */

async function runViewLogs(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = ViewLogsPayloadSchema.parse(payload);
  const output = await viewLogs({
    instance: parsed.instance,
    source: parsed.source,
    lines: parsed.lines,
    filter: parsed.filter,
  });
  return { output };
}

async function runInstanceHealth(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = InstanceHealthPayloadSchema.parse(payload);
  const output = await instanceHealth({ instance: parsed.instance });
  return { output };
}

async function runRunArtisan(payload: PayloadRecord): Promise<Record<string, unknown>> {
  const parsed = RunArtisanPayloadSchema.parse(payload);
  const output = await runArtisan({
    instance: parsed.instance,
    command: parsed.command,
    timeout: parsed.timeout,
  });
  return { output };
}

/* ------------------------------------------------------------------ */
/*  Docker helpers                                                     */
/* ------------------------------------------------------------------ */

function getDockerServicesSnapshot(): DockerServiceSnapshot[] {
  const output = runDockerCompose(['ps', '--format', 'json']);
  return parseDockerComposePs(output);
}

function parseDockerComposePs(output: string): DockerServiceSnapshot[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const entries: unknown[] = [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new BridgeDockerError('Unexpected docker compose ps format.');
    }
    entries.push(...parsed);
  } else {
    for (const line of trimmed.split('\n')) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      entries.push(JSON.parse(text) as unknown);
    }
  }

  return entries.map((entry) => normalizeDockerService(entry));
}

function normalizeDockerService(entry: unknown): DockerServiceSnapshot {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new BridgeDockerError('Unexpected docker compose ps entry payload.');
  }

  const row = entry as Record<string, unknown>;
  const service = toMaybeString(row.Service) ?? toMaybeString(row.Name) ?? 'unknown';
  const name = toMaybeString(row.Name) ?? service;
  const state = toMaybeString(row.State) ?? toMaybeString(row.Status) ?? 'unknown';

  return {
    name,
    service,
    state,
    status: toMaybeString(row.Status),
    health: toMaybeString(row.Health),
    exit_code: toMaybeNumber(row.ExitCode),
    publishers: parseDockerPublishers(row.Publishers),
  };
}

function parseDockerPublishers(value: unknown): DockerPublisherSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const publishers: DockerPublisherSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const publisher = item as Record<string, unknown>;
    const snapshot: DockerPublisherSnapshot = {
      url: toMaybeString(publisher.URL),
      target_port: toMaybeNumber(publisher.TargetPort),
      published_port: toMaybeNumber(publisher.PublishedPort),
      protocol: toMaybeString(publisher.Protocol),
    };
    publishers.push(snapshot);
  }

  return publishers;
}

/* ------------------------------------------------------------------ */
/*  Command execution helpers                                          */
/* ------------------------------------------------------------------ */

function firstLine(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split('\n')[0]?.trim();
}

function safeCommandOutput(command: string, args: string[], timeoutMs = 30000): string | undefined {
  try {
    return runCommand(command, args, timeoutMs);
  } catch {
    return undefined;
  }
}

function commandExists(command: string): boolean {
  return Boolean(safeCommandOutput('sh', ['-lc', `command -v ${command}`], 10000));
}

function getHomeDirectory(): string {
  const home = process.env.HOME?.trim();
  if (!home) {
    throw new Error('HOME is not set. Cannot complete shell setup.');
  }
  return home;
}

/* ------------------------------------------------------------------ */
/*  Homebrew helpers                                                   */
/* ------------------------------------------------------------------ */

function detectBrewBinary(): string | null {
  const fromPath = safeCommandOutput('sh', ['-lc', 'command -v brew'], 10000);
  const resolvedFromPath = firstLine(fromPath);
  if (resolvedFromPath) {
    return resolvedFromPath;
  }
  const fallbackBins = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const candidate of fallbackBins) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function ensureBrewOnPath(): void {
  const brewBinary = detectBrewBinary();
  if (!brewBinary) {
    return;
  }
  const brewDir = brewBinary.replace(/\/brew$/, '');
  const currentPath = process.env.PATH ?? '';
  const pathParts = currentPath.split(':').filter(Boolean);
  if (!pathParts.includes(brewDir)) {
    process.env.PATH = `${brewDir}:${currentPath}`;
  }
}

function installHomebrewIfMissing(): { installedBefore: boolean; outputLines: string[] } {
  ensureBrewOnPath();
  if (commandExists('brew')) {
    return {
      installedBefore: true,
      outputLines: ['Homebrew is already installed.'],
    };
  }
  if (process.platform !== 'darwin') {
    throw new Error('Homebrew bootstrap target is only supported on macOS.');
  }

  const command = process.env.BREW_INSTALL_CMD?.trim()
    || 'NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  const output = runShell(command, 1_800_000);
  ensureBrewOnPath();
  if (!commandExists('brew')) {
    throw new Error('Homebrew install finished but brew was not detected in PATH. Restart shell and retry.');
  }
  const brewPrefix = safeCommandOutput('brew', ['--prefix'], 10000) ?? '';
  const summary = output || 'Homebrew install completed.';
  return {
    installedBefore: false,
    outputLines: [
      summary,
      brewPrefix ? `brew_prefix=${brewPrefix}` : 'brew detected.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Shell / zsh helpers                                                */
/* ------------------------------------------------------------------ */

function isIterm2Installed(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  const home = process.env.HOME ?? '';
  const userApp = home ? join(home, 'Applications', 'iTerm.app') : '';
  return existsSync('/Applications/iTerm.app') || (userApp ? existsSync(userApp) : false);
}

function isOhMyZshInstalled(): boolean {
  const home = process.env.HOME ?? '';
  if (!home) {
    return false;
  }
  return existsSync(join(home, '.oh-my-zsh'));
}

function isSpaceshipInstalled(): boolean {
  const home = process.env.HOME ?? '';
  if (!home) {
    return false;
  }
  const zshCustom = process.env.ZSH_CUSTOM?.trim() || join(home, '.oh-my-zsh', 'custom');
  return existsSync(join(zshCustom, 'themes', 'spaceship-prompt'))
    && existsSync(join(zshCustom, 'themes', 'spaceship.zsh-theme'));
}

function areProjectZshPluginsInstalled(): boolean {
  const home = process.env.HOME ?? '';
  if (!home) {
    return false;
  }
  const zshCustom = process.env.ZSH_CUSTOM?.trim() || join(home, '.oh-my-zsh', 'custom');
  for (const plugin of Object.keys(PROJECT_ZSH_CUSTOM_PLUGIN_REPOS)) {
    if (!existsSync(join(zshCustom, 'plugins', plugin))) {
      return false;
    }
  }
  return true;
}

function ensureFileWithDefault(path: string, defaultContent: string): void {
  if (existsSync(path)) {
    return;
  }
  writeFileSync(path, defaultContent, 'utf-8');
}

function ensureZshThemeInRc(zshrcPath: string, theme: string): boolean {
  let content = readFileSync(zshrcPath, 'utf-8');
  const themeLine = `ZSH_THEME="${theme}"`;
  if (/^ZSH_THEME=.*$/m.test(content)) {
    const replaced = content.replace(/^ZSH_THEME=.*$/m, themeLine);
    if (replaced !== content) {
      writeFileSync(zshrcPath, replaced, 'utf-8');
      return true;
    }
    return false;
  }
  content = `${content.trimEnd()}\n${themeLine}\n`;
  writeFileSync(zshrcPath, content, 'utf-8');
  return true;
}

function parsePluginsFromRc(content: string): string[] {
  const match = content.match(/plugins=\(([\s\S]*?)\)/m);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function ensureZshPluginsInRc(zshrcPath: string, required: readonly string[]): boolean {
  const content = readFileSync(zshrcPath, 'utf-8');
  const existing = parsePluginsFromRc(content);
  const merged = Array.from(new Set([...existing, ...required]));
  const pluginLine = `plugins=(${merged.join(' ')})`;
  if (/plugins=\(([\s\S]*?)\)/m.test(content)) {
    const replaced = content.replace(/plugins=\(([\s\S]*?)\)/m, pluginLine);
    if (replaced !== content) {
      writeFileSync(zshrcPath, replaced, 'utf-8');
      return true;
    }
    return false;
  }
  const next = `${content.trimEnd()}\n${pluginLine}\n`;
  writeFileSync(zshrcPath, next, 'utf-8');
  return true;
}

function configureProjectZshRc(options: { ensureTheme?: boolean; ensurePlugins?: boolean }): string[] {
  if (process.platform !== 'darwin') {
    return ['Skipped zsh profile configuration: not macOS.'];
  }
  if (!isOhMyZshInstalled()) {
    return ['Skipped zsh profile configuration: oh-my-zsh not installed.'];
  }

  const home = getHomeDirectory();
  const zshrcPath = join(home, '.zshrc');
  ensureFileWithDefault(
    zshrcPath,
    [
      'export ZSH="$HOME/.oh-my-zsh"',
      'ZSH_THEME="robbyrussell"',
      'plugins=(git)',
      'source $ZSH/oh-my-zsh.sh',
      '',
    ].join('\n'),
  );

  const notes: string[] = [];
  if (options.ensureTheme) {
    const changed = ensureZshThemeInRc(zshrcPath, 'spaceship');
    notes.push(changed
      ? 'Updated ~/.zshrc theme to spaceship.'
      : '~/.zshrc theme already set to spaceship.');
  }
  if (options.ensurePlugins) {
    const changed = ensureZshPluginsInRc(zshrcPath, PROJECT_ZSH_REQUIRED_PLUGINS);
    notes.push(changed
      ? 'Updated ~/.zshrc plugins with project plugin pack.'
      : '~/.zshrc already contains project plugin pack.');
  }
  notes.push('Run `exec zsh` (or open new iTerm2 tab) to load shell changes.');
  return notes;
}

/* ------------------------------------------------------------------ */
/*  Package manager helpers                                            */
/* ------------------------------------------------------------------ */

function sudoPrefix(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === 0) {
    return '';
  }
  return 'sudo -n ';
}

function runShell(command: string, timeoutMs = 300000): string {
  return runCommand('sh', ['-lc', command], timeoutMs);
}

type ResolvedPackageManager = Exclude<SystemPackageManager, 'auto'>;

function resolvePackageManager(preferred: SystemPackageManager): ResolvedPackageManager {
  if (preferred !== 'auto') {
    return preferred;
  }

  if (process.platform === 'darwin') {
    return 'brew';
  }

  if (process.platform === 'linux') {
    if (commandExists('apt-get')) {
      return 'apt';
    }
    if (commandExists('dnf')) {
      return 'dnf';
    }
    if (commandExists('pacman')) {
      return 'pacman';
    }
    throw new Error('Unsupported Linux distribution: no apt-get/dnf/pacman detected.');
  }

  throw new Error(`Unsupported OS for automatic package installation: ${process.platform}`);
}

function installHintFor(target: SystemInstallTarget | 'node' | 'npm'): string {
  const packageManager = (() => {
    try {
      return resolvePackageManager('auto');
    } catch {
      return null;
    }
  })();

  if (target === 'node' || target === 'npm') {
    return 'Install Node.js LTS from https://nodejs.org/';
  }

  if (target === 'claude') {
    return 'npm install -g @anthropic-ai/claude-code';
  }

  if (target === 'codex') {
    return 'npm install -g @openai/codex';
  }

  if (target === 'brew') {
    return 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  }

  if (target === 'iterm2') {
    return 'brew install --cask iterm2';
  }

  if (target === 'ohmyzsh') {
    return 'RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"';
  }

  if (target === 'spaceship') {
    return 'Install spaceship prompt under $ZSH_CUSTOM/themes and set ZSH_THEME="spaceship" in ~/.zshrc';
  }

  if (target === 'zsh_plugins') {
    return 'Install zsh-autosuggestions, zsh-syntax-highlighting, zsh-completions and add project plugins in ~/.zshrc';
  }

  if (!packageManager) {
    return `Install ${target} using your system package manager.`;
  }

  switch (packageManager) {
    case 'brew':
      return target === 'docker' ? 'brew install --cask docker' : `brew install ${target}`;
    case 'apt':
      return `${sudoPrefix()}apt-get install -y ${target}`;
    case 'dnf':
      return `${sudoPrefix()}dnf install -y ${target}`;
    case 'pacman':
      return `${sudoPrefix()}pacman -Sy --noconfirm ${target}`;
    default:
      return `Install ${target} using your system package manager.`;
  }
}

function isTargetInstalled(target: SystemInstallTarget): boolean {
  switch (target) {
    case 'git':
      return Boolean(safeCommandOutput('git', ['--version']));
    case 'docker':
      return Boolean(safeCommandOutput('docker', ['--version']) && safeCommandOutput('docker', ['compose', 'version']));
    case 'mkcert':
      return Boolean(safeCommandOutput('mkcert', ['-version']));
    case 'make':
      return Boolean(safeCommandOutput('make', ['--version']));
    case 'claude':
      return Boolean(safeCommandOutput('claude', ['--version']));
    case 'codex':
      return Boolean(safeCommandOutput('codex', ['--version']));
    case 'brew':
      return Boolean(safeCommandOutput('brew', ['--version']));
    case 'iterm2':
      return isIterm2Installed();
    case 'ohmyzsh':
      return isOhMyZshInstalled();
    case 'spaceship':
      return isSpaceshipInstalled();
    case 'zsh_plugins':
      return areProjectZshPluginsInstalled();
    default:
      return assertNever(target);
  }
}

function buildInstallCommands(target: SystemInstallTarget, manager: ResolvedPackageManager): string[] {
  if (target === 'claude') {
    const cmd = process.env.CLAUDE_CODE_INSTALL_CMD?.trim() || 'npm install -g @anthropic-ai/claude-code';
    return [cmd];
  }

  if (target === 'codex') {
    const cmd = process.env.CODEX_INSTALL_CMD?.trim() || 'npm install -g @openai/codex';
    return [cmd];
  }

  if (target === 'brew') {
    if (process.platform !== 'darwin') {
      return [];
    }
    const cmd = process.env.BREW_INSTALL_CMD?.trim()
      || 'NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
    return [cmd];
  }

  if (manager === 'brew') {
    switch (target) {
      case 'docker':
        return ['brew install --cask docker'];
      case 'mkcert':
        return ['brew install mkcert nss'];
      case 'git':
      case 'make':
        return [`brew install ${target}`];
      case 'iterm2':
        return ['brew install --cask iterm2'];
      case 'ohmyzsh':
        return [
          'if [ -d "$HOME/.oh-my-zsh" ]; then echo "oh-my-zsh already installed"; else export RUNZSH=no CHSH=no KEEP_ZSHRC=yes && sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"; fi',
        ];
      case 'spaceship':
        return [
          'if [ ! -d "$HOME/.oh-my-zsh" ]; then echo "oh-my-zsh is required before installing spaceship." >&2; exit 1; fi',
          'ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"; mkdir -p "$ZSH_CUSTOM/themes"; if [ ! -d "$ZSH_CUSTOM/themes/spaceship-prompt" ]; then git clone --depth=1 https://github.com/spaceship-prompt/spaceship-prompt.git "$ZSH_CUSTOM/themes/spaceship-prompt"; fi; ln -sfn "$ZSH_CUSTOM/themes/spaceship-prompt/spaceship.zsh-theme" "$ZSH_CUSTOM/themes/spaceship.zsh-theme"',
        ];
      case 'zsh_plugins':
        return [
          'if [ ! -d "$HOME/.oh-my-zsh" ]; then echo "oh-my-zsh is required before installing zsh plugins." >&2; exit 1; fi',
          'ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"; mkdir -p "$ZSH_CUSTOM/plugins"; if [ ! -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions.git "$ZSH_CUSTOM/plugins/zsh-autosuggestions"; fi; if [ ! -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"; fi; if [ ! -d "$ZSH_CUSTOM/plugins/zsh-completions" ]; then git clone --depth=1 https://github.com/zsh-users/zsh-completions.git "$ZSH_CUSTOM/plugins/zsh-completions"; fi',
        ];
      default:
        return [];
    }
  }

  const sudo = sudoPrefix();

  if (manager === 'apt') {
    switch (target) {
      case 'git':
        return [`${sudo}apt-get update`, `${sudo}apt-get install -y git`];
      case 'docker':
        return [`${sudo}apt-get update`, `${sudo}apt-get install -y docker.io docker-compose-plugin`];
      case 'mkcert':
        return [`${sudo}apt-get update`, `${sudo}apt-get install -y mkcert libnss3-tools`];
      case 'make':
        return [`${sudo}apt-get update`, `${sudo}apt-get install -y make`];
      default:
        return [];
    }
  }

  if (manager === 'dnf') {
    switch (target) {
      case 'git':
        return [`${sudo}dnf install -y git`];
      case 'docker':
        return [`${sudo}dnf install -y docker docker-compose-plugin`];
      case 'mkcert':
        return [`${sudo}dnf install -y mkcert nss-tools`];
      case 'make':
        return [`${sudo}dnf install -y make`];
      default:
        return [];
    }
  }

  if (manager === 'pacman') {
    switch (target) {
      case 'git':
        return [`${sudo}pacman -Sy --noconfirm git`];
      case 'docker':
        return [`${sudo}pacman -Sy --noconfirm docker docker-compose`];
      case 'mkcert':
        return [`${sudo}pacman -Sy --noconfirm mkcert nss`];
      case 'make':
        return [`${sudo}pacman -Sy --noconfirm make`];
      default:
        return [];
    }
  }

  return [];
}

/* ------------------------------------------------------------------ */
/*  Docker compose wrapper                                             */
/* ------------------------------------------------------------------ */

function runDockerCompose(args: string[], timeoutMs = 120000): string {
  return runCommand('docker', ['compose', ...args], timeoutMs);
}

/* ------------------------------------------------------------------ */
/*  Instance helpers                                                   */
/* ------------------------------------------------------------------ */

function assertCreateInstanceSucceeded(output: string): void {
  if (/(^|\n)ERROR:/.test(output)) {
    throw new Error(output);
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub token management                                            */
/* ------------------------------------------------------------------ */

async function withGithubTokenOverride<T>(token: string | undefined, run: () => Promise<T>): Promise<T> {
  const resolvedToken = token?.trim();
  if (!resolvedToken) {
    return run();
  }

  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = resolvedToken;
  process.env.GH_TOKEN = resolvedToken;

  try {
    return await run();
  } finally {
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }

    if (previousGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = previousGhToken;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Process execution                                                  */
/* ------------------------------------------------------------------ */

function runCommand(command: string, args: string[], timeoutMs: number): string {
  try {
    const output = execFileSync(command, args, {
      cwd: BASE_DIR,
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf-8',
    });
    return output.trimEnd();
  } catch (err: unknown) {
    const commandError = err as CommandExecutionError;
    const status = commandError.status;
    const stderr = toMaybeOutput(commandError.stderr);
    const stdout = toMaybeOutput(commandError.stdout);
    const details = stderr || stdout || commandError.message || 'Unknown command error';
    const statusText = status === undefined || status === null ? '' : ` (exit ${status})`;
    throw new Error(`${command} ${args.join(' ')} failed${statusText}: ${details}`);
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub API helpers                                                 */
/* ------------------------------------------------------------------ */

function buildGithubContext(owner?: string, repo?: string, token?: string): GithubContext {
  return {
    owner: resolveGithubOwner(owner),
    repo: resolveGithubRepo(repo),
    token: resolveGithubToken(token),
  };
}

function resolveGithubOwner(owner?: string): string {
  const resolved = owner?.trim() || DEFAULT_GITHUB_OWNER;
  if (!resolved) {
    throw new Error(
      'GitHub owner is required. Pass "owner" in the payload or set DEVMACHINE_GITHUB_OWNER env var.',
    );
  }
  return resolved;
}

function resolveGithubRepo(repo?: string): string {
  const resolved = repo?.trim() || DEFAULT_GITHUB_REPO;
  if (!resolved) {
    throw new Error(
      'GitHub repo is required. Pass "repo" in the payload or set DEVMACHINE_GITHUB_REPO env var.',
    );
  }
  return resolved;
}

function resolveGithubTokenOptional(token?: string): string | undefined {
  if (token && token.trim()) {
    return token.trim();
  }

  const ghToken = safeCommandOutput('gh', ['auth', 'token'], 15000)?.trim();
  if (ghToken) {
    return ghToken;
  }

  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  return undefined;
}

function resolveGithubToken(token?: string): string {
  const resolved = resolveGithubTokenOptional(token);
  if (!resolved) {
    throw new Error(
      'GitHub token is required. Pass "token", set GITHUB_TOKEN/GH_TOKEN, or run "gh auth login".',
    );
  }
  return resolved;
}

async function createGithubBranch(
  context: GithubContext,
  branch: string,
  sourceBranch: string,
): Promise<Record<string, unknown>> {
  const sourceRefPath = `/repos/${context.owner}/${context.repo}/git/ref/${encodeURIComponent(`heads/${sourceBranch}`)}`;
  const sourceRef = await githubRequest<GithubRef>(sourceRefPath, context.token, { method: 'GET' });
  const sourceSha = sourceRef.object?.sha;
  if (!sourceSha) {
    throw new Error(`Could not resolve source SHA for "${sourceBranch}".`);
  }

  const createPayload = {
    ref: `refs/heads/${branch}`,
    sha: sourceSha,
  };
  const createdRef = await githubRequest<GithubRef>(
    `/repos/${context.owner}/${context.repo}/git/refs`,
    context.token,
    {
      method: 'POST',
      body: JSON.stringify(createPayload),
    },
  );

  return {
    owner: context.owner,
    repo: context.repo,
    branch,
    source_branch: sourceBranch,
    source_sha: sourceSha,
    ref: createdRef.ref ?? createPayload.ref,
    url: createdRef.url,
  };
}

interface GithubRateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
  updatedAt: Date;
}

let githubRateLimitState: GithubRateLimit | null = null;

export function getGithubRateLimit(): GithubRateLimit | null {
  return githubRateLimitState;
}

function updateGithubRateLimit(response: Response): void {
  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)) {
    githubRateLimitState = {
      limit,
      remaining,
      resetAt: new Date(reset * 1000),
      updatedAt: new Date(),
    };
  }
}

async function githubRequest<T>(
  path: string,
  token: string,
  init: RequestInit,
): Promise<T> {
  if (githubRateLimitState && githubRateLimitState.remaining === 0) {
    const now = Date.now();
    const resetMs = githubRateLimitState.resetAt.getTime();
    if (now < resetMs) {
      const waitMinutes = Math.ceil((resetMs - now) / 60000);
      throw new BridgeGithubError(
        `GitHub API rate limit exceeded. Resets in ~${waitMinutes} min (at ${githubRateLimitState.resetAt.toLocaleTimeString()}).`,
      );
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  updateGithubRateLimit(response);

  const text = await response.text();
  if (!response.ok) {
    const message = text.trim() || response.statusText;
    if (response.status === 403 && githubRateLimitState && githubRateLimitState.remaining === 0) {
      throw new BridgeGithubError(
        `GitHub API rate limit exceeded (${response.status}). Resets at ${githubRateLimitState.resetAt.toLocaleTimeString()}.`,
      );
    }
    throw new BridgeGithubError(`GitHub API ${response.status} error: ${message}`);
  }

  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/*  Laravel command resolution                                         */
/* ------------------------------------------------------------------ */

function resolveLaravelCommand(command: LaravelControlCommand, customCommand?: string): string {
  switch (command) {
    case 'migrate':
      return 'php artisan migrate --force';
    case 'test':
      return 'php artisan test';
    case 'optimize':
      return 'php artisan optimize';
    case 'optimize_clear':
      return 'php artisan optimize:clear';
    case 'queue_restart':
      return 'php artisan queue:restart';
    case 'custom':
      if (!customCommand) {
        throw new Error('"custom_command" is required when command is "custom".');
      }
      return customCommand;
    default:
      return assertNever(command);
  }
}

/* ------------------------------------------------------------------ */
/*  Utility functions                                                  */
/* ------------------------------------------------------------------ */

export function isRunningState(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === 'running' || normalized.startsWith('up');
}

function toMaybeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toMaybeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toMaybeOutput(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value instanceof Buffer) {
    return value.toString('utf-8').trim();
  }
  return undefined;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported action: ${String(value)}`);
}

/**
 * Shared type definitions for dev-machine.
 */

/* ------------------------------------------------------------------ */
/*  Instance                                                           */
/* ------------------------------------------------------------------ */

export interface Instance {
  prefix: string;
  display_name: string;
  directory: string;
  branch: string;
  php_image?: string;
  php_version?: string;
  db_name: string;
  redis_db: number;
  redis_cache_db: number;
  vite_port: number;
  timezone: string;
  created_at?: string;
  status?: "provisioning" | "updating" | "ready";
  expires_at?: string;
}

export interface Registry {
  instances: Instance[];
}

/* ------------------------------------------------------------------ */
/*  Tool inputs                                                        */
/* ------------------------------------------------------------------ */

export interface CreateInstanceInput {
  branch: string;
  name?: string;
  display_name?: string;
  timezone?: string;
  db_dump_path?: string;
  ttl_hours?: number;
}

export interface RemoveInstanceInput {
  name: string;
  keep_database?: boolean;
  keep_files?: boolean;
  force_orphan_cleanup?: boolean;
}

export interface UpdateInstanceInput {
  name: string;
  branch?: string;
}

export interface InstanceHealthInput {
  instance: string;
}

export interface RunCommandInput {
  instance: string;
  command: string;
  timeout?: number;
}

export interface ViewLogsInput {
  instance?: string;
  source?: "laravel" | "docker" | "audit";
  lines?: number;
  filter?: string;
}

export interface CreateBackupInput {
  name?: string;
}

export interface RestoreBackupInput {
  backup_id: string;
  restore_databases?: boolean;
  restore_files?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Worktree                                                           */
/*                                                                     */
/*  Parallel — but intentionally separate from — `Instance`.           */
/*  Worktrees use `git worktree add` against a shared `.git` and a     */
/*  dedicated DB on an existing pgvector container (port 5435 by       */
/*  default). No Docker, Caddy, Redis, or port allocation.             */
/* ------------------------------------------------------------------ */

export interface Worktree {
  task_id: string;              // kebab-case, used as DB name + branch suffix
  worktree_path: string;        // absolute path to the worktree
  branch: string;               // e.g. "agent-<task_id>"
  base_ref: string;             // ref the worktree was branched from
  db_host: string;
  db_port: string;
  db_username: string;
  db_password: string;
  db_database: string;          // dedicated DB on the pgvector container
  created_at: string;           // ISO-8601
  expires_at?: string;          // optional TTL
}

export interface WorktreeRegistry {
  worktrees: Worktree[];
}

export interface WorktreeCreateInput {
  task_id: string;
  repo_root: string;
  base_ref?: string;
  ttl_hours?: number;
}

export interface WorktreeRemoveInput {
  task_id: string;
}

export interface WorktreeListInput {
  // no params; placeholder for future filters
}

export interface WorktreeStatusInput {
  task_id: string;
}

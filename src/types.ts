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

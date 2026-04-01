const DB_NAME_REGEX = /^[a-z0-9_]+$/;
const HOSTNAME_REGEX = /^[a-z0-9.-]+$/;

export function validateDbName(name: string): void {
  if (!DB_NAME_REGEX.test(name)) {
    throw new Error(`Invalid database name: "${name}". Only lowercase alphanumeric and underscores allowed.`);
  }
}

export function validateHostname(hostname: string): void {
  if (!HOSTNAME_REGEX.test(hostname)) {
    throw new Error(`Invalid hostname: "${hostname}". Only lowercase alphanumeric, dots, and hyphens allowed.`);
  }
}

export function quoteDbIdentifier(name: string): string {
  validateDbName(name);
  return `"${name}"`;
}

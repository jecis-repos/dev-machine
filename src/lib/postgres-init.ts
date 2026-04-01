import { readFile, writeFile } from "node:fs/promises";
import { INIT_SQL_PATH } from "../config.js";
import { validateDbName, quoteDbIdentifier } from "./sanitize.js";

/**
 * Add CREATE DATABASE entries to init.sql for a new instance.
 * Creates both the app database and a testing database.
 */
export async function addDatabaseEntries(dbName: string): Promise<void> {
  validateDbName(dbName);
  const testingDb = `${dbName}_testing`;

  const content = await readFile(INIT_SQL_PATH, "utf-8");
  const quoted = quoteDbIdentifier(dbName);
  const quotedTesting = quoteDbIdentifier(testingDb);

  if (content.includes(`CREATE DATABASE ${quoted}`)) return;

  const entries = `\nCREATE DATABASE ${quoted};\nCREATE DATABASE ${quotedTesting};\n`;
  await writeFile(INIT_SQL_PATH, content.trimEnd() + entries, "utf-8");
}

/**
 * Remove CREATE DATABASE entries from init.sql.
 */
export async function removeDatabaseEntries(dbName: string): Promise<void> {
  validateDbName(dbName);
  const testingDb = `${dbName}_testing`;

  let content = await readFile(INIT_SQL_PATH, "utf-8");

  for (const name of [dbName, testingDb]) {
    const quoted = quoteDbIdentifier(name);
    const regex = new RegExp(`^CREATE DATABASE ${quoted.replace(/"/g, "\\\"")};\\n?`, "gm");
    content = content.replace(regex, "");
  }

  content = content.replace(/\n{3,}/g, "\n\n");
  await writeFile(INIT_SQL_PATH, content, "utf-8");
}

import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let workspace: string | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test("built MCP entry point initializes and exposes its tools", async () => {
  workspace = await mkdtemp(join(tmpdir(), "dev-machine-entry-"));
  client = new Client({ name: "entrypoint-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: workspace,
    env: { DEVMACHINE_BASE_DIR: workspace },
    stderr: "pipe",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    "create-instance", "remove-instance", "instance-health",
  ]));
}, 15000);

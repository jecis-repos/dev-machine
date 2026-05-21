#!/usr/bin/env node

/**
 * dev-machine — One-command multi-project local dev environment.
 *
 * Modes:
 *   dev-machine --tui                → Interactive TUI dashboard (blessed)
 *   dev-machine --http[=<port>]      → MCP server over HTTP/SSE
 *   dev-machine --port=<port>        → alias for --http=<port>
 *   dev-machine                      → MCP server over stdio (default)
 *
 * Environment fallbacks (for --http mode):
 *   DEVMACHINE_HTTP_PORT             → port (default 8730)
 *   DEVMACHINE_HTTP_HOST             → bind host (default 127.0.0.1)
 */

const PKG_NAME = "dev-machine";
const PKG_VERSION = "0.1.0";

const args = process.argv.slice(2);

function findFlagValue(prefix: string): string | undefined {
  for (const a of args) {
    if (a === prefix) return ""; // present, no value
    if (a.startsWith(`${prefix}=`)) return a.slice(prefix.length + 1);
  }
  return undefined;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid port value: ${JSON.stringify(raw)} (must be 0-65535)`);
  }
  return n;
}

const wantHttp = args.includes("--http") || args.some((a) => a.startsWith("--http=") || a.startsWith("--port="));

if (args.includes("--tui") || args.includes("-t")) {
  // TUI mode — dynamic import keeps blessed out of MCP-server cold path
  const { startTui } = await import("./tui/index.js");
  startTui();
} else if (wantHttp) {
  // HTTP/SSE MCP mode
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools } = await import("./tools/index.js");
  const { startHttpServer, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } = await import("./lib/http-server.js");

  // Precedence: explicit CLI value > env var > default
  const cliHttp = findFlagValue("--http");
  const cliPort = findFlagValue("--port");
  const port =
    parsePort(cliHttp) ??
    parsePort(cliPort) ??
    parsePort(process.env.DEVMACHINE_HTTP_PORT) ??
    DEFAULT_HTTP_PORT;
  const host = process.env.DEVMACHINE_HTTP_HOST ?? DEFAULT_HTTP_HOST;

  // The Streamable-HTTP transport is stateless: each request needs its own
  // (McpServer, transport) pair (see src/lib/http-server.ts for the rationale).
  const createMcpServer = () => {
    const server = new McpServer({ name: PKG_NAME, version: PKG_VERSION });
    registerTools(server);
    return server;
  };

  try {
    await startHttpServer({ createMcpServer, host, port, name: PKG_NAME, version: PKG_VERSION });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EADDRINUSE") {
      console.error(`[http] port ${host}:${port} is already in use`);
    } else {
      console.error(`[http] failed to start: ${e?.message ?? e}`);
    }
    process.exit(1);
  }
} else {
  // Default: stdio MCP server
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerTools } = await import("./tools/index.js");

  const server = new McpServer({
    name: PKG_NAME,
    version: PKG_VERSION,
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

#!/usr/bin/env node

/**
 * dev-machine — One-command multi-project local dev environment.
 *
 * Modes:
 *   npm run tui    → Interactive TUI dashboard (blessed)
 *   npm run dev    → MCP server mode (for AI tool integration)
 */

const args = process.argv.slice(2);

if (args.includes("--tui") || args.includes("-t")) {
  // TUI mode — import dynamically to avoid blessed dep when running as MCP server
  const { startTui } = await import("./tui/index.js");
  await startTui();
} else {
  // Default: MCP server mode
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerTools } = await import("./tools/index.js");

  const server = new McpServer({
    name: "dev-machine",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

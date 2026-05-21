import { afterEach, describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer, type HttpServerHandle } from "../src/lib/http-server.js";

// Track every handle started during a test so afterEach can guarantee teardown
// even if an assertion throws mid-test.
const handles: HttpServerHandle[] = [];

interface SpawnOpts {
  /** Optional extra tools to register on the per-request McpServer. */
  withTools?: (server: McpServer) => void;
}

async function spawn(spawnOpts: SpawnOpts = {}): Promise<HttpServerHandle> {
  const handle = await startHttpServer({
    createMcpServer: () => {
      // Fresh McpServer per request — the SDK requires this for stateless
      // Streamable-HTTP transport. We intentionally do NOT call the real
      // `registerTools()` to keep the test hermetic; callers can pass
      // `withTools` to register a minimal set.
      const server = new McpServer({ name: "dev-machine-test", version: "0.0.0-test" });
      spawnOpts.withTools?.(server);
      return server;
    },
    host: "127.0.0.1",
    port: 0, // ephemeral
    name: "dev-machine",
    version: "0.0.0-test",
    silent: true,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.close().catch(() => undefined);
  }
});

describe("startHttpServer", () => {
  it("binds to an ephemeral port and reports it back", async () => {
    const h = await spawn();
    expect(h.host).toBe("127.0.0.1");
    expect(h.port).toBeGreaterThan(0);
    expect(h.port).toBeLessThan(65536);
  });

  it("GET /healthz returns 200 and the expected JSON shape", async () => {
    const h = await spawn();
    const res = await fetch(`http://${h.host}:${h.port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      name: "dev-machine",
      version: "0.0.0-test",
      transport: "streamable-http",
    });
  });

  it("unknown paths return 404 JSON", async () => {
    const h = await spawn();
    const res = await fetch(`http://${h.host}:${h.port}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe("not_found");
    expect(body.path).toBe("/nope");
  });

  it("POST /mcp initializes and returns the server info", async () => {
    // Each POST gets a fresh McpServer; we register a single trivial tool to
    // prove the McpServer<->transport wiring works end-to-end without dragging
    // in src/tools/index.ts (which would touch the filesystem).
    const h = await spawn({
      withTools(server) {
        server.tool("ping", "Health probe", {}, async () => ({
          content: [{ type: "text" as const, text: "pong" }],
        }));
      },
    });

    const res = await fetch(`http://${h.host}:${h.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);

    // Stateless Streamable-HTTP responds via SSE by default — the body is one
    // or more `event:`/`data:` blocks; we just need to extract the first JSON
    // payload to assert on it.
    const raw = await res.text();
    const payload = parseJsonOrSse(raw) as {
      jsonrpc?: string;
      id?: number;
      result?: { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
    } | null;

    expect(payload).toBeTruthy();
    expect(payload?.jsonrpc).toBe("2.0");
    expect(payload?.id).toBe(1);
    expect(payload?.result?.serverInfo?.name).toBe("dev-machine-test");
    expect(payload?.result?.protocolVersion).toBeTruthy();
  });
});

/** Pull the first JSON-RPC envelope out of either a plain JSON body or an SSE stream. */
function parseJsonOrSse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // SSE: lines like `event: message\ndata: {...}\n\n`
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^data:\s*(.+)$/.exec(line);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // keep scanning subsequent data lines
      }
    }
  }
  return null;
}

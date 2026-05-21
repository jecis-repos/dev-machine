/**
 * HTTP MCP transport — wraps an `McpServer` factory with a `node:http` listener
 * that routes `POST /mcp` (and `GET /mcp` for SSE streaming) through a
 * stateless `StreamableHTTPServerTransport`, plus a small `GET /healthz` JSON
 * endpoint.
 *
 * Why a server factory and not a singleton? The MCP SDK's stateless
 * `StreamableHTTPServerTransport` refuses to handle more than one request per
 * instance (see `_hasHandledRequest` guard in the SDK), and `McpServer`
 * connects to a single transport exclusively. So each request gets its own
 * (server, transport) pair, mirroring the SDK's own
 * `simpleStatelessStreamableHttp.js` example.
 *
 * For our scale this is cheap: a new `McpServer` is just object construction
 * and `registerTools` runs O(num_tools) `server.tool(...)` calls.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Defaults; can be overridden per-call. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8730;

export interface StartHttpServerOptions {
  /**
   * Factory that constructs a fresh `McpServer` (with tools already
   * registered) for each incoming MCP request. Called once per `/mcp` request.
   */
  createMcpServer: () => McpServer | Promise<McpServer>;
  /** Bind host. Default: `127.0.0.1`. */
  host?: string;
  /** Bind port. Pass `0` for an ephemeral port (handy in tests). Default: `8730`. */
  port?: number;
  /** Server name advertised in `/healthz`. Default: `"dev-machine"`. */
  name?: string;
  /** Server version advertised in `/healthz`. Default: `"0.0.0"`. */
  version?: string;
  /** If true, suppress the `[http] listening on ...` log line. Default: `false`. */
  silent?: boolean;
}

export interface HttpServerHandle {
  /** Bound host (mirrors the input, or whatever node resolved). */
  host: string;
  /** Actual bound port (resolved value when `port: 0` was passed). */
  port: number;
  /** Underlying `node:http` server, exposed for advanced use cases. */
  raw: Server;
  /** Shuts down the HTTP listener and any in-flight MCP transports. */
  close: () => Promise<void>;
}

/**
 * Start an HTTP server that speaks the MCP "Streamable HTTP" transport.
 *
 * Routes:
 *   - `GET  /healthz` → `{ status, name, version, transport }` (200)
 *   - `POST /mcp`     → JSON-RPC request, optional SSE stream response
 *   - `GET  /mcp`     → SSE upgrade (server-initiated notifications)
 *   - any other path  → 404 JSON
 */
export async function startHttpServer(opts: StartHttpServerOptions): Promise<HttpServerHandle> {
  const host = opts.host ?? DEFAULT_HTTP_HOST;
  const port = opts.port ?? DEFAULT_HTTP_PORT;
  const name = opts.name ?? "dev-machine";
  const version = opts.version ?? "0.0.0";
  const silent = opts.silent ?? false;

  // Track in-flight (server, transport) pairs so close() can tear them down.
  const inflight = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer((req, res) => {
    handle(req, res, { createMcpServer: opts.createMcpServer, name, version, inflight }).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error", message: String(err?.message ?? err) }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const addr = httpServer.address() as AddressInfo | null;
  const boundPort = addr?.port ?? port;
  const boundHost = addr?.address ?? host;

  if (!silent) {
    // eslint-disable-next-line no-console
    console.error(`[http] listening on ${boundHost}:${boundPort}`);
  }

  const close = async (): Promise<void> => {
    // Close any in-flight pairs first so streaming responses can drain.
    const drains = Array.from(inflight).map(async ({ server, transport }) => {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    });
    inflight.clear();
    await Promise.all(drains);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { host: boundHost, port: boundPort, raw: httpServer, close };
}

/** Per-request router. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    createMcpServer: () => McpServer | Promise<McpServer>;
    name: string;
    version: string;
    inflight: Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>;
  },
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?", 1)[0];

  if (req.method === "GET" && path === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        name: ctx.name,
        version: ctx.version,
        transport: "streamable-http",
      }),
    );
    return;
  }

  if (path === "/mcp") {
    // SDK pattern (see `examples/server/simpleStatelessStreamableHttp.js`):
    // build a fresh McpServer + transport per request, hand off, then clean
    // up when the client disconnects. Stateless mode = no session affinity.
    const server = await ctx.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const pair = { server, transport };
    ctx.inflight.add(pair);

    const cleanup = async () => {
      if (!ctx.inflight.has(pair)) return;
      ctx.inflight.delete(pair);
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    };
    res.on("close", () => {
      void cleanup();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      await cleanup();
      throw err;
    }
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_found", path }));
}

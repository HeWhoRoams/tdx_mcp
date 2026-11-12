import type { ServerLifecycle } from "../lifecycle.js";
import { getConfig } from "../config.js";
import { getCounters, logger } from "../services/logger.js";
import { getClient } from "../services/client.js";
import { SERVER_VERSION } from "../server.js";
import { onShutdown } from "../shutdown.js";

export async function runHttp(lifecycle: ServerLifecycle): Promise<void> {
  // Imported lazily so the stdio path never loads the HTTP stack.
  const [{ createMcpExpressApp }, { StreamableHTTPServerTransport }, corsModule, rateLimitModule, { timingSafeEqual }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/express.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("cors"),
      import("express-rate-limit"),
      import("node:crypto"),
    ]);
  const cors = corsModule.default;
  const rateLimit = rateLimitModule.default;

  const config = getConfig();
  const { host, port, isLoopback, authToken, allowedHosts, allowedOrigins } = config.server;

  const app = createMcpExpressApp({ host, ...(allowedHosts.length ? { allowedHosts } : {}) });

  const isOriginAllowed = (origin: string): boolean => {
    if (allowedOrigins.includes(origin)) return true;
    if (!isLoopback) return false;
    try {
      const originHost = new URL(origin).hostname;
      return originHost === "127.0.0.1" || originHost === "localhost" || originHost === "::1";
    } catch {
      return false;
    }
  };

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32002, message: "Forbidden origin" }, id: null });
      return;
    }
    next();
  });

  // CORS is needed only for browser-based clients; server-to-server clients omit Origin.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || isOriginAllowed(origin)),
      allowedHeaders: ["Accept", "Authorization", "Content-Type", "Last-Event-ID", "MCP-Protocol-Version", "Mcp-Session-Id"],
      exposedHeaders: ["Mcp-Session-Id"],
      methods: ["POST"],
    })
  );

  if (!isLoopback) {
    app.use(
      "/mcp",
      rateLimit({
        windowMs: 60_000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Rate limit exceeded. Please slow down." },
          id: null,
        },
      })
    );
  }

  if (authToken) {
    const expected = Buffer.from(`Bearer ${authToken}`);
    app.use("/mcp", (req, res, next) => {
      const received = Buffer.from(req.headers.authorization ?? "");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        res
          .status(401)
          .set("WWW-Authenticate", "Bearer")
          .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
        return;
      }
      next();
    });
  }

  const startedAt = Date.now();
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      version: SERVER_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      readOnly: config.readOnly,
      gating: lifecycle.health(),
      counters: getCounters(),
      rateLimits: getClient().rateLimits(),
    });
  });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: SERVER_VERSION });
  });

  // Stateless JSON responses mean SSE streams and session teardown do not
  // apply; both return 405 so clients fail fast.
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "This server uses stateless JSON responses (enableJsonResponse=true). SSE streams are not supported. Send requests via POST /mcp.",
      },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server is stateless." },
      id: null,
    });
  });

  app.post("/mcp", async (req, res) => {
    // Stateless: a fresh server + transport per request avoids cross-request
    // state and request ID collisions between concurrent clients.
    const session = await lifecycle.open("per-request");
    const server = session.server;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void session.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("error handling MCP request", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Every request builds its own server, so log what gets registered once, here.
  const probe = await lifecycle.open("per-request");
  logger.info("tools registered", probe.registration);
  await probe.close();

  const httpServer = app.listen(port, host, () => {
    logger.info("teamdynamix mcp server ready", {
      transport: "http",
      url: `http://${host}:${port}/mcp`,
      version: SERVER_VERSION,
    });
  });
  onShutdown(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  void getClient().warmUp();
}

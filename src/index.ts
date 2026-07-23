#!/usr/bin/env node
import "dotenv/config";

/**
 * MCP Server for the TeamDynamix Web API.
 *
 * Provides tools to search, read, create, and update TeamDynamix tickets,
 * assets/configuration items, projects, issues, and people/groups, plus
 * reference-data lookups (statuses, priorities, types, applications, accounts).
 *
 * Authentication: set TEAMDYNAMIX_BASE_URL plus either
 *   - TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD (standard user login), or
 *   - TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY (admin service account login)
 *
 * Transport: stdio by default; set TRANSPORT=http to run as a Streamable HTTP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";

import { registerAuthTools } from "./tools/auth.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerCmdbTools } from "./tools/cmdb.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerReportTools } from "./tools/reports.js";

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "teamdynamix-mcp-server",
      version: "1.0.0",
    },
    {
      instructions:
        "Use read-only teamdynamix_search_*, teamdynamix_get_*, teamdynamix_list_*, and teamdynamix_lookup_* tools to retrieve TeamDynamix data. " +
        "Use teamdynamix_create_*, teamdynamix_update_*, teamdynamix_add_*, teamdynamix_remove_*, and teamdynamix_link_* tools to change TeamDynamix. " +
        "Write tools are explicitly annotated as non-read-only; clients should obtain user approval according to their policy before invoking them. " +
        "Discover application and reference-data IDs with list tools before creating or updating records.",
    }
  );

  registerAuthTools(server);
  registerTicketTools(server);
  registerAssetTools(server);
  registerCmdbTools(server);
  registerProjectTools(server);
  registerIssueTools(server);
  registerPeopleTools(server);
  registerReferenceTools(server);
  registerReportTools(server);

  return server;
}

function validateEnv(): void {
  if (!process.env.TEAMDYNAMIX_BASE_URL) {
    console.error(
      "ERROR: TEAMDYNAMIX_BASE_URL environment variable is required (e.g. https://yourorg.teamdynamix.com)."
    );
    process.exit(1);
  }
  const hasUserAuth = process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD;
  const hasAdminAuth = process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY;
  if (!hasUserAuth && !hasAdminAuth) {
    console.error(
      "ERROR: TeamDynamix credentials are required. Set either TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD, " +
        "or TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY."
    );
    process.exit(1);
  }
}

async function runStdio(): Promise<void> {
  validateEnv();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TeamDynamix MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  validateEnv();
  const host = process.env.HOST || "127.0.0.1";
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const authToken = process.env.MCP_AUTH_TOKEN;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

  if (!isLoopback && !authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when HOST is not a loopback address. Set a strong bearer token before exposing write-capable tools remotely."
    );
  }

  const app = createMcpExpressApp({ host, ...(allowedHosts?.length ? { allowedHosts } : {}) });

  const isOriginAllowed = (origin: string): boolean => {
    if (allowedOrigins?.includes(origin)) return true;
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
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Forbidden origin" },
        id: null,
      });
      return;
    }
    next();
  });

  // CORS is needed only for browser-based clients; server-to-server clients omit Origin.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || isOriginAllowed(origin)),
      allowedHeaders: [
        "Accept",
        "Authorization",
        "Content-Type",
        "Last-Event-ID",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    })
  );

  if (authToken) {
    app.use("/mcp", (req, res, next) => {
      if (req.headers.authorization !== `Bearer ${authToken}`) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return;
      }
      next();
    });
  }

  // MCP Streamable HTTP spec requires GET for SSE server-to-client streams.
  // This server uses stateless JSON responses (no persistent sessions), so SSE
  // is not supported — return 405 with a clear explanation so clients fail fast.
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST, DELETE").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "This server uses stateless JSON responses (enableJsonResponse=true). SSE streams are not supported. Send requests via POST /mcp.",
      },
      id: null,
    });
  });

  app.post("/mcp", async (req, res) => {
    // Stateless: a fresh server + transport per request avoids cross-request state
    // and request ID collisions when multiple clients connect concurrently.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Session teardown — some clients send DELETE /mcp to close sessions; acknowledge gracefully.
  app.delete("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server is stateless." },
      id: null,
    });
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, host, () => {
    console.error(`TeamDynamix MCP server running on http://${host}:${port}/mcp`);
  });
}

const transportMode = process.env.TRANSPORT || "stdio";
if (transportMode === "http") {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}

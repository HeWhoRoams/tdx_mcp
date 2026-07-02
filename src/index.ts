#!/usr/bin/env node
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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

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
  const server = new McpServer({
    name: "teamdynamix-mcp-server",
    version: "1.0.0",
  });

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
  const app = express();
  app.use(express.json());

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
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`TeamDynamix MCP server running on http://localhost:${port}/mcp`);
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

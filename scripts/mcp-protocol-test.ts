#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const expectedToolCount = 64;
const expectedReadOnlyToolNames = new Set([
  "teamdynamix_get_asset",
  "teamdynamix_get_asset_feed",
  "teamdynamix_get_ci",
  "teamdynamix_get_ci_feed",
  "teamdynamix_get_ci_relationships",
  "teamdynamix_get_current_user",
  "teamdynamix_get_group",
  "teamdynamix_get_group_members",
  "teamdynamix_get_issue",
  "teamdynamix_get_person",
  "teamdynamix_get_person_uid",
  "teamdynamix_get_project",
  "teamdynamix_get_project_feed",
  "teamdynamix_get_report",
  "teamdynamix_get_ticket",
  "teamdynamix_get_ticket_feed",
  "teamdynamix_get_ticket_tasks",
  "teamdynamix_list_accounts",
  "teamdynamix_list_applications",
  "teamdynamix_list_asset_statuses",
  "teamdynamix_list_ci_relationship_types",
  "teamdynamix_list_ci_types",
  "teamdynamix_list_custom_attributes",
  "teamdynamix_list_locations",
  "teamdynamix_list_product_models",
  "teamdynamix_list_reports",
  "teamdynamix_list_saved_searches",
  "teamdynamix_list_ticket_forms",
  "teamdynamix_list_ticket_impacts",
  "teamdynamix_list_ticket_priorities",
  "teamdynamix_list_ticket_sources",
  "teamdynamix_list_ticket_statuses",
  "teamdynamix_list_ticket_types",
  "teamdynamix_list_ticket_urgencies",
  "teamdynamix_lookup_people",
  "teamdynamix_run_saved_search",
  "teamdynamix_search_assets",
  "teamdynamix_search_cis",
  "teamdynamix_search_groups",
  "teamdynamix_search_issues",
  "teamdynamix_search_people",
  "teamdynamix_search_projects",
  "teamdynamix_search_tickets",
]);
const authToken = "mcp-protocol-test-token";
const baseEnvironment = Object.fromEntries(
  Object.entries({
    ...process.env,
    TEAMDYNAMIX_BASE_URL: "https://example.teamdynamix.com",
    TEAMDYNAMIX_BEID: "test-beid",
    TEAMDYNAMIX_WS_KEY: "test-key",
  }).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function validateTools(tools: Tool[], transportName: string): void {
  if (tools.length !== expectedToolCount) {
    throw new Error(`${transportName}: expected ${expectedToolCount} tools, received ${tools.length}.`);
  }

  const missingAnnotations = tools.filter(
    (tool) => typeof tool.annotations?.readOnlyHint !== "boolean"
  );
  if (missingAnnotations.length > 0) {
    throw new Error(
      `${transportName}: tools missing explicit readOnlyHint: ${missingAnnotations.map((tool) => tool.name).join(", ")}`
    );
  }

  const readTools = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
  const writeTools = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
  if (readTools.length === 0 || writeTools.length === 0) {
    throw new Error(`${transportName}: expected both read and write tools.`);
  }

  console.log(`${transportName}: ${tools.length} tools (${readTools.length} read, ${writeTools.length} write)`);
}

async function validateClient(client: Client, transportName: string, readOnly = false): Promise<void> {
  const instructions = client.getInstructions();
  if (readOnly && !instructions?.includes("configured read-only")) {
    throw new Error(`${transportName}: read-only server instructions are missing.`);
  }
  if (!readOnly && !instructions?.includes("change TeamDynamix")) {
    throw new Error(`${transportName}: server instructions do not explicitly advertise write capability.`);
  }
  const result = await client.listTools();
  if (readOnly) {
    if (result.tools.some((tool) => tool.annotations?.readOnlyHint !== true)) {
      throw new Error(`${transportName}: read-only server exposed a non-read-only tool.`);
    }
    const actualToolNames = new Set(result.tools.map((tool) => tool.name));
    const missingTools = [...expectedReadOnlyToolNames].filter((name) => !actualToolNames.has(name));
    const unexpectedTools = [...actualToolNames].filter((name) => !expectedReadOnlyToolNames.has(name));
    if (missingTools.length > 0 || unexpectedTools.length > 0 || actualToolNames.size !== result.tools.length) {
      throw new Error(
        `${transportName}: read-only tool set mismatch.${
          missingTools.length > 0 ? ` Missing: ${missingTools.join(", ")}.` : ""
        }${unexpectedTools.length > 0 ? ` Unexpected: ${unexpectedTools.join(", ")}.` : ""}${
          actualToolNames.size !== result.tools.length ? " Duplicate tool names detected." : ""
        }`
      );
    }
    console.log(`${transportName}: ${result.tools.length} read-only tools`);
    return;
  }
  validateTools(result.tools, transportName);
}

async function testStdio(): Promise<void> {
  const client = new Client({ name: "teamdynamix-mcp-protocol-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: baseEnvironment,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await validateClient(client, "stdio");
  } finally {
    await client.close();
  }
}

async function testReadOnlyStdio(): Promise<void> {
  const client = new Client({ name: "teamdynamix-mcp-read-only-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: { ...baseEnvironment, TEAMDYNAMIX_READ_ONLY: "true" },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await validateClient(client, "read-only stdio", true);
  } finally {
    await client.close();
  }
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHttpServer(processHandle: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HTTP server did not start in time.")), 10_000);
    processHandle.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited before startup with code ${code}.`));
    });
    processHandle.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("TeamDynamix MCP server running")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function testHttp(): Promise<void> {
  const port = await getAvailablePort();
  const serverProcess = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...baseEnvironment,
      TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_AUTH_TOKEN: authToken,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHttpServer(serverProcess);
    const serverUrl = new URL(`http://127.0.0.1:${port}/mcp`);
    const unauthorized = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (unauthorized.status !== 401) {
      throw new Error(`http: expected unauthenticated request to return 401, received ${unauthorized.status}.`);
    }

    const forbiddenOrigin = await fetch(serverUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (forbiddenOrigin.status !== 403) {
      throw new Error(`http: expected an untrusted Origin to return 403, received ${forbiddenOrigin.status}.`);
    }

    for (const method of ["GET", "DELETE"]) {
      const preflight = await fetch(serverUrl, {
        method: "OPTIONS",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Origin: "http://127.0.0.1",
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "Authorization",
        },
      });
      if (preflight.status !== 204 || preflight.headers.get("access-control-allow-methods") !== "POST") {
        throw new Error(`http: expected ${method} /mcp preflight to omit ${method} from the allowed methods.`);
      }
    }

    for (const method of ["GET", "DELETE"]) {
      const unsupportedMethod = await fetch(serverUrl, {
        method,
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (unsupportedMethod.status !== 405 || unsupportedMethod.headers.get("allow") !== "POST") {
        throw new Error(`http: expected ${method} /mcp to return 405 with Allow: POST.`);
      }
      const errorBody = (await unsupportedMethod.json()) as {
        jsonrpc?: string;
        error?: { code?: number };
        id?: unknown;
      };
      if (errorBody.jsonrpc !== "2.0" || typeof errorBody.error?.code !== "number" || errorBody.id !== null) {
        throw new Error(`http: ${method} /mcp response did not preserve the JSON-RPC error envelope.`);
      }
    }

    const client = new Client({ name: "teamdynamix-mcp-protocol-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    });
    try {
      await client.connect(transport);
      await validateClient(client, "streamable-http");
    } finally {
      await client.close();
    }
  } finally {
    serverProcess.kill();
  }
}

await testStdio();
await testReadOnlyStdio();
await testHttp();
console.log("MCP protocol compatibility checks passed.");
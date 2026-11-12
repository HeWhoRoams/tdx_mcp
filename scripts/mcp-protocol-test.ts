#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const expectedToolCount = 55;
/** Denied by the shipped config/tool-policy.json, which allows only read and create. */
const expectedPolicyDeniedToolNames = new Set([
  "tdx_edit_ticket",
  "tdx_edit_ticket_task",
  "tdx_edit_asset",
  "tdx_edit_ci",
  "tdx_edit_project",
  "tdx_edit_issue",
  "tdx_add_group_members",
  "tdx_remove_ci_relationship",
  "tdx_remove_group_members",
]);
const expectedReadOnlyToolNames = new Set([
  "tdx_get_asset",
  "tdx_get_asset_feed",
  "tdx_get_asset_reference",
  "tdx_get_ci",
  "tdx_get_ci_feed",
  "tdx_get_ci_relationships",
  "tdx_get_current_user",
  "tdx_get_group",
  "tdx_get_group_members",
  "tdx_get_issue",
  "tdx_get_person",
  "tdx_get_person_uid",
  "tdx_get_project",
  "tdx_get_project_feed",
  "tdx_get_report",
  "tdx_get_ticket",
  "tdx_get_ticket_feed",
  "tdx_get_ticket_reference",
  "tdx_get_ticket_tasks",
  "tdx_list_accounts",
  "tdx_list_applications",
  "tdx_list_custom_attributes",
  "tdx_list_locations",
  "tdx_list_reports",
  "tdx_list_saved_searches",
  "tdx_lookup_people",
  "tdx_run_saved_search",
  "tdx_search_assets",
  "tdx_search_cis",
  "tdx_search_groups",
  "tdx_search_issues",
  "tdx_search_people",
  "tdx_search_projects",
  "tdx_search_tickets",
]);
const authToken = "mcp-protocol-test-token";
const baseEnvironment = Object.fromEntries(
  Object.entries({
    ...process.env,
    TEAMDYNAMIX_BASE_URL: "https://example.teamdynamix.com",
    // Pinned so a developer's .env (often SSO) cannot change which tools register.
    TEAMDYNAMIX_AUTH_METHOD: "admin",
    TEAMDYNAMIX_BEID: "test-beid",
    TEAMDYNAMIX_WS_KEY: "test-key",
    // Most checks assert the complete catalog, so lift the shipped policy's deny defaults.
    TDX_ALLOW_CAPABILITIES: "read,create,edit,destroy",
    // Fake credentials and a placeholder host: skip the application lookup so the catalog is deterministic.
    TDX_APP_GATING: "off",
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

async function testDefaultPolicyStdio(): Promise<void> {
  const client = new Client({ name: "teamdynamix-mcp-policy-test", version: "1.0.0" });
  const environment = { ...baseEnvironment };
  delete environment.TDX_ALLOW_CAPABILITIES;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const leaked = [...expectedPolicyDeniedToolNames].filter((name) => names.has(name));
    if (leaked.length > 0) {
      throw new Error(`default policy: edit/destroy tools were registered: ${leaked.join(", ")}.`);
    }
    for (const allowed of ["tdx_add_ticket_comment", "tdx_create_ticket", "tdx_get_ticket"]) {
      if (!names.has(allowed)) throw new Error(`default policy: expected ${allowed} to stay registered.`);
    }
    const expected = expectedToolCount - expectedPolicyDeniedToolNames.size;
    if (names.size !== expected) {
      throw new Error(`default policy: expected ${expected} tools, received ${names.size}.`);
    }
    console.log(`default policy stdio: ${names.size} tools (edit and destroy denied)`);
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
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`HTTP server did not start in time. stderr so far:\n${output || "(none)"}`)),
      10_000
    );
    processHandle.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited before startup with code ${code}. stderr:\n${output || "(none)"}`));
    });
    processHandle.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("teamdynamix mcp server ready")) {
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
      // Startup is detected from the readiness log, so the level must not be inherited.
      TDX_LOG_LEVEL: "info",
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
await testDefaultPolicyStdio();
await testHttp();
console.log("MCP protocol compatibility checks passed.");
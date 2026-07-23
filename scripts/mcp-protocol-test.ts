#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const expectedToolCount = 64;
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

async function validateClient(client: Client, transportName: string): Promise<void> {
  const instructions = client.getInstructions();
  if (!instructions?.includes("change TeamDynamix")) {
    throw new Error(`${transportName}: server instructions do not explicitly advertise write capability.`);
  }
  const result = await client.listTools();
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
await testHttp();
console.log("MCP protocol compatibility checks passed.");
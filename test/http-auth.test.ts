import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MCP_SECRET = "mcp-access-secret-for-test";
const REPO = join(import.meta.dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function jwt(secondsLeft: number): string {
  const payload = Buffer.from(JSON.stringify({ unique_name: "me@x.edu", exp: Math.floor(Date.now() / 1000) + secondsLeft })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

let tdxHome: string;
let fakeTdx: Server;
let child: ChildProcess | undefined;
const seen: IncomingHttpHeaders[] = [];

beforeEach(async () => {
  tdxHome = mkdtempSync(join(tmpdir(), "tdx-http-"));
  seen.length = 0;
  fakeTdx = createHttpServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ UID: "u1", FullName: "Me", PrimaryEmail: "me@x.edu" }));
  });
  await new Promise<void>((resolve) => fakeTdx.listen(0, "127.0.0.1", resolve));
});
afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((resolve) => fakeTdx.close(resolve));
  rmSync(tdxHome, { recursive: true, force: true });
});

async function startServer(): Promise<number> {
  const tdxPort = (fakeTdx.address() as { port: number }).port;
  const port = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      TEAMDYNAMIX_BASE_URL: `http://127.0.0.1:${tdxPort}/SBTDWebApi`,
      TEAMDYNAMIX_AUTH_METHOD: "sso",
      TEAMDYNAMIX_SSO_EXPECTED_USER: "",
      TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_AUTH_TOKEN: MCP_SECRET,
      TDX_HOME: tdxHome,
      TDX_LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return port;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not start");
}

async function savedToken(): Promise<string> {
  // Ask where this realm's token file lives by computing it the same way the server does.
  const { bindingDigest, bindingOf } = await import("../src/auth/identity-binding.js");
  const realm = `http://127.0.0.1:${(fakeTdx.address() as { port: number }).port}/SBTDWebApi/api`;
  const token = jwt(7200);
  mkdirSync(join(tdxHome, "tokens"), { recursive: true });
  writeFileSync(
    join(tdxHome, "tokens", `sso-${bindingDigest(bindingOf(realm))}.json`),
    JSON.stringify({ token, expiresAtMs: Date.now() + 7_200_000, uid: "u1" })
  );
  return token;
}

describe("loopback HTTP with SSO", () => {
  it("rejects a missing or wrong MCP secret before dispatching anything", async () => {
    const port = await startServer();
    const post = (authorization?: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("calls TeamDynamix with the signed-in user's token, never the MCP secret", async () => {
    const token = await savedToken();
    const port = await startServer();
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_SECRET}` } },
      })
    );
    await client.callTool({ name: "teamdynamix_get_current_user", arguments: {} });
    await client.close();

    const withAuth = seen.filter((headers) => headers.authorization);
    expect(withAuth.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(JSON.stringify(headers)).not.toContain(MCP_SECRET);
    }
    expect(withAuth.every((headers) => headers.authorization === `Bearer ${token}`)).toBe(true);
  }, 30_000);
});

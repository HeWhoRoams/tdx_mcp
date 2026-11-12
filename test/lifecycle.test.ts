import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfig } from "../src/config.js";
import { createServerLifecycle, type AvailabilitySource } from "../src/lifecycle.js";
import type { AppKey, Availability } from "../src/policy/availability.js";
import { logger } from "../src/services/logger.js";

const known = (...keys: AppKey[]): Availability => ({ known: true, present: new Set(keys) });
const unknown: Availability = { known: false, reason: "test" };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setEnv(overrides: Record<string, string> = {}): void {
  delete process.env.TDX_APP_GATING;
  delete process.env.TDX_TOOLSETS;
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
}

beforeEach(() => setEnv());
afterEach(() => {
  delete process.env.TDX_APP_GATING;
  resetConfig();
});

const lifecycleWith = (source: AvailabilitySource) =>
  createServerLifecycle({ config: getConfig(), availability: source, retryDelaysMs: [5, 5], retryTimeoutMs: 5 });

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  let toolNotices = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void (toolNotices += 1));
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, notices: () => toolNotices };
}

describe("long-lived sessions (stdio)", () => {
  it("builds a pruned server and never retries when availability is known", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(known("tickets", "projects"));
    const lifecycle = lifecycleWith(source);
    const session = await lifecycle.open("long-lived");
    const { client } = await connect(session.server);
    expect((await client.listTools()).tools).toHaveLength(32);
    await wait(40);
    expect(source).toHaveBeenCalledTimes(1);
    await client.close();
    await session.close();
  });

  it("retries in the background while unknown, then hides unusable tools with one notification", async () => {
    const source = vi
      .fn<AvailabilitySource>()
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValue(known("tickets", "projects"));
    const lifecycle = lifecycleWith(source);
    const session = await lifecycle.open("long-lived");
    const { client, notices } = await connect(session.server);
    expect((await client.listTools()).tools).toHaveLength(46);

    await wait(80);
    expect(source).toHaveBeenCalledTimes(3);
    expect(source.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: getConfig().appGating.timeoutMs });
    expect(source.mock.calls[1]?.[0]).toMatchObject({ bypassNegativeCache: true });
    expect(notices()).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(32);
    await client.close();
    await session.close();
  });

  it("gives up after its bounded retries and leaves everything registered", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(unknown);
    const lifecycle = lifecycleWith(source);
    const session = await lifecycle.open("long-lived");
    const { client } = await connect(session.server);
    await wait(100);
    expect(source).toHaveBeenCalledTimes(4); // start-up + immediate retry + two delayed retries
    expect((await client.listTools()).tools).toHaveLength(46);
    await client.close();
    await session.close();
  });

  it("stop() cancels pending retries", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(unknown);
    const lifecycle = createServerLifecycle({ config: getConfig(), availability: source, retryDelaysMs: [30, 30], retryTimeoutMs: 5 });
    const session = await lifecycle.open("long-lived");
    await wait(5);
    lifecycle.stop();
    const calls = source.mock.calls.length;
    await wait(100);
    expect(source).toHaveBeenCalledTimes(calls);
    await session.close();
  });

  it("closing the session cancels its retries", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(unknown);
    const lifecycle = createServerLifecycle({ config: getConfig(), availability: source, retryDelaysMs: [30, 30], retryTimeoutMs: 5 });
    const session = await lifecycle.open("long-lived");
    await wait(5);
    await session.close();
    const calls = source.mock.calls.length;
    await wait(100);
    expect(source).toHaveBeenCalledTimes(calls);
  });
});

describe("per-request sessions (HTTP)", () => {
  it("resolves per call and never schedules retries", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(unknown);
    const lifecycle = lifecycleWith(source);
    const first = await lifecycle.open("per-request");
    const second = await lifecycle.open("per-request");
    await wait(60);
    expect(source).toHaveBeenCalledTimes(2);
    await first.close();
    await second.close();
  });
});

describe("start-up logging", () => {
  const registeredLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([message]) => message === "tools registered");

  it("logs what was registered once for a long-lived server, and never per HTTP request", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const lifecycle = lifecycleWith(vi.fn<AvailabilitySource>().mockResolvedValue(known("tickets")));

    const sessions = [await lifecycle.open("per-request"), await lifecycle.open("per-request"), await lifecycle.open("per-request")];
    expect(registeredLogs(info)).toHaveLength(0);
    expect(sessions[0]!.registration).toMatchObject({ registered: expect.any(Number) });

    const longLived = await lifecycle.open("long-lived");
    expect(registeredLogs(info)).toHaveLength(1);

    for (const session of [...sessions, longLived]) await session.close();
    info.mockRestore();
  });
});

describe("gating off", () => {
  it("never consults the source and registers everything", async () => {
    setEnv({ TDX_APP_GATING: "off" });
    const source = vi.fn<AvailabilitySource>();
    const lifecycle = lifecycleWith(source);
    const session = await lifecycle.open("long-lived");
    const { client } = await connect(session.server);
    expect((await client.listTools()).tools).toHaveLength(46);
    expect(source).not.toHaveBeenCalled();
    expect(lifecycle.health()).toEqual({ mode: "off", state: "off", gatedCount: 0 });
    await client.close();
    await session.close();
  });
});

describe("health", () => {
  it("reports unknown, then known with a count and no application names", async () => {
    const source = vi.fn<AvailabilitySource>().mockResolvedValue(known("tickets", "projects"));
    const lifecycle = lifecycleWith(source);
    expect(lifecycle.health()).toEqual({ mode: "auto", state: "unknown", gatedCount: 0 });
    const session = await lifecycle.open("per-request");
    expect(lifecycle.health()).toEqual({ mode: "auto", state: "known", gatedCount: 14 });
    await session.close();
  });

  it("stays unknown when the lookup could not complete", async () => {
    const lifecycle = lifecycleWith(vi.fn<AvailabilitySource>().mockResolvedValue(unknown));
    const session = await lifecycle.open("per-request");
    expect(lifecycle.health().state).toBe("unknown");
    await session.close();
  });
});

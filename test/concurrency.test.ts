import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { z } from "zod";
import { resetConfig } from "../src/config.js";
import { CREATE, READ } from "../src/framework/annotations.js";
import { defineTool, registerTools, type AnyToolDefinition } from "../src/framework/defineTool.js";
import { getRecordCache, getSearchCache, resetCaches } from "../src/services/cache.js";
import { getClient, resetClient } from "../src/services/client.js";
import { ticketUrl } from "../src/services/format.js";
import { searchPage } from "../src/services/search.js";
import * as client from "../src/services/client.js";
import { ResponseFormat } from "../src/types.js";

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  delete process.env.TEAMDYNAMIX_READ_ONLY;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetCaches();
  resetClient();
}

/** Holds every request open until released, so concurrency is observable. */
function stubSlowTransport() {
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
  const releases: Array<(value: unknown) => void> = [];
  const request = vi.fn(
    async () =>
      new Promise((resolve) => {
        releases.push((data) => resolve({ status: 200, data }));
      })
  );
  vi.spyOn(axios, "create").mockReturnValue({
    request,
    post: vi.fn(async () => ({ status: 200, data: jwt })),
  } as unknown as ReturnType<typeof axios.create>);
  return { request, releaseAll: (data: unknown) => releases.forEach((release) => release(data)) };
}

describe("request de-duplication", () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    vi.restoreAllMocks();
    resetClient();
  });

  it("never coalesces concurrent writes, so two creates are two records", async () => {
    const transport = stubSlowTransport();
    const body = { Title: "same title" };
    const first = getClient().request("/49/tickets", { method: "POST", data: body });
    const second = getClient().request("/49/tickets", { method: "POST", data: body });
    await new Promise((resolve) => setImmediate(resolve));
    transport.releaseAll({ ID: 1 });
    await Promise.all([first, second]);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("still coalesces concurrent identical reads", async () => {
    const transport = stubSlowTransport();
    const reads = [getClient().request("/49/tickets/1"), getClient().request("/49/tickets/1")];
    await new Promise((resolve) => setImmediate(resolve));
    transport.releaseAll({ ID: 1 });
    await Promise.all(reads);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent identical searches, which opt in explicitly", async () => {
    const transport = stubSlowTransport();
    const args = { limit: 5, offset: 0 };
    const searches = [
      searchPage("/49/tickets/search", { SearchText: "vpn" }, args),
      searchPage("/49/tickets/search", { SearchText: "vpn" }, args),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    transport.releaseAll([]);
    await Promise.all(searches);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
});

describe("ticketUrl", () => {
  afterEach(() => resetConfig());

  it("builds a TDNext link for a sandbox base URL", () => {
    setEnv({ TEAMDYNAMIX_BASE_URL: "https://sandbox.teamdynamix.com/SBTDWebApi" });
    expect(ticketUrl(671, 12345)).toBe(
      "https://sandbox.teamdynamix.com/SBTDNext/Apps/671/Tickets/TicketDet.aspx?TicketID=12345"
    );
  });

  it("builds a TDNext link for a production base URL", () => {
    setEnv({ TEAMDYNAMIX_BASE_URL: "https://example.teamdynamix.com" });
    expect(ticketUrl(49, 12)).toBe("https://example.teamdynamix.com/TDNext/Apps/49/Tickets/TicketDet.aspx?TicketID=12");
  });
});

describe("write invalidation via tool metadata", () => {
  const Input = z.object({ app_id: z.number().optional(), response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN) });

  function register(definitions: AnyToolDefinition[]) {
    const captured = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
        captured.set(name, handler);
      },
    } as unknown as Parameters<typeof registerTools>[0];
    registerTools(server, definitions);
    return captured;
  }

  beforeEach(() => setEnv());

  it("purges the written app's searches and records but leaves other apps alone", async () => {
    const tool = defineTool({
      name: "writer",
      title: "Writer",
      description: "Writes.",
      input: Input,
      annotations: CREATE,
      invalidates: { domain: "tickets", appIdFrom: (args) => args.app_id },
      handler: async () => ({ ok: true }),
      render: () => "done",
    });

    getSearchCache().set("/49/tickets/search?a=1", { items: [] }, 60_000);
    getRecordCache().set("/49/tickets/7", { ID: 7 }, 60_000);
    getSearchCache().set("/50/tickets/search?a=1", { items: [] }, 60_000);

    await register([tool]).get("writer")!({ app_id: 49, response_format: ResponseFormat.MARKDOWN });

    expect(getSearchCache().get("/49/tickets/search?a=1")).toBeUndefined();
    expect(getRecordCache().get("/49/tickets/7")).toBeUndefined();
    expect(getSearchCache().get("/50/tickets/search?a=1")).toBeDefined();
  });

  it("purges org-wide domains that carry no app id", async () => {
    const tool = defineTool({
      name: "org_writer",
      title: "Org writer",
      description: "Writes.",
      input: Input,
      annotations: CREATE,
      invalidates: { domain: "projects" },
      handler: async () => ({ ok: true }),
      render: () => "done",
    });

    getSearchCache().set("/projects/search?a=1", { items: [] }, 60_000);
    await register([tool]).get("org_writer")!({ response_format: ResponseFormat.MARKDOWN });
    expect(getSearchCache().get("/projects/search?a=1")).toBeUndefined();
  });

  it("leaves caches untouched when the write fails", async () => {
    const tool = defineTool({
      name: "failing_writer",
      title: "Failing writer",
      description: "Writes.",
      input: Input,
      annotations: CREATE,
      invalidates: { domain: "tickets", appIdFrom: (args) => args.app_id },
      handler: async () => {
        throw new Error("upstream refused");
      },
      render: () => "done",
    });

    getSearchCache().set("/49/tickets/search?a=1", { items: [] }, 60_000);
    await register([tool]).get("failing_writer")!({ app_id: 49, response_format: ResponseFormat.MARKDOWN });
    expect(getSearchCache().get("/49/tickets/search?a=1")).toBeDefined();
  });

  it("does not purge for read tools", async () => {
    const tool = defineTool({
      name: "reader",
      title: "Reader",
      description: "Reads.",
      input: Input,
      annotations: READ,
      handler: async () => ({ ok: true }),
      render: () => "done",
    });

    getSearchCache().set("/49/tickets/search?a=1", { items: [] }, 60_000);
    await register([tool]).get("reader")!({ app_id: 49, response_format: ResponseFormat.MARKDOWN });
    expect(getSearchCache().get("/49/tickets/search?a=1")).toBeDefined();
  });
});

describe("tdRequest passthrough", () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it("exposes the dedupe flag so searches can opt in", async () => {
    const spy = vi.spyOn(client, "tdRequest").mockResolvedValue([]);
    await searchPage("/49/tickets/search", {}, { limit: 5, offset: 0 });
    expect(spy.mock.calls[0][1]).toMatchObject({ dedupe: true, method: "POST" });
  });
});

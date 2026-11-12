import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { tdRequest } from "../src/services/client.js";
import { allTools } from "../src/tools/index.js";
import { mountTools } from "./helpers/mountTools.js";

vi.mock("../src/services/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/client.js")>();
  return { ...actual, tdRequest: vi.fn() };
});
const tdRequestMock = vi.mocked(tdRequest);

type Result = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type Call = { endpoint: string; options?: { method?: string; data?: unknown; params?: unknown } };

const EXISTING = { ID: 1, Untouched: "keep", Title: "old", Name: "old" };

function setEnv(): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  process.env.TDX_ALLOW_CAPABILITIES = "read,create,edit,destroy";
  resetConfig();
}

function handlers(): Map<string, Handler> {
  const captured = new Map<string, Handler>();
  mountTools(
    { registerTool: (name: string, _config: unknown, handler: Handler) => void captured.set(name, handler) },
    allTools
  );
  return captured;
}

function calls(): Call[] {
  return tdRequestMock.mock.calls.map(([endpoint, options]) => ({ endpoint, options }));
}

const writes = () => calls().filter((call) => call.options?.method && call.options.method !== "GET");

beforeEach(() => {
  tdRequestMock.mockReset();
  tdRequestMock.mockImplementation(async (endpoint: string, options?: { method?: string; data?: unknown }) => {
    if (options?.method && options.method !== "GET") return { ID: 1, ...(options.data as object) } as never;
    if (endpoint === "/people/lookup") {
      return [{ UID: "uid-from-lookup", FullName: "Pat Person", PrimaryEmail: "person@example.edu" }] as never;
    }
    return EXISTING as never;
  });
  setEnv();
});

afterEach(() => {
  delete process.env.TDX_ALLOW_CAPABILITIES;
  resetConfig();
});

describe("read-modify-write tools keep fields they were not asked to change", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; method: string; changed: Record<string, unknown> }> = [
    {
      tool: "tdx_edit_ticket_task",
      args: { app_id: 49, ticket_id: 7, task_id: 3, title: "new" },
      method: "PUT",
      changed: { Title: "new" },
    },
    {
      tool: "tdx_edit_ci",
      args: { app_id: 49, ci_id: 7, name: "new" },
      method: "PUT",
      changed: { Name: "new" },
    },
    {
      tool: "tdx_edit_issue",
      args: { app_id: 49, project_id: 5, issue_id: 7, title: "new" },
      method: "POST",
      changed: { Title: "new" },
    },
  ];

  it.each(cases)("$tool sends the whole record back with only the requested change", async ({ tool, args, method, changed }) => {
    const result = await handlers().get(tool)!(args);
    expect(result.isError).toBeFalsy();
    const [write] = writes();
    expect(write?.options?.method).toBe(method);
    expect(write?.options?.data).toMatchObject({ Untouched: "keep", ...changed });
  });

  it.each(cases)("$tool refuses an empty edit without any request", async ({ tool, args }) => {
    const empty = Object.fromEntries(Object.entries(args).filter(([key]) => key.endsWith("_id")));
    const result = await handlers().get(tool)!(empty);
    expect(result.isError).toBe(true);
    expect(tdRequestMock).not.toHaveBeenCalled();
  });

  it("covers every read-modify-write tool in the catalog", () => {
    const flagged = allTools.filter((tool) => tool.readModifyWrite).map((tool) => tool.name).sort();
    expect(cases.map((entry) => entry.tool).sort()).toEqual(flagged);
  });
});

describe("patch tools send only the fields that were given", () => {
  const cases = [
    { tool: "tdx_edit_ticket", args: { app_id: 49, ticket_id: 7, title: "new" }, path: "/Title", endpoint: "/49/tickets/7" },
    { tool: "tdx_edit_asset", args: { app_id: 49, asset_id: 7, name: "new" }, path: "/Name", endpoint: "/49/assets/7" },
    { tool: "tdx_edit_project", args: { project_id: 7, name: "new" }, path: "/Name", endpoint: "/projects/7" },
  ];

  it.each(cases)("$tool sends one replace operation", async ({ tool, args, path, endpoint }) => {
    const result = await handlers().get(tool)!(args);
    expect(result.isError).toBeFalsy();
    const [write] = writes();
    expect(write?.endpoint).toBe(endpoint);
    expect(write?.options?.method).toBe("PATCH");
    expect(write?.options?.data).toEqual([{ op: "replace", path, value: "new" }]);
  });

  it.each(cases)("$tool rejects an empty edit without any request", async ({ tool, args }) => {
    const empty = Object.fromEntries(Object.entries(args).filter(([key]) => key.endsWith("_id")));
    const result = await handlers().get(tool)!(empty);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/At least one field/);
    expect(tdRequestMock).not.toHaveBeenCalled();
  });
});

describe("create tools leave omitted fields out", () => {
  it("tdx_create_ticket sends only the required fields", async () => {
    await handlers().get("tdx_create_ticket")!({ app_id: 49, title: "Printer", type_id: 12 });
    const [write] = writes();
    expect(write?.endpoint).toBe("/49/tickets");
    expect(write?.options?.data).toEqual({ Title: "Printer", TypeID: 12 });
  });
});

describe("email arguments are resolved before the write", () => {
  it("sends the looked-up UID, never the email", async () => {
    await handlers().get("tdx_create_ticket")!({
      app_id: 49,
      title: "Printer",
      type_id: 12,
      responsible_uid: "person@example.edu",
    });
    const [write] = writes();
    expect(write?.options?.data).toEqual({ Title: "Printer", TypeID: 12, ResponsibleUid: "uid-from-lookup" });
    expect(JSON.stringify(write?.options?.data)).not.toContain("person@example.edu");
  });
});

describe("get_person", () => {
  it("encodes the uid in the request path and the cache key", async () => {
    await handlers().get("tdx_get_person")!({ uid: "a/b" });
    const [call] = calls();
    expect(call?.endpoint).toBe("/people/a%2Fb");
    expect((call?.options as { cacheKey?: string } | undefined)?.cacheKey).toBe("/people/a%2Fb");
  });
});

describe("ticket search open/closed filter", () => {
  it("sends status class IDs and never the ignored IsOpen field", async () => {
    tdRequestMock.mockResolvedValue([] as never);
    const search = handlers().get("tdx_search_tickets")!;
    await search({ app_id: 49, is_open: true, limit: 5, offset: 0, count_only: false, sort_order: "desc", verbosity: "full", response_format: "markdown" });
    const body = (calls().find((call) => call.endpoint === "/49/tickets/search")?.options as { data: Record<string, unknown> }).data;
    expect(body.StatusClassIDs).toEqual([1, 2, 5, 6]);
    expect(body).not.toHaveProperty("IsOpen");
  });

  it("rejects is_open together with status_classes before any request", async () => {
    const search = handlers().get("tdx_search_tickets")!;
    const result = await search({ app_id: 49, is_open: true, status_classes: ["new"], limit: 5, offset: 0, count_only: false, sort_order: "desc", verbosity: "full", response_format: "markdown" });
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });
});

describe("ticket search extra filters", () => {
  const base = { app_id: 49, limit: 5, offset: 0, count_only: false, sort_order: "desc", verbosity: "full", response_format: "markdown" };
  const bodyOf = () => (calls().find((call) => call.endpoint === "/49/tickets/search")?.options as { data: Record<string, unknown> }).data;

  it("maps each filter to its TicketSearch property", async () => {
    tdRequestMock.mockResolvedValue([] as never);
    await handlers().get("tdx_search_tickets")!({
      ...base,
      closed_date_from: "2026-01-01",
      closed_date_to: "2026-02-01",
      is_on_hold: true,
      location_ids: [3],
    });
    expect(bodyOf()).toMatchObject({
      ClosedDateFrom: "2026-01-01",
      ClosedDateTo: "2026-02-01",
      IsOnHold: true,
      LocationIDs: [3],
    });
  });

  it("rejects is_on_hold together with a status class filter", async () => {
    const result = await handlers().get("tdx_search_tickets")!({ ...base, is_on_hold: true, is_open: true });
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(0);
  });
});

describe("run_saved_search", () => {
  it("pages on the server with a Page object and renders compact rows for the domain", async () => {
    tdRequestMock.mockResolvedValue({ Results: [{ ID: 5, Title: "VPN down", StatusName: "New", PriorityName: "High" }], TotalCount: 1 } as never);
    const run = handlers().get("tdx_run_saved_search")!;
    const result = await run({ app_id: 49, domain: "tickets", search_id: 9, limit: 25, offset: 0, count_only: false, response_format: "markdown" });
    const request = calls().find((call) => call.endpoint === "/49/tickets/searches/9/results")!;
    expect(request.options).toMatchObject({ method: "POST", data: { Page: { PageIndex: 0, PageSize: 25 } } });
    expect(result.content[0]!.text).toContain("**#5** VPN down");
    expect(result.content[0]!.text).toContain("Found 1 result(s)");
  });
});

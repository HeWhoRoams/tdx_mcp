import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetConfig } from "../src/config.js";
import { READ, EDIT } from "../src/framework/annotations.js";
import { defineTool, ToolInputError, type AnyToolDefinition } from "../src/framework/defineTool.js";
import { ResponseFormat } from "../src/types.js";
import { mountTools } from "./helpers/mountTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}>;

interface Captured {
  name: string;
  config: { title: string; description: string; annotations: Record<string, boolean> };
  handler: Handler;
}

function fakeServer(captured: Captured[]) {
  return {
    registerTool(name: string, config: Captured["config"], handler: Handler) {
      captured.push({ name, config, handler });
    },
  };
}

const Input = z.object({ value: z.string(), response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN) });

const readTool = defineTool({
  name: "read_thing",
  title: "Read Thing",
  description: "Reads a thing.",
  input: Input,
  annotations: READ,
  handler: async (args) => ({ items: [{ id: 1, value: args.value }], total: 3 }),
  render: (data) => `# Things\n${data.items.length} shown`,
});

const emptyTool = defineTool({
  name: "empty_thing",
  title: "Empty Thing",
  description: "Returns nothing.",
  input: Input,
  annotations: READ,
  handler: async () => ({ items: [] as unknown[] }),
  isEmpty: (data) => data.items.length === 0,
  emptyMessage: "Nothing here.",
  render: () => "unreachable",
});

const writeTool = defineTool({
  name: "write_thing",
  title: "Write Thing",
  description: "Changes a thing.",
  input: Input,
  annotations: EDIT,
  handler: async () => ({ ok: true }),
  render: () => "done",
});

const failingTool = defineTool({
  name: "failing_thing",
  title: "Failing Thing",
  description: "Always rejects its input.",
  input: Input,
  annotations: READ,
  handler: async () => {
    throw new ToolInputError("At least one field is required.");
  },
  render: () => "unreachable",
});

const ALL: AnyToolDefinition[] = [readTool, emptyTool, writeTool, failingTool];

function setEnv(readOnly: boolean): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  process.env.TEAMDYNAMIX_READ_ONLY = readOnly ? "true" : "false";
  // The shipped policy denies the edit tier, which these cases are not testing.
  process.env.TDX_ALLOW_CAPABILITIES = "read,create,edit,destroy";
  delete process.env.TRANSPORT;
  delete process.env.HOST;
  resetConfig();
}

function register(readOnly = false): Captured[] {
  setEnv(readOnly);
  const captured: Captured[] = [];
  mountTools(fakeServer(captured), ALL);
  return captured;
}

function tool(captured: Captured[], name: string): Captured {
  const found = captured.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} was not registered`);
  return found;
}

describe("mounting tools", () => {
  beforeEach(() => setEnv(false));

  it("registers every tool with its annotations and description", () => {
    const captured = register();
    expect(captured.map((entry) => entry.name)).toEqual(["read_thing", "empty_thing", "write_thing", "failing_thing"]);
    expect(tool(captured, "write_thing").config.annotations.readOnlyHint).toBe(false);
  });

  it("does not leak the internal capability tier into the client annotations", () => {
    const captured = register();
    expect(tool(captured, "write_thing").config.annotations).not.toHaveProperty("capability");
  });

  it("omits write tools entirely in read-only mode", () => {
    const captured = register(true);
    expect(captured.map((entry) => entry.name)).toEqual(["read_thing", "empty_thing", "failing_thing"]);
  });

  it("keeps every description to three lines or fewer", () => {
    for (const definition of ALL) {
      expect(definition.description.split("\n").length).toBeLessThanOrEqual(3);
    }
  });
});

describe("response format policy", () => {
  it("returns markdown text only, with no duplicated structured payload", async () => {
    const captured = register();
    const result = await tool(captured, "read_thing").handler({ value: "x", response_format: ResponseFormat.MARKDOWN });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("# Things");
    expect(result.structuredContent).toBeUndefined();
  });

  it("returns the payload as JSON text and as structured content for json", async () => {
    const captured = register();
    const result = await tool(captured, "read_thing").handler({ value: "x", response_format: ResponseFormat.JSON });
    const payload = { items: [{ id: 1, value: "x" }], total: 3 };
    // Some clients never show structuredContent to the model, so the text block must carry the data.
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
    expect(result.structuredContent).toEqual(payload);
  });

  it("omits structured content when TDX_STRUCTURED_CONTENT=text", async () => {
    process.env.TDX_STRUCTURED_CONTENT = "text";
    resetConfig();
    try {
      const captured = register();
      const result = await tool(captured, "read_thing").handler({ value: "x", response_format: ResponseFormat.JSON });
      expect(JSON.parse(result.content[0].text).total).toBe(3);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      delete process.env.TDX_STRUCTURED_CONTENT;
      resetConfig();
    }
  });

  it("keeps a large json list under the size limit and says where to continue", async () => {
    const big = defineTool({
      name: "big_list",
      title: "Big List",
      description: "Returns many rows.",
      input: Input,
      annotations: READ,
      handler: async () => ({
        total: 500,
        count: 500,
        offset: 0,
        has_more: false,
        items: Array.from({ length: 500 }, (_, id) => ({ id, text: "t".repeat(200) })),
      }),
      render: () => "unused",
    });
    const captured: Captured[] = [];
    mountTools(fakeServer(captured), [big]);
    const result = await tool(captured, "big_list").handler({ value: "x", response_format: ResponseFormat.JSON });
    expect(result.content[0].text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_offset).toBe(parsed.items.length);
    expect((result.structuredContent as { items: unknown[] }).items).toHaveLength(parsed.items.length);
  });

  it("cuts a long markdown list at a record boundary and says where to continue", async () => {
    const big = defineTool({
      name: "big_markdown",
      title: "Big Markdown",
      description: "Renders many records.",
      input: Input,
      annotations: READ,
      handler: async () => ({ items: Array.from({ length: 400 }, (_, id) => id) }),
      render: (data) => ({
        header: ["# Many", ""],
        blocks: data.items.map((id) => `- record ${id} ${"m".repeat(150)}`),
        separator: "\n",
        offset: 0,
      }),
    });
    const captured: Captured[] = [];
    mountTools(fakeServer(captured), [big]);
    const result = await tool(captured, "big_markdown").handler({ value: "x" });
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(25_000);
    const shown = (text.match(/- record \d+ m+/g) ?? []).length;
    expect(text).toContain(`Showing ${shown} of 400`);
    expect(text).toContain(`offset=${shown}`);
  });

  it("defaults to markdown when no format is supplied", async () => {
    const captured = register();
    const result = await tool(captured, "read_thing").handler({ value: "x" });
    expect(result.structuredContent).toBeUndefined();
  });

  it("short-circuits empty results to a plain message", async () => {
    const captured = register();
    const result = await tool(captured, "empty_thing").handler({ value: "x", response_format: ResponseFormat.JSON });
    expect(result.content[0].text).toBe("Nothing here.");
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("error handling", () => {
  it("renders input errors as actionable messages", async () => {
    const captured = register();
    const result = await tool(captured, "failing_thing").handler({ value: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: At least one field is required.");
  });
});

describe("requestContextOf", () => {
  it("offers progress only when the caller supplied a token", async () => {
    const { requestContextOf } = await import("../src/framework/defineTool.js");
    const send = vi.fn(async () => undefined);
    expect(requestContextOf({ sendNotification: send }).progress).toBeUndefined();
    const context = requestContextOf({ _meta: { progressToken: "t1" }, sendNotification: send });
    context.progress?.("Waiting");
    context.progress?.("Still waiting");
    expect(send).toHaveBeenNthCalledWith(1, { method: "notifications/progress", params: { progressToken: "t1", progress: 1, message: "Waiting" } });
    expect(send.mock.calls[1]?.[0].params.progress).toBe(2);
  });

  it("passes the abort signal through", async () => {
    const { requestContextOf } = await import("../src/framework/defineTool.js");
    const controller = new AbortController();
    expect(requestContextOf({ signal: controller.signal }).signal).toBe(controller.signal);
  });
});

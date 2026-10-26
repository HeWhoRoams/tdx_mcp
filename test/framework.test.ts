import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resetConfig } from "../src/config.js";
import { READ, EDIT } from "../src/framework/annotations.js";
import { defineTool, registerTools, ToolInputError, type AnyToolDefinition } from "../src/framework/defineTool.js";
import { ResponseFormat } from "../src/types.js";

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
  } as unknown as Parameters<typeof registerTools>[0];
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
  registerTools(fakeServer(captured), ALL);
  return captured;
}

function tool(captured: Captured[], name: string): Captured {
  const found = captured.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} was not registered`);
  return found;
}

describe("registerTools", () => {
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

  it("returns structured content plus a short pointer for json", async () => {
    const captured = register();
    const result = await tool(captured, "read_thing").handler({ value: "x", response_format: ResponseFormat.JSON });
    expect(result.structuredContent).toEqual({ items: [{ id: 1, value: "x" }], total: 3 });
    expect(result.content[0].text).toBe("Structured JSON result: 1 of 3 item(s) in structuredContent.");
    expect(result.content[0].text).not.toContain("\"id\"");
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

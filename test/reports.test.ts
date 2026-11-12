import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import * as client from "../src/services/client.js";
import { reportTools } from "../src/tools/reports.js";

const report = {
  Name: "Open by group",
  Columns: [{ DataColumnName: "Group" }, { DataColumnName: "Count" }],
  DataRows: Array.from({ length: 30 }, (_, i) => ({ Group: `G${i}`, Count: i })),
};
const tool = reportTools.find((t) => t.name === "tdx_get_report")!;
const run = (args: Record<string, unknown>) => tool.handler(tool.input.parse({ report_id: 7, ...args }));

beforeEach(() => {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  resetConfig();
  resetCaches();
  vi.spyOn(client, "tdRequest").mockResolvedValue(structuredClone(report) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("get_report", () => {
  it("pages rows and renders a table with headers from column metadata", async () => {
    const page = await run({ limit: 10 });
    expect(page.total).toBe(30);
    expect(page.items).toHaveLength(10);
    expect(page.has_more).toBe(true);
    const text = tool.render(page, tool.input.parse({ report_id: 7, limit: 10 })) as { header: string[]; blocks: string[] };
    expect(text.header.join("\n")).toContain("| Group | Count |");
    expect(text.blocks[0]).toBe("| G0 | 0 |");
  });
  it("follows a cursor to the next page", async () => {
    const first = await run({ limit: 10 });
    const second = await run({ limit: 10, cursor: first.next_cursor });
    expect(second.items[0]).toEqual({ Group: "G10", Count: 10 });
  });
  it("selects a subset of columns and reports unknown ones", async () => {
    const page = await run({ columns: ["count", "Nope"] });
    expect(page.columns).toEqual(["Count"]);
    expect(page.unknown_columns).toEqual(["Nope"]);
  });
  it("counts without returning rows", async () => {
    const page = await run({ count_only: true });
    expect(page.total).toBe(30);
    expect(page.items).toEqual([]);
  });
});

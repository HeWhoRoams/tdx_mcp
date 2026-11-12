import { describe, expect, it } from "vitest";
import { projectItems, projectPage, renderProjectedPage } from "../src/services/fields.js";
import { fitBlocks } from "../src/services/budget.js";
import { paginate } from "../src/types.js";

const rows = [
  { ID: 1, Title: "VPN down", StatusName: "New", Notes: "a|b\nc", Created: "2026-01-02T03:04:05Z" },
  { ID: 2, Title: "Printer", StatusName: "Closed", Notes: "", Created: "2026-01-03T00:00:00Z" },
];

describe("projectItems", () => {
  it("keeps ID plus the requested keys, matching case-insensitively", () => {
    const p = projectItems(rows, ["title", "StatusName"]);
    expect(p.columns).toEqual(["ID", "Title", "StatusName"]);
    expect(p.rows[0]).toEqual({ ID: 1, Title: "VPN down", StatusName: "New" });
    expect(p.unknown).toEqual([]);
  });
  it("reports unknown names with valid examples instead of failing", () => {
    const p = projectItems(rows, ["Title", "Bogus"]);
    expect(p.unknown).toEqual(["Bogus"]);
    expect(p.available).toContain("StatusName");
  });
});

describe("renderProjectedPage", () => {
  it("renders one header row and escapes cells", () => {
    const page = projectPage(paginate(rows, 25, 0), ["Title", "Notes"]);
    const text = fitBlocks(renderProjectedPage("Ticket Search Results", page));
    expect(text).toContain("| ID | Title | Notes |");
    expect(text.match(/\| --- \| --- \| --- \|/g)).toHaveLength(1);
    expect(text).toContain("a\\|b c");
  });
  it("names unknown fields and the sort window caveat", () => {
    const page = projectPage({ ...paginate(rows, 25, 0), sorted_within_window: true }, ["Nope"]);
    const text = fitBlocks(renderProjectedPage("T", page));
    expect(text).toContain("Unknown fields: Nope");
    expect(text).toContain("Sorted within the first matches only");
  });
});

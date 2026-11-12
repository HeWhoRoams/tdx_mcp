import { describe, expect, it } from "vitest";
import { resetConfig } from "../src/config.js";
import { renderRecordDetail } from "../src/services/record.js";
import { renderTicket } from "../src/tools/tickets.js";

// Set at module level: the describe bodies below render records while the suite is collected.
process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
process.env.TEAMDYNAMIX_BEID = "b";
process.env.TEAMDYNAMIX_WS_KEY = "k";
process.env.TDX_TIMEZONE = "America/New_York";
resetConfig();

const LONG = `<p>${"Long description sentence. ".repeat(100)}</p><p>Final line.</p>`;
const ticket = {
  ID: 7,
  Title: "VPN drops",
  StatusName: "New",
  StatusID: 1,
  PriorityName: "Medium",
  PriorityID: 3,
  Description: LONG,
  ResponsibleFullName: "",
  ResponsibleGroupName: "",
  CreatedDate: "2026-11-11T20:22:00Z",
  Attributes: [
    { ID: 101, Name: "Building", Value: "12", ValueText: "Anspach Hall" },
    { ID: 102, Name: "Empty one", Value: "" },
    { ID: 103, Name: "Free text", Value: "<b>bold</b> note" },
  ],
  Uri: "api/49/tickets/7",
  CustomerNumber: 4412,
  ZeroNumber: 0,
  Flag: true,
  OffFlag: false,
  EmptyText: "",
  NoGuid: "00000000-0000-0000-0000-000000000000",
  Nested: { a: 1 },
  LastUpdated: "2026-11-11T21:00:00Z",
};

describe("renderRecordDetail", () => {
  const out = renderRecordDetail(renderTicket(ticket as never, 49, "none"), ticket, { omit: ["ID", "Title", "StatusName", "StatusID", "PriorityName", "PriorityID", "ResponsibleFullName", "ResponsibleGroupName", "CreatedDate"] });

  it("prints the whole description as text", () => {
    expect(out).toContain("### Description");
    expect(out).toContain("Final line.");
    expect(out).not.toContain("<p>");
    expect(out.length).toBeGreaterThan(2_500);
  });

  it("lists populated custom attributes with their IDs and skips empty ones", () => {
    expect(out).toContain("- Building (ID 101): Anspach Hall");
    expect(out).toContain("- Free text (ID 103): bold note");
    expect(out).not.toContain("Empty one");
  });

  it("lists other populated scalar fields and omits noise", () => {
    expect(out).toContain("- CustomerNumber: 4412");
    expect(out).toContain("- Flag: yes");
    expect(out).toContain("- LastUpdated: 2026-11-11 16:00 EST");
    for (const noise of ["ZeroNumber", "OffFlag", "EmptyText", "NoGuid", "Nested", "Uri", "api/49/tickets/7"]) {
      expect(out).not.toContain(noise);
    }
  });

  it("does not repeat fields the headline already shows", () => {
    expect(out).not.toContain("- StatusName");
    expect(out).not.toContain("- CreatedDate");
  });
});

describe("renderTicket", () => {
  it("says Unassigned for empty assignee strings", () => {
    expect(renderTicket(ticket as never, 49)).toContain("**Responsible**: Unassigned");
  });

  it("shortens the description only in the summary form", () => {
    const summary = renderTicket(ticket as never, 49);
    expect(summary).toContain("...");
    expect(summary.length).toBeLessThan(1_200);
    expect(renderTicket(ticket as never, 49, "none")).not.toContain("Description");
  });
});

import { describe, expect, it } from "vitest";
import { ToolInputError } from "../src/framework/defineTool.js";
import { CLOSED_CLASSES, OPEN_CLASSES, STATUS_CLASS_IDS, statusClassFilter } from "../src/services/status-class.js";

describe("statusClassFilter", () => {
  it("expresses is_open as the open classes", () => {
    expect(statusClassFilter({ is_open: true })).toEqual(OPEN_CLASSES.map((name) => STATUS_CLASS_IDS[name]));
  });

  it("expresses is_open=false as the closed classes", () => {
    expect(statusClassFilter({ is_open: false })).toEqual(CLOSED_CLASSES.map((name) => STATUS_CLASS_IDS[name]));
  });

  it("keeps open and closed disjoint and complete", () => {
    const open = OPEN_CLASSES.map((name) => STATUS_CLASS_IDS[name]);
    const closed = CLOSED_CLASSES.map((name) => STATUS_CLASS_IDS[name]);
    expect(open.filter((id) => closed.includes(id))).toEqual([]);
    expect([...open, ...closed].sort()).toEqual(Object.values(STATUS_CLASS_IDS).sort());
  });

  it("sends nothing when neither argument is given", () => {
    expect(statusClassFilter({})).toBeUndefined();
  });

  it("maps named classes and removes duplicates", () => {
    expect(statusClassFilter({ status_classes: ["on_hold", "on_hold"] })).toEqual([STATUS_CLASS_IDS.on_hold]);
  });

  it("rejects both arguments together", () => {
    expect(() => statusClassFilter({ is_open: true, status_classes: ["new"] })).toThrow(ToolInputError);
  });
});

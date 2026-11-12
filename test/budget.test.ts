import { describe, expect, it } from "vitest";
import { childBlocks, fitBlocks, fitPayload } from "../src/services/budget.js";

const block = (n: number, size = 100) => `- record ${n} ${"x".repeat(size)}`;

describe("fitBlocks", () => {
  it("returns everything when it fits", () => {
    const text = fitBlocks({ header: ["# T", ""], blocks: [block(1, 5), block(2, 5)], separator: "\n", more: "_more_", offset: 0 });
    expect(text).toContain("record 1");
    expect(text).toContain("record 2");
    expect(text).toContain("_more_");
    expect(text).not.toContain("size limit");
  });

  it("drops whole blocks and says where to continue", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => block(i));
    const text = fitBlocks({ header: ["# T", ""], blocks, separator: "\n", more: "_more results: offset=50_", offset: 10 }, 1500);
    expect(text.length).toBeLessThanOrEqual(1500);
    const shown = blocks.filter((b) => text.includes(b)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(50);
    // No record is cut: every shown record is intact, and the next one is absent.
    expect(text).not.toContain(blocks[shown]!.slice(0, 20));
    expect(text).toContain(`Showing ${shown} of 50`);
    expect(text).toContain(`offset=${10 + shown}`);
    // The original "more" line would skip the dropped records, so it must not appear.
    expect(text).not.toContain("offset=50");
  });

  it("keeps the start of one oversize record and says so", () => {
    const text = fitBlocks({ header: ["# T", ""], blocks: ["y".repeat(5000)], offset: 0 }, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("was cut at");
  });
});

describe("fitPayload", () => {
  const page = (count: number) => ({
    total: count,
    count,
    offset: 20,
    items: Array.from({ length: count }, (_, i) => ({ ID: i, Title: "t".repeat(200) })),
    has_more: false,
    next_cursor: "stale",
  });

  it("returns small payloads unchanged", () => {
    const data = page(2);
    const fitted = fitPayload(data, 10_000);
    expect(fitted.truncated).toBe(false);
    expect(JSON.parse(fitted.text)).toEqual(data);
    expect(fitted.data).toBe(data);
  });

  it("drops whole items, rewrites paging, and stays valid JSON under the limit", () => {
    const fitted = fitPayload(page(100), 5_000);
    expect(fitted.truncated).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(5_000);
    const parsed = JSON.parse(fitted.text);
    expect(parsed.items.length).toBe(parsed.count);
    expect(parsed.items.length).toBeLessThan(100);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_offset).toBe(20 + parsed.items.length);
    expect(parsed.truncated).toMatchObject({ shown: parsed.items.length, on_page: 100 });
    expect(parsed).not.toHaveProperty("next_cursor");
  });

  it("cuts a payload that cannot be split and withholds structured content", () => {
    const fitted = fitPayload({ Description: "z".repeat(9_000) }, 2_000);
    expect(fitted.data).toBeUndefined();
    expect(fitted.truncated).toBe(true);
    expect(fitted.text).toContain("cannot be split");
  });
});

describe("childBlocks", () => {
  it("adds a paging line only when more exists", () => {
    expect(childBlocks("H", ["a"], { has_more: false, offset: 0 }).more).toBeUndefined();
    expect(childBlocks("H", ["a"], { has_more: true, next_offset: 5, offset: 0 }).more).toContain("offset=5");
  });
});

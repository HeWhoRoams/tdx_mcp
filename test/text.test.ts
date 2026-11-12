import { describe, expect, it } from "vitest";
import { formatDate, renderFeed } from "../src/services/format.js";
import { htmlToText, orElse, present } from "../src/services/text.js";
import { resetConfig } from "../src/config.js";

describe("htmlToText", () => {
  it("passes plain text through unchanged", () => {
    expect(htmlToText("Printer is jammed\nsecond line")).toBe("Printer is jammed\nsecond line");
  });

  it("turns block tags into line breaks and list items into dashes", () => {
    expect(htmlToText("<p>First</p><p>Second<br>third</p><ul><li>a</li><li>b</li></ul>")).toBe("First\nSecond\nthird\n\n- a\n- b");
  });

  it("keeps link addresses and drops other tags", () => {
    expect(htmlToText('See <a href="https://example.edu/kb/1">the article</a> and <b>act</b>.')).toBe(
      "See the article (https://example.edu/kb/1) and act."
    );
  });

  it("decodes named and numeric entities and leaves unknown ones", () => {
    expect(htmlToText("Tom &amp; Jerry&nbsp;&#8212; &#x41; &unknown;")).toBe("Tom & Jerry — A &unknown;");
  });

  it("removes script and style content", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Hi</p><script>alert(1)</script>")).toBe("Hi");
  });

  it("collapses runs of blank lines and spaces", () => {
    expect(htmlToText("<div>a</div><div></div><div></div><div>b   c</div>")).toBe("a\n\nb c");
  });
});

describe("present / orElse", () => {
  it("treats empty and whitespace strings as absent but keeps zero and false", () => {
    expect(present("")).toBe(false);
    expect(present("  ")).toBe(false);
    expect(present(null)).toBe(false);
    expect(present(0)).toBe(true);
    expect(present(false)).toBe(true);
    expect(orElse("", "Unassigned")).toBe("Unassigned");
    expect(orElse("Pat", "Unassigned")).toBe("Pat");
  });
});

describe("formatDate", () => {
  it("prints a sortable date with its time zone", () => {
    process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
    process.env.TEAMDYNAMIX_BEID = "b";
    process.env.TEAMDYNAMIX_WS_KEY = "k";
    process.env.TDX_TIMEZONE = "America/New_York";
    resetConfig();
    try {
      expect(formatDate("2026-11-11T20:22:00Z")).toBe("2026-11-11 15:22 EST");
      expect(formatDate("2026-07-01T16:05:00Z")).toBe("2026-07-01 12:05 EDT");
      expect(formatDate(undefined)).toBe("N/A");
      expect(formatDate("not a date")).toBe("not a date");
    } finally {
      delete process.env.TDX_TIMEZONE;
      resetConfig();
    }
  });
});

describe("renderFeed", () => {
  it("converts HTML bodies, marks private entries and handles empty bodies", () => {
    const rendered = renderFeed(
      "Feed",
      [
        { CreatedByName: "Pat", CreatedDate: "2026-11-11T20:22:00Z", Body: "<p>Rebooted &amp; retested</p>", IsPrivate: true },
        { CreatedByName: "", Body: "" },
      ],
      { has_more: false, offset: 0 }
    );
    expect(rendered.blocks[0]).toContain("(private)");
    expect(rendered.blocks[0]).toContain("Rebooted & retested");
    expect(rendered.blocks[1]).toContain("Unknown");
    expect(rendered.blocks[1]).toContain("(no content)");
  });
});

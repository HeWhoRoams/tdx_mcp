import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_PREFIX, toolName } from "../src/constants.js";
import { LEGACY_TOOL_ALIASES } from "../src/policy/load.js";
import { allTools } from "../src/tools/index.js";
import { allPrompts as prompts } from "../src/prompts/index.js";

const names = allTools.map((tool) => tool.name);
/** Clients prefix names with the server name; the longest prefix seen is about this long. */
const CLIENT_PREFIX = "x".repeat(30);

describe("tool names", () => {
  it("all use the shared prefix", () => {
    expect(toolName("search_tickets")).toBe(`${TOOL_PREFIX}search_tickets`);
    for (const name of names) expect(name.startsWith(TOOL_PREFIX)).toBe(true);
  });

  it("stay within 64 characters after a 30-character client prefix", () => {
    for (const name of names) expect(`${CLIENT_PREFIX}${name}`.length).toBeLessThanOrEqual(64);
  });

  it("are unique", () => {
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("legacy aliases", () => {
  // Added in 4.0.0, so no 3.x policy can name it.
  const NEW_IN_4 = new Set(["tdx_sign_in"]);

  it("map every 3.x name to a registered tool", () => {
    for (const name of names.filter((n) => !NEW_IN_4.has(n))) {
      const old = `teamdynamix_${name.slice(TOOL_PREFIX.length)}`;
      expect(LEGACY_TOOL_ALIASES[old], old).toBe(name);
    }
  });

  it("never point at a tool that does not exist", () => {
    for (const [old, target] of Object.entries(LEGACY_TOOL_ALIASES)) expect(names, old).toContain(target);
  });
});

describe("tool names mentioned in text", () => {
  const mention = /\btdx_[a-z_]+\b/g;
  const known = new Set(names);
  const texts = [
    ...allTools.flatMap((tool) => [tool.description, JSON.stringify(tool.input.shape, (_k, v) => (typeof v === "function" ? undefined : v))]),
    ...prompts.map((prompt) => prompt.description),
    readFileSync(new URL("../src/server.ts", import.meta.url), "utf8"),
  ];

  it("resolve to registered tools", () => {
    const unknown = new Set<string>();
    for (const text of texts) for (const found of text.match(mention) ?? []) if (!known.has(found)) unknown.add(found);
    // Env-style words such as tdx_home are not tool names; only names that look like a tool verb count.
    const suspicious = [...unknown].filter((word) => /^tdx_(search|get|list|create|edit|add|remove|link|run|lookup|sign)_/.test(word));
    expect(suspicious).toEqual([]);
  });
});

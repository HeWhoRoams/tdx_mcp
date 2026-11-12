import { describe, expect, it } from "vitest";
import { ToolPolicyError } from "../src/policy/index.js";
import { LEGACY_TOOL_ALIASES, loadToolPolicy, type PolicyEnv } from "../src/policy/load.js";

const ROOT = "/project";
const DEFAULT_PATH = "/project/config/tool-policy.json";

const env = (overrides: Partial<PolicyEnv> = {}): PolicyEnv => ({ TEAMDYNAMIX_READ_ONLY: false, ...overrides });

function files(map: Record<string, string>) {
  return (path: string): string => {
    const content = map[path.replace(/\\/g, "/")];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  };
}

const load = (e: PolicyEnv, map: Record<string, string> = {}) =>
  loadToolPolicy({ env: e, projectRoot: ROOT, readFile: files(map) });

describe("loadToolPolicy", () => {
  it("uses the built-in defaults when the default file is absent", () => {
    const policy = load(env());
    expect(policy.source).toBe("built-in defaults");
    expect(policy.defaults).toMatchObject({ read: "allow", create: "allow", edit: "deny", destroy: "deny" });
  });

  it("reads the default file from the project root", () => {
    const policy = load(env(), { [DEFAULT_PATH]: JSON.stringify({ defaults: { edit: "allow" } }) });
    expect(policy.defaults.edit).toBe("allow");
    expect(policy.source.replace(/\\/g, "/")).toBe(DEFAULT_PATH);
  });

  it("resolves a relative explicit path against the project root", () => {
    const policy = load(env({ TDX_TOOL_POLICY_FILE: "custom/p.json" }), {
      "/project/custom/p.json": JSON.stringify({ defaults: { destroy: "allow" } }),
    });
    expect(policy.defaults.destroy).toBe("allow");
  });

  it("fails when an explicit file is missing, unlike the default", () => {
    expect(() => load(env({ TDX_TOOL_POLICY_FILE: "nope.json" }))).toThrow(/Could not read tool policy file/);
  });

  it("rejects invalid JSON and schema violations with a readable message", () => {
    expect(() => load(env(), { [DEFAULT_PATH]: "{ not json" })).toThrow(/not valid JSON/);
    const error = (() => {
      try {
        load(env(), { [DEFAULT_PATH]: JSON.stringify({ defaults: { read: "maybe" } }) });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ToolPolicyError);
    expect(error?.message).toMatch(/defaults\.read/);
  });

  it("lets environment overrides win over the file", () => {
    const policy = load(
      env({
        TDX_ALLOW_CAPABILITIES: "read",
        TDX_DENY_TOOLS: "a, b",
        TDX_ALLOW_TOOLS: "c",
        TDX_TOOLSETS: "tickets,people",
      }),
      { [DEFAULT_PATH]: JSON.stringify({ defaults: { create: "allow" }, toolsets: ["assets"] }) }
    );
    expect(policy.defaults).toMatchObject({ read: "allow", create: "deny" });
    expect([...policy.denyTools]).toEqual(["a", "b"]);
    expect([...(policy.allowTools ?? [])]).toEqual(["c"]);
    expect([...(policy.toolsets ?? [])]).toEqual(["tickets", "people"]);
  });

  it("rejects unknown toolsets and carries the read-only flag", () => {
    expect(() => load(env({ TDX_TOOLSETS: "tickets,nope" }))).toThrow(ToolPolicyError);
    expect(load(env({ TEAMDYNAMIX_READ_ONLY: true })).readOnly).toBe(true);
  });
});

describe("legacy tool names", () => {
  const OLD_TICKET = "teamdynamix_list_ticket_types";
  const OLD_TICKET_2 = "teamdynamix_list_ticket_statuses";
  const NEW_TICKET = "tdx_get_ticket_reference";

  it("maps every replaced 3.0 lookup to one of the two reference tools", () => {
    const merged = Object.entries(LEGACY_TOOL_ALIASES).filter(([old]) => old.startsWith("teamdynamix_list_"));
    expect(merged.filter(([old]) => !/^teamdynamix_list_(custom_attributes|accounts|locations|reports|saved_searches|applications)/.test(old))).toHaveLength(11);
    expect(new Set(merged.filter(([old]) => /ticket_|asset_statuses|product_models|ci_/.test(old)).map(([, to]) => to))).toEqual(
      new Set([NEW_TICKET, "tdx_get_asset_reference"])
    );
  });

  it("maps a 3.x name to its tdx_ successor, and a deny on it denies that tool", () => {
    expect(LEGACY_TOOL_ALIASES.teamdynamix_search_tickets).toBe("tdx_search_tickets");
    const policy = load(env({ TDX_DENY_TOOLS: "teamdynamix_edit_ticket" }));
    expect([...policy.denyTools]).toEqual(["tdx_edit_ticket"]);
  });

  it("lets a deny on any old name deny the new tool, and warns once per old name", () => {
    const warnings: string[] = [];
    const policy = loadToolPolicy({
      env: env({ TDX_DENY_TOOLS: `${OLD_TICKET}, other_tool` }),
      projectRoot: ROOT,
      readFile: files({}),
      warn: (message) => warnings.push(message),
    });
    expect([...policy.denyTools].sort()).toEqual(["other_tool", NEW_TICKET].sort());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(OLD_TICKET);
    expect(warnings[0]).toContain(NEW_TICKET);
  });

  it("lets an allow list that names an old tool admit its replacement", () => {
    const policy = load(env({ TDX_ALLOW_TOOLS: `${OLD_TICKET},${OLD_TICKET_2},tdx_get_ticket` }));
    expect([...(policy.allowTools ?? [])].sort()).toEqual(["tdx_get_ticket", NEW_TICKET].sort());
  });

  it("folds policy-file tool rules: deny wins, allow applies, inherit is silent", () => {
    const warnings: string[] = [];
    const file = (tools: Record<string, string>) => ({ [DEFAULT_PATH]: JSON.stringify({ tools }) });
    const run = (tools: Record<string, string>) =>
      loadToolPolicy({ env: env(), projectRoot: ROOT, readFile: files(file(tools)), warn: (m) => warnings.push(m) });

    expect(run({ [OLD_TICKET]: "allow", [OLD_TICKET_2]: "deny" }).tools[NEW_TICKET]).toBe("deny");
    expect(run({ [OLD_TICKET]: "allow", [OLD_TICKET_2]: "inherit" }).tools[NEW_TICKET]).toBe("allow");
    expect(run({ [NEW_TICKET]: "deny", [OLD_TICKET]: "allow" }).tools[NEW_TICKET]).toBe("deny");
    warnings.length = 0;
    expect(run({ [OLD_TICKET]: "inherit" }).tools[NEW_TICKET]).toBe("inherit");
    expect(warnings).toEqual([]);
    expect(run({ [OLD_TICKET]: "allow" }).tools[OLD_TICKET]).toBeUndefined();
  });
});

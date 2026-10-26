import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/framework/annotations.js";
import {
  BUILT_IN_DEFAULTS,
  decideTool,
  isToolAllowed,
  resolveToolPolicy,
  ToolPolicyError,
  type PolicySubject,
} from "../src/policy/index.js";
import { allTools } from "../src/tools/index.js";

const POLICY_PATH = fileURLToPath(new URL("../config/tool-policy.json", import.meta.url));

function policyFrom(contents: object) {
  return { policyData: contents, source: "test fixture" };
}

function subject(overrides: Partial<PolicySubject> = {}): PolicySubject {
  return { name: "teamdynamix_edit_ticket", domain: "tickets", capability: "edit", ...overrides };
}

describe("built-in defaults", () => {
  it("denies the destructive tiers so a missing policy file is still safe", () => {
    const policy = resolveToolPolicy(policyFrom({}));
    expect(policy.defaults).toEqual(BUILT_IN_DEFAULTS);
    expect(isToolAllowed(policy, subject({ capability: "read" }))).toBe(true);
    expect(isToolAllowed(policy, subject({ capability: "create" }))).toBe(true);
    expect(isToolAllowed(policy, subject({ capability: "edit" }))).toBe(false);
    expect(isToolAllowed(policy, subject({ capability: "destroy" }))).toBe(false);
  });

  it("ships a config file that matches the built-in defaults", () => {
    const policy = resolveToolPolicy({ readOnly: false });
    expect(policy.defaults).toEqual(BUILT_IN_DEFAULTS);
  });
});

describe("rule precedence", () => {
  it("lets a domain rule override the capability default", () => {
    const policy = resolveToolPolicy({
      ...policyFrom({ domains: { tickets: { edit: "allow" } } }),
      readOnly: false,
    });
    expect(isToolAllowed(policy, subject())).toBe(true);
    expect(isToolAllowed(policy, subject({ domain: "assets", name: "teamdynamix_edit_asset" }))).toBe(false);
  });

  it("lets a tool rule override its domain rule", () => {
    const policy = resolveToolPolicy({
      ...policyFrom({
        domains: { tickets: { edit: "allow" } },
        tools: { teamdynamix_edit_ticket: "deny" },
      }),
      readOnly: false,
    });
    expect(isToolAllowed(policy, subject())).toBe(false);
  });

  it("treats inherit as no opinion", () => {
    const policy = resolveToolPolicy({
      ...policyFrom({
        domains: { tickets: { edit: "allow" } },
        tools: { teamdynamix_edit_ticket: "inherit" },
      }),
      readOnly: false,
    });
    expect(decideTool(policy, subject()).reason).toBe("domains.tickets.edit=allow");
  });

  it("denies via TDX_DENY_TOOLS even when the file allows the tool", () => {
    const policy = resolveToolPolicy({
      ...policyFrom({ tools: { teamdynamix_edit_ticket: "allow" } }),
      denyTools: ["teamdynamix_edit_ticket"],
      readOnly: false,
    });
    expect(decideTool(policy, subject())).toEqual({ allowed: false, reason: "TDX_DENY_TOOLS" });
  });

  it("registers only the listed tools when TDX_ALLOW_TOOLS is set", () => {
    const policy = resolveToolPolicy({ allowTools: ["teamdynamix_edit_ticket"], readOnly: false });
    expect(isToolAllowed(policy, subject())).toBe(true);
    expect(isToolAllowed(policy, subject({ name: "teamdynamix_get_ticket", capability: "read" }))).toBe(false);
  });

  it("replaces the defaults with TDX_ALLOW_CAPABILITIES", () => {
    const policy = resolveToolPolicy({ allowCapabilities: ["read"], readOnly: false });
    expect(policy.defaults).toEqual({ read: "allow", create: "deny", edit: "deny", destroy: "deny" });
  });

  it("collapses everything to read under TEAMDYNAMIX_READ_ONLY", () => {
    const policy = resolveToolPolicy({
      ...policyFrom({ defaults: { edit: "allow", destroy: "allow" } }),
      readOnly: true,
    });
    for (const capability of CAPABILITIES) {
      expect(isToolAllowed(policy, subject({ capability }))).toBe(capability === "read");
    }
    expect(policy.mayModify).toBe(false);
  });
});

describe("read-modify-write escalation", () => {
  const file = { defaults: { edit: "allow" }, treatReadModifyWriteAsDestroy: true };

  it("judges read-modify-write tools under the destroy tier when enabled", () => {
    const policy = resolveToolPolicy({ ...policyFrom(file), readOnly: false });
    expect(isToolAllowed(policy, subject({ readModifyWrite: true }))).toBe(false);
    expect(isToolAllowed(policy, subject())).toBe(true);
  });

  it("leaves them on the edit tier by default", () => {
    const policy = resolveToolPolicy({ ...policyFrom({ defaults: { edit: "allow" } }), readOnly: false });
    expect(isToolAllowed(policy, subject({ readModifyWrite: true }))).toBe(true);
  });
});

describe("invalid policy files", () => {
  it("accepts pre-validated policy data without re-parsing it", () => {
    const policy = resolveToolPolicy({
      policyData: { defaults: { edit: "allow" } },
      source: "explicit validated data",
      readOnly: false,
    });
    expect(policy.defaults.edit).toBe("allow");
  });

  it("rejects invalid policy data at validation time", () => {
    const invalid = { defaults: { edit: "maybe" } };
    expect(() => ToolPolicyFileSchema.safeParse(invalid)).not.toEqual({ success: true });
  });
});

describe("mayModify", () => {
  it("is false when nothing but reads can be permitted", () => {
    const path = policyFrom({ defaults: { create: "deny" } });
    expect(resolveToolPolicy({ ...path, readOnly: false }).mayModify).toBe(false);
  });

  it("stays true for create-only policies, since some create endpoints use PUT", () => {
    expect(resolveToolPolicy({ ...policyFrom({}), readOnly: false }).mayModify).toBe(true);
  });

  it("is true once any rule allows a write tier", () => {
    const path = policyFrom({ defaults: { create: "deny" }, domains: { tickets: { edit: "allow" } } });
    expect(resolveToolPolicy({ ...path, readOnly: false }).mayModify).toBe(true);
  });
});

describe("tool catalog", () => {
  const shipped = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as { tools: Record<string, string> };

  it("lists every registered tool, so npm run policy:sync has been run", () => {
    const missing = allTools.map((tool) => tool.name).filter((name) => shipped.tools[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("lists no tool that no longer exists", () => {
    const known = new Set(allTools.map((tool) => tool.name));
    expect(Object.keys(shipped.tools).filter((name) => !known.has(name))).toEqual([]);
  });

  it("gives every tool a capability and a domain", () => {
    for (const tool of allTools) {
      expect(CAPABILITIES).toContain(tool.annotations.capability);
      expect(tool.domain).toBeDefined();
    }
  });

  it("keeps readOnlyHint consistent with the capability tier", () => {
    for (const tool of allTools) {
      expect(tool.annotations.readOnlyHint).toBe(tool.annotations.capability === "read");
    }
  });

  it("denies every edit and destroy tool under the shipped policy", () => {
    const policy = resolveToolPolicy({ readOnly: false });
    for (const tool of allTools) {
      const capability = tool.annotations.capability;
      const allowed = isToolAllowed(policy, {
        name: tool.name,
        ...(tool.domain ? { domain: tool.domain } : {}),
        capability,
      });
      expect(allowed).toBe(capability === "read" || capability === "create");
    }
  });

  it("keeps ticket comments available while ticket edits are denied", () => {
    const policy = resolveToolPolicy({ readOnly: false });
    expect(isToolAllowed(policy, { name: "teamdynamix_add_ticket_comment", domain: "tickets", capability: "create" })).toBe(
      true
    );
    expect(isToolAllowed(policy, subject())).toBe(false);
  });
});

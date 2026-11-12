import { CAPABILITIES, type Capability } from "../framework/annotations.js";
import { TOOL_DOMAINS, type CapabilityRules, type Rule, type ToolDomain, type ToolPolicyFile } from "./schema.js";

export { TOOL_DOMAINS, type Rule, type ToolDomain } from "./schema.js";

/**
 * Destructive tiers are denied unless a deployment opts back in. A fresh clone
 * and a misconfigured host both land on the safe side.
 */
export const BUILT_IN_DEFAULTS: Record<Capability, Rule> = {
  read: "allow",
  create: "allow",
  edit: "deny",
  destroy: "deny",
};

export interface ToolPolicy {
  defaults: Record<Capability, Rule>;
  domains: Partial<Record<ToolDomain, CapabilityRules>>;
  tools: Record<string, Rule>;
  denyTools: Set<string>;
  /** When present, only these tools may register, regardless of every other rule. */
  allowTools?: Set<string>;
  /**
   * When present, only tools in these domains may register, plus authentication and the reference
   * lookups that serve a listed domain (so a ticket toolset keeps its type, status and priority lists).
   * Narrows access only; it never grants a tier the capability rules deny.
   */
  toolsets?: Set<ToolDomain>;
  treatReadModifyWriteAsDestroy: boolean;
  readOnly: boolean;
  source: string;
  /** True when some rule could permit a record-changing tool; used as a transport-level guard. */
  mayModify: boolean;
}

export interface PolicySubject {
  name: string;
  domain?: ToolDomain;
  capability: Capability;
  readModifyWrite?: boolean;
  /** Reference lookups: the domains they serve. Unset on a reference tool means a generic lookup. */
  serves?: ToolDomain[];
}

export class ToolPolicyError extends Error {}

export interface PolicyInput {
  policyData?: Partial<ToolPolicyFile>;
  source?: string;
  allowCapabilities?: string[];
  allowTools?: string[];
  denyTools?: string[];
  /** From TDX_TOOLSETS; overrides the policy file's `toolsets`. */
  toolsets?: string[];
  readOnly: boolean;
}

export function resolveToolPolicy(input: PolicyInput): ToolPolicy {
  const file = input.policyData ?? {};
  const source = input.source ?? "built-in defaults";

  const defaults = { ...BUILT_IN_DEFAULTS };
  for (const capability of CAPABILITIES) {
    const rule = file.defaults?.[capability];
    if (rule && rule !== "inherit") defaults[capability] = rule;
  }
  if (input.allowCapabilities?.length) {
    const allowed = new Set(input.allowCapabilities);
    for (const capability of CAPABILITIES) {
      defaults[capability] = allowed.has(capability) ? "allow" : "deny";
    }
  }

  const toolsets = parseToolsets(input.toolsets?.length ? input.toolsets : file.toolsets);

  const policy: ToolPolicy = {
    defaults,
    domains: (file.domains ?? {}) as Partial<Record<ToolDomain, CapabilityRules>>,
    tools: file.tools ?? {},
    denyTools: new Set(input.denyTools ?? []),
    ...(input.allowTools?.length ? { allowTools: new Set(input.allowTools) } : {}),
    ...(toolsets ? { toolsets } : {}),
    treatReadModifyWriteAsDestroy: file.treatReadModifyWriteAsDestroy ?? false,
    readOnly: input.readOnly,
    source,
    mayModify: false,
  };
  policy.mayModify = computeMayModify(policy);
  return policy;
}

function parseToolsets(names: readonly string[] | undefined): Set<ToolDomain> | undefined {
  if (!names?.length) return undefined;
  const unknown = names.filter((name) => !(TOOL_DOMAINS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ToolPolicyError(`Unknown toolset(s) ${unknown.join(", ")}; expected any of ${TOOL_DOMAINS.join(", ")}.`);
  }
  return new Set(names as ToolDomain[]);
}

/**
 * Authentication is always available. Reference lookups follow the domains they serve; a lookup that
 * serves none (applications, accounts, locations, custom attributes) is generic and always available.
 */
function inToolsets(toolsets: ReadonlySet<ToolDomain>, subject: PolicySubject): boolean {
  if (subject.domain === undefined || subject.domain === "auth") return true;
  if (toolsets.has(subject.domain)) return true;
  if (subject.domain !== "reference") return false;
  return subject.serves === undefined || subject.serves.length === 0 || subject.serves.some((domain) => toolsets.has(domain));
}

/** The tier a tool is judged under, which read-modify-write can escalate. */
export function effectiveCapability(policy: ToolPolicy, subject: PolicySubject): Capability {
  return policy.treatReadModifyWriteAsDestroy && subject.readModifyWrite ? "destroy" : subject.capability;
}

interface Decision {
  allowed: boolean;
  reason: string;
}

/**
 * Rules are applied most specific first: hard lists, then toolsets, then the per-tool
 * map, then the domain map, then the capability defaults.
 */
export function decideTool(policy: ToolPolicy, subject: PolicySubject): Decision {
  const capability = effectiveCapability(policy, subject);

  if (policy.readOnly && capability !== "read") {
    return { allowed: false, reason: "TEAMDYNAMIX_READ_ONLY=true" };
  }
  if (policy.denyTools.has(subject.name)) {
    return { allowed: false, reason: "TDX_DENY_TOOLS" };
  }
  if (policy.allowTools && !policy.allowTools.has(subject.name)) {
    return { allowed: false, reason: "not in TDX_ALLOW_TOOLS" };
  }
  if (policy.allowTools) {
    return { allowed: true, reason: "TDX_ALLOW_TOOLS" };
  }
  if (policy.toolsets && !inToolsets(policy.toolsets, subject)) {
    return { allowed: false, reason: "not in toolsets" };
  }

  const toolRule = policy.tools[subject.name];
  if (toolRule && toolRule !== "inherit") {
    return { allowed: toolRule === "allow", reason: `tools.${subject.name}=${toolRule}` };
  }

  const domainRule = subject.domain ? policy.domains[subject.domain]?.[capability] : undefined;
  if (domainRule && domainRule !== "inherit") {
    return { allowed: domainRule === "allow", reason: `domains.${subject.domain}.${capability}=${domainRule}` };
  }

  const rule = policy.defaults[capability];
  return { allowed: rule === "allow", reason: `defaults.${capability}=${rule}` };
}

/**
 * Whether any rule could permit a record-changing call. Conservative on purpose:
 * a single explicit tool allow is enough, because the capability of a named tool
 * is not known here.
 */
function computeMayModify(policy: ToolPolicy): boolean {
  if (policy.readOnly) return false;
  if (policy.allowTools) return policy.allowTools.size > 0;
  const writeTiers: Capability[] = ["create", "edit", "destroy"];
  if (writeTiers.some((tier) => policy.defaults[tier] === "allow")) return true;
  for (const rules of Object.values(policy.domains)) {
    if (writeTiers.some((tier) => rules?.[tier] === "allow")) return true;
  }
  return Object.values(policy.tools).some((rule) => rule === "allow");
}

/** One-line summary for the startup log. */
export function summarizePolicy(policy: ToolPolicy): string {
  const tiers = CAPABILITIES.map((capability) => `${capability}=${policy.defaults[capability]}`).join(" ");
  const toolsets = policy.toolsets ? ` toolsets=${[...policy.toolsets].join(",")}` : "";
  return `${tiers}${toolsets} (source: ${policy.source})`;
}

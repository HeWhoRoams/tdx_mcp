import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, type Capability } from "../framework/annotations.js";
import { ToolPolicyFileSchema, type CapabilityRules, type Rule, type ToolDomain } from "./schema.js";

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

/** Resolved from `config/tool-policy.json` unless TDX_TOOL_POLICY_FILE points elsewhere. */
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../config/tool-policy.json", import.meta.url));

export interface ToolPolicy {
  defaults: Record<Capability, Rule>;
  domains: Partial<Record<ToolDomain, CapabilityRules>>;
  tools: Record<string, Rule>;
  denyTools: Set<string>;
  /** When present, only these tools may register, regardless of every other rule. */
  allowTools?: Set<string>;
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
}

export class ToolPolicyError extends Error {}

export interface PolicyInput {
  policyFile?: string;
  allowCapabilities?: string[];
  allowTools?: string[];
  denyTools?: string[];
  readOnly: boolean;
}

function readPolicyFile(path: string, required: boolean): { data: unknown; source: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ToolPolicyError(`Could not read tool policy file at ${path}: ${(error as Error).message}`);
  }
  try {
    return { data: JSON.parse(raw), source: path };
  } catch (error) {
    throw new ToolPolicyError(`Tool policy file at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export function resolveToolPolicy(input: PolicyInput): ToolPolicy {
  const explicit = input.policyFile !== undefined && input.policyFile.trim() !== "";
  const path = explicit ? input.policyFile!.trim() : DEFAULT_POLICY_PATH;
  const loaded = readPolicyFile(path, explicit);

  let file: ReturnType<typeof ToolPolicyFileSchema.parse> = {};
  if (loaded) {
    const parsed = ToolPolicyFileSchema.safeParse(loaded.data);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new ToolPolicyError(`Invalid tool policy file at ${path}:\n${details.join("\n")}`);
    }
    file = parsed.data;
  }

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

  const policy: ToolPolicy = {
    defaults,
    domains: (file.domains ?? {}) as Partial<Record<ToolDomain, CapabilityRules>>,
    tools: file.tools ?? {},
    denyTools: new Set(input.denyTools ?? []),
    ...(input.allowTools?.length ? { allowTools: new Set(input.allowTools) } : {}),
    treatReadModifyWriteAsDestroy: file.treatReadModifyWriteAsDestroy ?? false,
    readOnly: input.readOnly,
    source: loaded ? loaded.source : "built-in defaults",
    mayModify: false,
  };
  policy.mayModify = computeMayModify(policy);
  return policy;
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
 * Rules are applied most specific first: hard lists, then the per-tool map, then
 * the domain map, then the capability defaults.
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

export function isToolAllowed(policy: ToolPolicy, subject: PolicySubject): boolean {
  return decideTool(policy, subject).allowed;
}

export function explainToolPolicy(policy: ToolPolicy, subject: PolicySubject): string {
  const decision = decideTool(policy, subject);
  return `${subject.name}: ${decision.allowed ? "allowed" : "denied"} by ${decision.reason}`;
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
  return `${tiers} (source: ${policy.source})`;
}

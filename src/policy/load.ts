import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveToolPolicy, ToolPolicyError, type ToolPolicy } from "./index.js";
import { ToolPolicyFileSchema, type ToolPolicyFile } from "./schema.js";

/** The already-validated environment values that shape the tool policy. */
export interface PolicyEnv {
  /** TDX_TOOL_POLICY_FILE: an explicit file, resolved against the project root. */
  TDX_TOOL_POLICY_FILE?: string | undefined;
  /** Comma-separated lists. */
  TDX_ALLOW_CAPABILITIES?: string | undefined;
  TDX_ALLOW_TOOLS?: string | undefined;
  TDX_DENY_TOOLS?: string | undefined;
  TDX_TOOLSETS?: string | undefined;
  TEAMDYNAMIX_READ_ONLY: boolean;
}

/**
 * Tool names that were replaced in 3.0.0 or renamed in 4.0.0. A policy that still names an old tool is translated to
 * the tool that took over, so existing allow lists, deny lists and policy files keep their meaning.
 * Every 3.x name (`teamdynamix_*`) maps to its `tdx_*` successor; a test keeps the list complete.
 * Several old names can map to one new tool: a deny on any of them denies it.
 */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = {
  teamdynamix_list_ticket_types: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_statuses: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_priorities: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_sources: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_forms: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_impacts: "tdx_get_ticket_reference",
  teamdynamix_list_ticket_urgencies: "tdx_get_ticket_reference",
  teamdynamix_list_asset_statuses: "tdx_get_asset_reference",
  teamdynamix_list_product_models: "tdx_get_asset_reference",
  teamdynamix_list_ci_types: "tdx_get_asset_reference",
  teamdynamix_list_ci_relationship_types: "tdx_get_asset_reference",
  // 4.0.0: the prefix changed from teamdynamix_ to tdx_.
  teamdynamix_add_asset_comment: "tdx_add_asset_comment",
  teamdynamix_add_ci_comment: "tdx_add_ci_comment",
  teamdynamix_add_ci_relationship: "tdx_add_ci_relationship",
  teamdynamix_add_group_members: "tdx_add_group_members",
  teamdynamix_add_project_comment: "tdx_add_project_comment",
  teamdynamix_add_ticket_comment: "tdx_add_ticket_comment",
  teamdynamix_create_asset: "tdx_create_asset",
  teamdynamix_create_ci: "tdx_create_ci",
  teamdynamix_create_issue: "tdx_create_issue",
  teamdynamix_create_project: "tdx_create_project",
  teamdynamix_create_ticket: "tdx_create_ticket",
  teamdynamix_create_ticket_task: "tdx_create_ticket_task",
  teamdynamix_edit_asset: "tdx_edit_asset",
  teamdynamix_edit_ci: "tdx_edit_ci",
  teamdynamix_edit_issue: "tdx_edit_issue",
  teamdynamix_edit_project: "tdx_edit_project",
  teamdynamix_edit_ticket: "tdx_edit_ticket",
  teamdynamix_edit_ticket_task: "tdx_edit_ticket_task",
  teamdynamix_get_asset: "tdx_get_asset",
  teamdynamix_get_asset_feed: "tdx_get_asset_feed",
  teamdynamix_get_asset_reference: "tdx_get_asset_reference",
  teamdynamix_get_ci: "tdx_get_ci",
  teamdynamix_get_ci_feed: "tdx_get_ci_feed",
  teamdynamix_get_ci_relationships: "tdx_get_ci_relationships",
  teamdynamix_get_current_user: "tdx_get_current_user",
  teamdynamix_get_group: "tdx_get_group",
  teamdynamix_get_group_members: "tdx_get_group_members",
  teamdynamix_get_issue: "tdx_get_issue",
  teamdynamix_get_person: "tdx_get_person",
  teamdynamix_get_person_uid: "tdx_get_person_uid",
  teamdynamix_get_project: "tdx_get_project",
  teamdynamix_get_project_feed: "tdx_get_project_feed",
  teamdynamix_get_report: "tdx_get_report",
  teamdynamix_get_ticket: "tdx_get_ticket",
  teamdynamix_get_ticket_feed: "tdx_get_ticket_feed",
  teamdynamix_get_ticket_reference: "tdx_get_ticket_reference",
  teamdynamix_get_ticket_tasks: "tdx_get_ticket_tasks",
  teamdynamix_link_ci_to_ticket: "tdx_link_ci_to_ticket",
  teamdynamix_list_accounts: "tdx_list_accounts",
  teamdynamix_list_applications: "tdx_list_applications",
  teamdynamix_list_custom_attributes: "tdx_list_custom_attributes",
  teamdynamix_list_locations: "tdx_list_locations",
  teamdynamix_list_reports: "tdx_list_reports",
  teamdynamix_list_saved_searches: "tdx_list_saved_searches",
  teamdynamix_lookup_people: "tdx_lookup_people",
  teamdynamix_remove_ci_relationship: "tdx_remove_ci_relationship",
  teamdynamix_remove_group_members: "tdx_remove_group_members",
  teamdynamix_run_saved_search: "tdx_run_saved_search",
  teamdynamix_search_assets: "tdx_search_assets",
  teamdynamix_search_cis: "tdx_search_cis",
  teamdynamix_search_groups: "tdx_search_groups",
  teamdynamix_search_issues: "tdx_search_issues",
  teamdynamix_search_people: "tdx_search_people",
  teamdynamix_search_projects: "tdx_search_projects",
  teamdynamix_search_tickets: "tdx_search_tickets",
};

export interface PolicySources {
  env: PolicyEnv;
  /** Called once per legacy tool name the policy still uses. */
  warn?: (message: string) => void;
  /** Relative policy paths resolve here, never against the client's working directory. */
  projectRoot: string;
  /** Test seam: reads a file as UTF-8. Defaults to the file system. */
  readFile?: (path: string) => string;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

/** Names in an env list, with legacy names translated and de-duplicated. Returns the legacy names seen. */
function translateList(names: string[], seen: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const replacement = LEGACY_TOOL_ALIASES[name];
    if (replacement) seen.set(name, replacement);
    out.add(replacement ?? name);
  }
  return [...out];
}

/** Per-tool rules from the policy file, with legacy names folded into their replacement (deny wins). */
function translateToolRules(
  tools: Record<string, "allow" | "deny" | "inherit"> | undefined,
  seen: Map<string, string>
): Record<string, "allow" | "deny" | "inherit"> | undefined {
  if (!tools) return tools;
  const out: Record<string, "allow" | "deny" | "inherit"> = {};
  const folded = new Map<string, Array<"allow" | "deny" | "inherit">>();
  for (const [name, rule] of Object.entries(tools)) {
    const replacement = LEGACY_TOOL_ALIASES[name];
    if (!replacement) {
      out[name] = rule;
      continue;
    }
    if (rule !== "inherit") seen.set(name, replacement);
    folded.set(replacement, [...(folded.get(replacement) ?? []), rule]);
  }
  for (const [replacement, rules] of folded) {
    const explicit = out[replacement];
    if (rules.includes("deny")) out[replacement] = "deny";
    else if ((explicit === undefined || explicit === "inherit") && rules.includes("allow")) out[replacement] = "allow";
    else if (explicit === undefined) out[replacement] = "inherit";
  }
  return out;
}

function readPolicyFile(
  path: string,
  required: boolean,
  readFile: (path: string) => string
): { data: Partial<ToolPolicyFile>; source: string } | undefined {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ToolPolicyError(`Could not read tool policy file at ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolPolicyError(`Tool policy file at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const validated = ToolPolicyFileSchema.safeParse(parsed);
  if (!validated.success) {
    const details = validated.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ToolPolicyError(`Invalid tool policy file at ${path}:\n${details.join("\n")}`);
  }
  return { data: validated.data, source: path };
}

/**
 * Reads, validates and resolves the tool policy from the policy file and the environment overrides.
 * An absent default file means the built-in defaults; an absent explicit file, an unreadable or
 * invalid file, or an unknown toolset is an error. Never falls back to something more permissive.
 */
export function loadToolPolicy(sources: PolicySources): ToolPolicy {
  const { env, projectRoot } = sources;
  const readFile = sources.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const explicit = env.TDX_TOOL_POLICY_FILE?.trim();
  const path = explicit ? resolve(projectRoot, explicit) : resolve(projectRoot, "config", "tool-policy.json");
  const loaded = readPolicyFile(path, Boolean(explicit), readFile);

  const legacy = new Map<string, string>();
  const policyData = loaded ? { ...loaded.data } : undefined;
  if (policyData?.tools) policyData.tools = translateToolRules(policyData.tools, legacy)!;
  const allowTools = translateList(splitList(env.TDX_ALLOW_TOOLS), legacy);
  const denyTools = translateList(splitList(env.TDX_DENY_TOOLS), legacy);
  for (const [oldName, newName] of legacy) {
    sources.warn?.(`Tool policy names ${oldName}, which was replaced by ${newName} in 3.0.0. Update the policy to name ${newName}.`);
  }

  return resolveToolPolicy({
    ...(policyData && loaded ? { policyData, source: loaded.source } : {}),
    allowCapabilities: splitList(env.TDX_ALLOW_CAPABILITIES),
    allowTools,
    denyTools,
    toolsets: splitList(env.TDX_TOOLSETS),
    readOnly: env.TEAMDYNAMIX_READ_ONLY,
  });
}

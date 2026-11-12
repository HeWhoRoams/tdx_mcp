import { policySubjectOf, type AnyToolDefinition } from "../framework/defineTool.js";
import { isAvailable, type AppKey, type Availability } from "../policy/availability.js";
import { decideTool, type ToolDomain, type ToolPolicy } from "../policy/index.js";
import type { Catalog } from "./catalog.js";

/**
 * The tool surface: which tools and prompts a server advertises, and why. Pure. It touches no server,
 * no configuration and no network, so every part of the registration story is testable here.
 */

/** How this server signs in, as far as the surface needs to know. */
export interface SurfaceAuth {
  method: string;
  deployment?: string;
}

/** The sign-in facts the surface needs, from a configuration. */
export function surfaceAuthOf(config: { auth: { method: string; deployment?: string } }): SurfaceAuth {
  return { method: config.auth.method, ...(config.auth.deployment ? { deployment: config.auth.deployment } : {}) };
}

/** `unsupported`: the tool cannot work under this sign-in setup, so it is neither gated nor denied. */
export type EntryState = "registered" | "denied" | "hidden" | "unsupported";

export interface SurfaceEntry {
  kind: "tool" | "prompt";
  name: string;
  state: EntryState;
  /** Why: the matching policy rule, the denial, or what is missing. Never an application name. */
  reason: string;
  domain?: ToolDomain;
  requiresApp: AppKey | null;
}

export interface Counts {
  registered: number;
  denied: number;
  hidden: number;
  unsupported: number;
}

export interface Surface {
  /** Tools first, then prompts, each in catalog order. */
  entries: readonly SurfaceEntry[];
  /** Names of the registered entries of a kind, in catalog order. */
  registered(kind: SurfaceEntry["kind"]): string[];
  /** Domains with at least one registered tool. */
  areas: ReadonlySet<ToolDomain>;
  /** Application kinds whose absence hid something that policy allowed. */
  gatedApps: readonly AppKey[];
  counts: Record<SurfaceEntry["kind"], Counts>;
  stateOf(kind: SurfaceEntry["kind"], name: string): EntryState | undefined;
}

function resolveTool(
  definition: AnyToolDefinition,
  policy: ToolPolicy,
  availability: Availability | undefined,
  auth: SurfaceAuth | undefined
): SurfaceEntry {
  const base = {
    kind: "tool" as const,
    name: definition.name,
    requiresApp: definition.requiresApp ?? null,
    ...(definition.domain ? { domain: definition.domain } : {}),
  };
  const decision = decideTool(policy, policySubjectOf(definition));
  if (!decision.allowed) return { ...base, state: "denied", reason: `denied by policy: ${decision.reason}` };
  const needed = definition.requiresAuth;
  if (needed && (auth?.method !== needed.method || auth.deployment !== needed.deployment)) {
    return { ...base, state: "unsupported", reason: `unsupported: needs ${needed.method} sign-in (${needed.deployment})` };
  }
  const gate = availability ? isAvailable(definition, availability) : { available: true as const };
  if (!gate.available) return { ...base, state: "hidden", reason: `hidden: ${gate.reason}` };
  return { ...base, state: "registered", reason: decision.reason };
}

/**
 * Policy decides first. Availability only ever hides a policy-allowed tool, and only when it is
 * known: an unknown result leaves every permitted tool registered. A prompt is offered only when
 * every tool it uses is registered.
 */
export function resolveSurface(
  catalog: Catalog,
  policy: ToolPolicy,
  availability?: Availability,
  auth?: SurfaceAuth
): Surface {
  const tools = catalog.tools.map((definition) => resolveTool(definition, policy, availability, auth));
  const registeredTools = new Set(tools.filter((entry) => entry.state === "registered").map((entry) => entry.name));

  const prompts: SurfaceEntry[] = catalog.prompts.map((prompt) => {
    const missing = prompt.uses.find((name) => !registeredTools.has(name));
    const base = { kind: "prompt" as const, name: prompt.name, requiresApp: null };
    return missing === undefined
      ? { ...base, state: "registered", reason: "every tool it uses is registered" }
      : { ...base, state: "hidden", reason: `hidden: it uses ${missing}, which is not registered` };
  });

  const entries = [...tools, ...prompts];
  const areas = new Set<ToolDomain>();
  const gated = new Set<AppKey>();
  const counts: Surface["counts"] = {
    tool: { registered: 0, denied: 0, hidden: 0, unsupported: 0 },
    prompt: { registered: 0, denied: 0, hidden: 0, unsupported: 0 },
  };
  for (const entry of entries) {
    counts[entry.kind][entry.state] += 1;
    if (entry.kind !== "tool") continue;
    if (entry.state === "registered" && entry.domain) areas.add(entry.domain);
    if (entry.state === "hidden" && entry.requiresApp) gated.add(entry.requiresApp);
  }

  const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.name}`, entry.state]));
  return {
    entries,
    registered: (kind) => entries.filter((entry) => entry.kind === kind && entry.state === "registered").map((entry) => entry.name),
    areas,
    gatedApps: [...gated],
    counts,
    stateOf: (kind, name) => byKey.get(`${kind}:${name}`),
  };
}

/**
 * A misspelled name silently withholds access rather than failing loudly, so report it. Only
 * meaningful against the complete catalog.
 */
export function unknownPolicyNames(catalog: Catalog, policy: ToolPolicy): string[] {
  const known = new Set(catalog.tools.map((definition) => definition.name));
  const named = Object.entries(policy.tools)
    .filter(([, rule]) => rule !== "inherit")
    .map(([name]) => name);
  const referenced = [...named, ...policy.denyTools, ...(policy.allowTools ?? [])];
  return [...new Set(referenced)].filter((name) => !known.has(name));
}

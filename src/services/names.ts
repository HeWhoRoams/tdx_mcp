import { getConfig } from "../config.js";
import { resolveAppId } from "./context.js";
import type { AnyToolDefinition } from "../framework/defineTool.js";
import { appKeyOf, type AppKey } from "../policy/availability.js";
import type { NamedRef } from "../tools/reference.js";
import type { TdApp } from "../types.js";
import { tdRequest } from "./client.js";
import { ToolInputError } from "./errors.js";
import { REFERENCE_TABLES, type ReferenceSpec } from "./reference-kinds.js";

/**
 * Lets arguments take the names people use. An application can be named instead of numbered, and
 * status, priority and type values can be named instead of numbered. Resolution reads cached lists
 * and never guesses: an exact (case-insensitive) match wins, then a single partial match, and
 * anything else is an error that lists the valid choices, so the next call can be right.
 */

const MAX_LISTED = 10;

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function listed(entries: string[]): string {
  const shown = entries.slice(0, MAX_LISTED).join("; ");
  return entries.length > MAX_LISTED ? `${shown}; and ${entries.length - MAX_LISTED} more` : shown;
}

/** Picks the one entry a name refers to: exact first, then a single partial match. */
function pick<T>(entries: T[], nameOf: (entry: T) => string, wanted: string): { match?: T; candidates: T[] } {
  const target = norm(wanted);
  const exact = entries.filter((entry) => norm(nameOf(entry)) === target);
  if (exact.length === 1) return { match: exact[0]! , candidates: exact };
  if (exact.length > 1) return { candidates: exact };
  const partial = entries.filter((entry) => norm(nameOf(entry)).includes(target));
  if (partial.length === 1) return { match: partial[0]!, candidates: partial };
  return { candidates: partial };
}

export async function resolveAppReference(value: number | string, kind: AppKey | null | undefined): Promise<number> {
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());

  const all = await tdRequest<TdApp[]>("/applications", {
    cacheKey: "/applications",
    cacheTtlMs: getConfig().cache.referenceTtlMs,
  });
  const pool = (all ?? []).filter((app) => app.Active !== false && (!kind || appKeyOf(app) === kind));
  const describe = (app: TdApp) => `${app.Name} (${app.AppID})`;
  const { match, candidates } = pick(pool, (app) => app.Name, value);
  if (match) return match.AppID;
  if (candidates.length > 1) {
    throw new ToolInputError(`'${value}' matches several applications: ${listed(candidates.map(describe))}. Use the app_id of the one you mean.`);
  }
  throw new ToolInputError(
    `No application is named '${value}'. ` +
      (pool.length > 0 ? `Available: ${listed(pool.map(describe))}.` : "Call tdx_list_applications to see what exists.")
  );
}

export async function resolveReferenceValue(appId: number, spec: ReferenceSpec, value: number | string): Promise<number> {
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());

  const kind = REFERENCE_TABLES[spec.table][spec.kind]!;
  const endpoint = `/${appId}/${kind.path}`;
  const list = (await tdRequest<NamedRef[]>(endpoint, { cacheKey: endpoint, cacheTtlMs: getConfig().cache.referenceTtlMs })) ?? [];
  const describe = (entry: NamedRef) => `${entry.ID} ${entry.Name}`;
  // Inactive entries match only by their full name, so a partial name never lands on a retired one.
  const active = list.filter((entry) => entry.IsActive !== false);
  const exactAny = list.filter((entry) => norm(entry.Name) === norm(value));
  if (exactAny.length === 1) return exactAny[0]!.ID;
  const { match, candidates } = pick(active, (entry) => entry.Name, value);
  if (match) return match.ID;
  const label = kind.title.toLowerCase();
  if (candidates.length > 1) {
    throw new ToolInputError(`'${value}' matches several ${label}: ${listed(candidates.map(describe))}. Use the ID of the one you mean.`);
  }
  throw new ToolInputError(`No ${label} entry matches '${value}' for application ${appId}. Valid values: ${listed(active.map(describe))}.`);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && !/^\d+$/.test(value.trim());
}

/**
 * Replaces every name in a tool call's arguments with the ID the handler works with, before the
 * handler, its renderer, its cache invalidation and its error hints run. A value that is already an
 * ID costs nothing; only a name reads the (cached) list.
 */
export async function normalizeArgs(definition: AnyToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args };

  if (typeof out.app_id === "string") {
    out.app_id = await resolveAppReference(out.app_id, definition.requiresApp);
  }

  const references = definition.resolve?.reference;
  if (!references) return out;
  const wanted = Object.entries(references).filter(([argument]) => {
    const value = out[argument];
    return Array.isArray(value) ? value.some((entry) => typeof entry === "string") : typeof value === "string";
  });
  if (wanted.length === 0) return out;

  // Names need the application, and so does the default when none was given.
  const appId = resolveAppId(out.app_id as number | string | undefined);
  for (const [argument, spec] of wanted) {
    const value = out[argument];
    if (Array.isArray(value)) {
      out[argument] = await Promise.all(value.map((entry) => (typeof entry === "string" ? resolveReferenceValue(appId, spec, entry) : entry)));
    } else if (isName(value)) {
      out[argument] = await resolveReferenceValue(appId, spec, value as string);
    }
  }
  return out;
}

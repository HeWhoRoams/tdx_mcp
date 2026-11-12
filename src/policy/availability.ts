import { getConfig } from "../config.js";
import { tdRequest } from "../services/client.js";
import { logger } from "../services/logger.js";
import type { TdApp } from "../types.js";
import type { ToolDomain } from "./schema.js";

/**
 * Application availability gating.
 *
 * Availability is NOT authorization. Hiding a tool whose application does not exist only spares the
 * model from advertising tools that cannot work; the tool policy remains the sole security boundary.
 * Everything here therefore fails OPEN: when the application list is unknown, empty, or contains no
 * application of a kind we recognize, every policy-allowed tool stays registered.
 */

/** The application kinds whose absence makes a group of tools useless. */
export const APP_KEYS = ["tickets", "assets", "projects"] as const;
export type AppKey = (typeof APP_KEYS)[number];

/**
 * How each kind appears in /applications. `AppClass` is the stable code; `Type` is a display label
 * ("Asset/CI", not "Assets") and is only a fallback.
 */
const APP_MATCH: Record<AppKey, { appClass: string; types: string[] }> = {
  tickets: { appClass: "tdtickets", types: ["ticketing"] },
  assets: { appClass: "tdassets", types: ["asset/ci", "assets"] },
  projects: { appClass: "tdprojects", types: ["projects"] },
};

/** Human label for a kind, used in instructions and diagnostics. */
export const APP_LABEL: Record<AppKey, string> = {
  tickets: "Ticketing",
  assets: "Asset/CI",
  projects: "Projects",
};

/** The application each domain needs. Domains not listed (people, reports, auth, reference) are never gated. */
export const DOMAIN_REQUIRED_APP: Partial<Record<ToolDomain, AppKey>> = {
  tickets: "tickets",
  assets: "assets",
  cmdb: "assets",
  projects: "projects",
  issues: "projects",
};

export type Availability = { known: true; present: ReadonlySet<AppKey> } | { known: false; reason: string };

/** Which kind an application is, or undefined for kinds that gate nothing (Standard, Client Portal, ...). */
export function appKeyOf(app: Pick<TdApp, "AppClass" | "Type">): AppKey | undefined {
  const appClass = typeof app.AppClass === "string" ? app.AppClass.toLowerCase() : undefined;
  const type = typeof app.Type === "string" ? app.Type.toLowerCase() : undefined;
  for (const key of APP_KEYS) {
    const match = APP_MATCH[key];
    if (appClass === match.appClass) return key;
  }
  for (const key of APP_KEYS) {
    if (type !== undefined && APP_MATCH[key].types.includes(type)) return key;
  }
  return undefined;
}

/**
 * Availability from an application list. Only active applications count. An empty list, or one with
 * no application of a recognized kind, is treated as unknown rather than as "everything is missing".
 */
export function availabilityFromApps(apps: readonly TdApp[] | null | undefined): Availability {
  if (!Array.isArray(apps) || apps.length === 0) return { known: false, reason: "no applications were returned" };
  const present = new Set<AppKey>();
  for (const app of apps) {
    if (app.Active === false) continue;
    const key = appKeyOf(app);
    if (key) present.add(key);
  }
  if (present.size === 0) {
    return { known: false, reason: "no active application of a recognized kind (Ticketing, Asset/CI, Projects) was found" };
  }
  return { known: true, present };
}

/** True when the kind is present, or when availability is unknown (fail open). */
export function hasApp(availability: Availability, key: AppKey): boolean {
  return !availability.known || availability.present.has(key);
}

export function isAvailable(
  definition: { requiresApp?: AppKey | null },
  availability: Availability
): { available: boolean; reason?: string } {
  const key = definition.requiresApp;
  if (!key || hasApp(availability, key)) return { available: true };
  return { available: false, reason: `app:${key} not present` };
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────

/** An unknown result is remembered briefly so a failing lookup is not retried (and waited on) per request. */
const NEGATIVE_TTL_MS = 60_000;

let negativeUntil = 0;
let negativeReason = "";
let lastLoggedKey = "";

/** Test-only: forget cached resolution state. */
export function resetAvailability(): void {
  negativeUntil = 0;
  negativeReason = "";
  lastLoggedKey = "";
}

export interface GetAvailabilityOptions {
  /** How long to wait for the application list. 0 returns immediately unless it is already cached. */
  timeoutMs: number;
  /** Retry even if a recent attempt failed; used by the background retry. */
  bypassNegativeCache?: boolean;
}

/**
 * Resolves which application kinds exist. Never throws and never waits longer than `timeoutMs`;
 * a lookup that outlives the timeout keeps running and warms the shared cache for the next call.
 */
export async function getAvailability(options: GetAvailabilityOptions): Promise<Availability> {
  if (!options.bypassNegativeCache && Date.now() < negativeUntil) return { known: false, reason: negativeReason };

  const lookup: Promise<Availability> = tdRequest<TdApp[]>("/applications", {
    cacheKey: "/applications",
    cacheTtlMs: getConfig().cache.referenceTtlMs,
  }).then(
    (apps) => availabilityFromApps(apps),
    (error: unknown) => ({
      known: false as const,
      reason: `application lookup failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    })
  );

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Availability>((resolve) => {
    timer = setTimeout(() => resolve({ known: false, reason: `application lookup exceeded ${options.timeoutMs} ms` }), options.timeoutMs);
  });
  const result = await Promise.race([lookup, timeout]);
  if (timer) clearTimeout(timer);

  if (result.known) {
    negativeUntil = 0;
    const key = [...result.present].sort().join(",");
    if (key !== lastLoggedKey) {
      lastLoggedKey = key;
      logger.info("application availability resolved", { present: [...result.present].sort() });
    }
  } else {
    negativeUntil = Date.now() + NEGATIVE_TTL_MS;
    negativeReason = result.reason;
    logger.debug("application availability unknown; all permitted tools stay registered", { reason: result.reason });
  }
  return result;
}

import { getConfig } from "../config.js";
import { ToolInputError } from "../framework/defineTool.js";
import { tdRequest } from "./client.js";
import type { TdPerson } from "../types.js";

/**
 * Resolves the application an app-scoped tool should operate in, falling back to
 * the server's configured default so single-application deployments never have
 * to ask the user which app they meant.
 */
export function resolveAppId(appId: number | undefined): number {
  if (appId !== undefined) return appId;
  const configured = getConfig().defaultAppId;
  if (configured !== undefined) return configured;
  throw new ToolInputError(
    "No app_id was provided and this server has no TEAMDYNAMIX_DEFAULT_APP_ID configured. " +
      "Call teamdynamix_list_applications to discover application IDs."
  );
}

function isEmail(value: string): boolean {
  return value.includes("@");
}

/**
 * Accepts either a person UID or an email address. Emails are resolved through a
 * cached lookup so agents can act on the identifiers humans actually use without
 * spending a turn on teamdynamix_lookup_people first.
 */
export async function resolvePersonUid(value: string): Promise<string> {
  if (!isEmail(value)) return value;

  const email = value.trim().toLowerCase();
  const candidates = await tdRequest<TdPerson[]>("/people/lookup", {
    params: { searchText: email, maxResults: 10 },
    cacheKey: `/people/resolve/${email}`,
    cacheTtlMs: getConfig().cache.referenceTtlMs,
  });

  const matches = (candidates ?? []).filter((person) => {
    const primary = typeof person.PrimaryEmail === "string" ? person.PrimaryEmail.toLowerCase() : undefined;
    const alert = typeof person.AlertEmail === "string" ? person.AlertEmail.toLowerCase() : undefined;
    return primary === email || alert === email;
  });

  if (matches.length === 1) return matches[0].UID;
  if (matches.length === 0) {
    throw new ToolInputError(
      `No TeamDynamix person found with the email '${value}'. ` +
        `Use teamdynamix_lookup_people to search by name, then pass the UID.`
    );
  }
  const listed = matches
    .slice(0, 5)
    .map((person) => `${person.FullName} (${person.UID})`)
    .join("; ");
  throw new ToolInputError(`The email '${value}' matches multiple people: ${listed}. Retry with the intended UID.`);
}

/** Resolves a list of UIDs or emails, used by search filters that accept several people. */
export async function resolvePersonUids(values: string[] | undefined): Promise<string[] | undefined> {
  if (!values?.length) return values;
  if (!values.some(isEmail)) return values;
  return Promise.all(values.map(resolvePersonUid));
}

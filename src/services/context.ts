import { getConfig, isSsoConfig } from "../config.js";
import { ToolInputError } from "./errors.js";
import { tdRequest } from "./client.js";
import type { TdPerson } from "../types.js";

/**
 * Resolves the application an app-scoped tool should operate in, falling back to
 * the server's configured default so single-application deployments never have
 * to ask the user which app they meant.
 */
export function resolveAppId(appId: number | string | undefined): number {
  // Names are turned into IDs before a handler runs; a string here means the caller skipped that step.
  if (typeof appId === "string") throw new ToolInputError(`app_id '${appId}' was not resolved to an application ID.`);
  if (appId !== undefined) return appId;
  const configured = getConfig().defaultAppId;
  if (configured !== undefined) return configured;
  throw new ToolInputError(
    "No app_id was provided and this server has no TEAMDYNAMIX_DEFAULT_APP_ID configured. " +
      "Call tdx_list_applications to discover application IDs."
  );
}

/**
 * The signed-in person's UID, for the word "me". Only meaningful when each user signs in as
 * themselves; a shared service account is nobody's "me", so that is refused rather than guessed.
 */
export async function currentUserUid(): Promise<string> {
  if (!isSsoConfig(getConfig())) {
    throw new ToolInputError(
      "'me' only works when users sign in as themselves (TEAMDYNAMIX_AUTH_METHOD=sso). " +
        "This server uses a shared service account, so pass a person's UID or email instead."
    );
  }
  const user = await tdRequest<TdPerson>("/auth/getuser", {
    cacheKey: "/auth/getuser",
    cacheTtlMs: getConfig().cache.referenceTtlMs,
  });
  if (!user?.UID) throw new ToolInputError("TeamDynamix did not return the signed-in user, so 'me' could not be resolved.");
  return user.UID;
}

function isEmail(value: string): boolean {
  return value.includes("@");
}

/**
 * Accepts either a person UID or an email address. Emails are resolved through a
 * cached lookup so agents can act on the identifiers humans actually use without
 * spending a turn on tdx_lookup_people first.
 */
export async function resolvePersonUid(value: string): Promise<string> {
  if (value.trim().toLowerCase() === "me") return currentUserUid();
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
        `Use tdx_lookup_people to search by name, then pass the UID.`
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
  if (!values.some((value) => isEmail(value) || value.trim().toLowerCase() === "me")) return values;
  return Promise.all(values.map(resolvePersonUid));
}

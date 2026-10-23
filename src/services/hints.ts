import { getReferenceCache, scopedCacheKey } from "./cache.js";

interface NamedRef {
  ID: number;
  Name: string;
}

const MAX_LISTED = 10;

/**
 * Builds "valid values are..." guidance from reference data already in cache.
 * Runs on the error path, so it must never trigger a network call: if the data
 * was never fetched, the caller simply gets the plain API error.
 */
export function referenceHint(appId: number, endpoint: string, label: string): string | undefined {
  const cached = getReferenceCache().getAllowStale(scopedCacheKey(`/${appId}/${endpoint}`));
  if (!cached) return undefined;
  const values = cached.value as NamedRef[] | undefined;
  if (!Array.isArray(values) || values.length === 0) return undefined;

  const listed = values
    .slice(0, MAX_LISTED)
    .map((entry) => `${entry.ID} ${entry.Name}`)
    .join(", ");
  const more = values.length > MAX_LISTED ? `, and ${values.length - MAX_LISTED} more` : "";
  return `Valid ${label} for app ${appId}: ${listed}${more}.`;
}

/** Joins the hints that apply to a failed create/update call. */
export function combineHints(...hints: Array<string | undefined>): string | undefined {
  const present = hints.filter((hint): hint is string => Boolean(hint));
  return present.length > 0 ? present.join(" ") : undefined;
}

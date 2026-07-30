// Maximum size (in characters) of a single tool response before it gets truncated.
export const CHARACTER_LIMIT = 25000;

// Default page size for list/search tools.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

// TEAMDYNAMIX_BASE_URL may be an organization root, Web API root, or API root.
export function getApiBaseUrl(): string {
  const raw = process.env.TEAMDYNAMIX_BASE_URL;
  if (!raw) {
    throw new Error(
      "TEAMDYNAMIX_BASE_URL environment variable is required (e.g. https://yourorg.teamdynamix.com or https://yourorg.teamdynamixpreview.com for sandbox)."
    );
  }
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) return trimmed;
  if (/(?:^|\/)\w*WebApi$/.test(trimmed)) return `${trimmed}/api`;
  return `${trimmed}/TDWebApi/api`;
}

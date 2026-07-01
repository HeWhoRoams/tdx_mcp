// Maximum size (in characters) of a single tool response before it gets truncated.
export const CHARACTER_LIMIT = 25000;

// Default page size for list/search tools.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

// TeamDynamix Web API base path is always "<org base url>/TDWebApi/api".
// TEAMDYNAMIX_BASE_URL should be the org's root, e.g. https://demotemplate.teamdynamix.com
export function getApiBaseUrl(): string {
  const raw = process.env.TEAMDYNAMIX_BASE_URL;
  if (!raw) {
    throw new Error(
      "TEAMDYNAMIX_BASE_URL environment variable is required (e.g. https://yourorg.teamdynamix.com or https://yourorg.teamdynamixpreview.com for sandbox)."
    );
  }
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/TDWebApi/api")) return trimmed;
  if (trimmed.endsWith("/TDWebApi")) return `${trimmed}/api`;
  return `${trimmed}/TDWebApi/api`;
}

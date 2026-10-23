/** Browsers the local sign-in can drive. */
export type BrowserChannel = "msedge" | "chrome" | "chromium";

/** How a stored token was obtained: an automated browser sign-in or one pasted by the user. */
export type TokenSource = "sso" | "paste";

/** Used when a token carries no readable expiry; TeamDynamix tokens last 24 hours. */
export const FALLBACK_TOKEN_LIFETIME_MS = 23 * 60 * 60 * 1000;

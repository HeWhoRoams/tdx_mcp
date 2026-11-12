/** Errors the HTTP client and the authorization adapters raise. Re-exported from `client.ts`. */

export class TeamDynamixAuthError extends Error {}

/** Signed in as the user, but TeamDynamix says this user may not do that. */
export class TeamDynamixPermissionError extends Error {}

/** Signed in, but TeamDynamix could not confirm the sign-in right now (timeout, 429, 5xx). Nothing was discarded. */
export class TeamDynamixTransientAuthError extends Error {}

/** A request that the tool policy forbids reached the transport anyway. */
export class TeamDynamixPolicyError extends Error {}

/** Argument problems we can detect before calling TeamDynamix. */
export class ToolInputError extends Error {}

/** The wait for a rate-limit slot would be longer than a client is likely to wait. Nothing was sent. */
export class TeamDynamixRateLimitWaitError extends Error {}

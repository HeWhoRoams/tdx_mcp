/**
 * Why an SSO operation failed. The kind decides what happens next:
 * only "transient" is retried; every other kind needs a person or a fix.
 */
export type SsoFailureKind =
  | "transient" // no response, timeout, 429/5xx, browser or CDP unavailable or detached, profile in use
  | "interaction-required" // the IdP needs a person: MFA, Conditional Access, account picker
  | "identity-mismatch" // different user or tenant than the one bound to this state
  | "invalid-token" // not a JWT, expired, or TeamDynamix no longer accepts it
  | "configuration"; // playwright-core or the browser is missing, bad CDP endpoint

export function isRetryable(kind: SsoFailureKind): boolean {
  return kind === "transient";
}

/** Stable codes the transport puts at the start of an error so agents can recognise them. */
export const SSO_ACTION_REQUIRED = "SSO_ACTION_REQUIRED";
export const SSO_RENEWAL_UNAVAILABLE = "SSO_RENEWAL_UNAVAILABLE";

/** No usable token remains and a person must run `npm run login`. */
export class SsoActionRequiredError extends Error {}

/** Renewal could not complete right now; nothing is blocked and a retry may succeed. */
export class SsoUnavailableError extends Error {}

/** A renewal finished after the sign-in state changed (logout or login), so its result was thrown away. */
export class SsoRenewalDiscardedError extends Error {
  constructor() {
    super("The renewal result was discarded because the sign-in state changed while it ran.");
  }
}

import type { SsoConfig } from "../config.js";
import { buildSsoLifecycle } from "./sso-composition.js";
import type { SsoLifecycle } from "./sso-lifecycle.js";
import type { StoredToken } from "./token-store.js";

/**
 * The one interactive sign-in. The login command and the sign-in tool both come through here, so
 * there is a single implementation, serialized by the realm lock and recorded through the
 * credential state. A second request while a window is open waits for that window instead of
 * opening another.
 */

export interface InteractiveLoginOptions {
  /** Ends the wait and closes the sign-in window. */
  signal?: AbortSignal;
  /** The lifecycle to log in through. Defaults to a fresh one for the configured realm. */
  lifecycle?: Pick<SsoLifecycle, "login">;
}

let inFlight: Promise<StoredToken> | undefined;

export function runInteractiveLogin(config: SsoConfig, options: InteractiveLoginOptions = {}): Promise<StoredToken> {
  if (inFlight) return inFlight;
  const lifecycle = options.lifecycle ?? buildSsoLifecycle(config);
  const attempt = lifecycle.login(options.signal);
  inFlight = attempt;
  const clear = () => {
    if (inFlight === attempt) inFlight = undefined;
  };
  attempt.then(clear, clear);
  return attempt;
}

/** Test-only: forget a sign-in in progress. */
export function resetInteractiveLogin(): void {
  inFlight = undefined;
}

/**
 * What the HTTP client asks of whoever holds the credentials. It never sees a token, a password or a
 * key: it receives a ready `Authorization` header and a fingerprint to report a rejected request with.
 * Two adapters sit behind it: a service account (admin or user login) and per-user SSO.
 */

export type UnauthorizedVerdict = "permission-denied" | "expired" | "revoked" | "unknown";

export interface Authorization {
  authorize(): Promise<{ header: string; fingerprint: string }>;
  /**
   * After a 401 for a request sent with `fingerprint`.
   * - `permission-denied`: the credentials are fine; this identity may not do that.
   * - `unknown`: it could not be confirmed right now; nothing was discarded.
   * - `expired` / `revoked`: retry, the next `authorize()` renews (or reports that a new sign-in is needed).
   */
  reportUnauthorized(fingerprint: string): Promise<UnauthorizedVerdict>;
  /** How many expired/revoked retries one request may spend. */
  readonly maxReauthorizations: number;
  /** The error to throw once that budget is spent; `lastError` is the final rejection. */
  exhausted(lastError: unknown): Error;
  stop(): void;
}

import type { StoredToken, TokenStore } from "../services/token-store.js";

export type CredentialStateKind = "usable" | "action-required";

interface AutomaticRenewalControl {
  isAutomaticRenewalAllowed?(): boolean;
  blockAutomaticRenewal?(): void;
}

/**
 * State transitions for one Server-held token. TokenStore is deliberately only
 * a persistence adapter; callers use these intent-level operations instead.
 */
export class CredentialState {
  constructor(private readonly store: TokenStore) {}

  current(): StoredToken | undefined { return this.store.read(); }
  replace(token: StoredToken): void { this.store.write(token); }
  state(): CredentialStateKind {
    return (this.store as TokenStore & AutomaticRenewalControl).isAutomaticRenewalAllowed?.() === false
      ? "action-required"
      : "usable";
  }
  requireInteractiveLogin(): void {
    (this.store as TokenStore & AutomaticRenewalControl).blockAutomaticRenewal?.();
  }
  signOut(): void { this.store.clear(); }
}

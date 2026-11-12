import { createHash } from "node:crypto";
import { AxiosError, type AxiosInstance } from "axios";
import type { Config } from "../config.js";
import { logger } from "../services/logger.js";
import { TeamDynamixAuthError } from "../services/errors.js";
import type { Authorization, UnauthorizedVerdict } from "./authorization.js";
import { decodeJwtClaims } from "./sso-login.js";
import { FALLBACK_TOKEN_LIFETIME_MS } from "./sso-types.js";
import type { TokenStore } from "./token-store.js";

export type ServiceAuth = Exclude<Config["auth"], { method: "sso" }>;

/**
 * Decode a JWT's payload without verifying its signature (we don't have the signing key --
 * TeamDynamix does -- we only need the "exp" claim so we know when to refresh).
 */
export function decodeJwtExpiryMs(token: string): number | undefined {
  const exp = decodeJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function requireJwt(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : String(value);
  if (token.split(".").length !== 3) {
    throw new TeamDynamixAuthError(
      "TeamDynamix authentication did not return a JWT. The API URL may be redirecting to the web login page."
    );
  }
  return token;
}

/** A short, non-reversible tag for a token, so a 401 can be tied to the token that was sent. */
function fingerprintOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Refresh a minute before expiry. */
const REFRESH_BUFFER_MS = 60_000;

/**
 * Admin (BEID and web-services key) or user (username and password) login. Tokens are cached in the
 * injected store and refreshed shortly before they expire; concurrent callers share one login. A
 * rejected token is discarded and the request is retried once.
 */
export class ServiceAccountAuthorization implements Authorization {
  readonly maxReauthorizations = 1;
  private loginInFlight: Promise<string> | undefined;

  constructor(
    private readonly auth: ServiceAuth,
    private readonly http: Pick<AxiosInstance, "post">,
    private readonly tokens: TokenStore
  ) {}

  async authorize(): Promise<{ header: string; fingerprint: string }> {
    const token = await this.getToken();
    return { header: `Bearer ${token}`, fingerprint: fingerprintOf(token) };
  }

  async reportUnauthorized(fingerprint: string): Promise<UnauthorizedVerdict> {
    // Another request may already have replaced the rejected token; only discard the one that failed.
    const cached = this.tokens.read();
    if (cached && fingerprintOf(cached.token) === fingerprint) this.tokens.clear();
    return "expired";
  }

  exhausted(lastError: unknown): Error {
    return lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  stop(): void {
    // No background work: a service account holds nothing but a cached token.
  }

  private async getToken(): Promise<string> {
    const cached = this.tokens.read();
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) return cached.token;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const auth = this.auth;
    const started = Date.now();
    try {
      // The login endpoints return the raw JWT as text/plain; axios hands it back as response.data.
      const response =
        auth.method === "admin"
          ? await this.http.post<string>("/auth/loginadmin", { BEID: auth.beid, WebServicesKey: auth.wsKey }, { maxRedirects: 0 })
          : await this.http.post<string>("/auth/login", { username: auth.username, password: auth.password }, { maxRedirects: 0 });
      const token = requireJwt(response.data);
      const expiresAtMs = decodeJwtExpiryMs(token) ?? Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
      this.tokens.write({ token, expiresAtMs });
      logger.info("authenticated with TeamDynamix", { method: auth.method, durationMs: Date.now() - started });
      return token;
    } catch (error) {
      throw new TeamDynamixAuthError(
        `Failed to authenticate with TeamDynamix using ${auth.method} credentials: ${
          error instanceof AxiosError ? error.response?.data ?? error.message : String(error)
        }`
      );
    }
  }
}

import axios, { AxiosError, AxiosInstance } from "axios";
import { getApiBaseUrl } from "../constants.js";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Decode a JWT's payload without verifying its signature (we don't have the
 * signing key -- TeamDynamix does -- we only need the "exp" claim so we know
 * when to refresh).
 */
function decodeJwtExpiryMs(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class TeamDynamixAuthError extends Error {}

/**
 * Thin wrapper around the TeamDynamix Web API. Handles authentication
 * (username/password or admin BEID + Web Services Key), JWT caching and
 * refresh, and low-level HTTP requests. All tools should go through
 * `tdRequest` rather than calling axios directly.
 */
class TeamDynamixClient {
  private http: AxiosInstance;
  private cachedToken: CachedToken | undefined;
  private loginInFlight: Promise<string> | undefined;

  constructor() {
    this.http = axios.create({
      baseURL: getApiBaseUrl(),
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  private getAuthMethod(): "user" | "admin" {
    const explicit = process.env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase();
    if (explicit === "user" || explicit === "admin") return explicit;
    if (process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY) return "admin";
    if (process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD) return "user";
    throw new TeamDynamixAuthError(
      "No TeamDynamix credentials configured. Set either TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD " +
        "(standard user login) or TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY (admin service account login)."
    );
  }

  private async login(): Promise<string> {
    const method = this.getAuthMethod();
    try {
      let token: string;
      if (method === "admin") {
        const response = await this.http.post<string>("/auth/loginadmin", {
          BEID: process.env.TEAMDYNAMIX_BEID,
          WebServicesKey: process.env.TEAMDYNAMIX_WS_KEY,
        });
        token = response.data;
      } else {
        const response = await this.http.post<string>("/auth/login", {
          username: process.env.TEAMDYNAMIX_USERNAME,
          password: process.env.TEAMDYNAMIX_PASSWORD,
        });
        token = response.data;
      }
      // The login endpoints return the raw JWT string as text/plain, but axios
      // will hand it back as `response.data` either way.
      const cleanToken = typeof token === "string" ? token.trim() : String(token);
      const expiresAtMs = decodeJwtExpiryMs(cleanToken) ?? Date.now() + 23 * 60 * 60 * 1000;
      this.cachedToken = { token: cleanToken, expiresAtMs };
      return cleanToken;
    } catch (error) {
      throw new TeamDynamixAuthError(
        `Failed to authenticate with TeamDynamix using ${method} credentials: ${
          error instanceof AxiosError ? error.response?.data ?? error.message : String(error)
        }`
      );
    }
  }

  private async getToken(): Promise<string> {
    const bufferMs = 60_000; // refresh 1 minute before expiry
    if (this.cachedToken && this.cachedToken.expiresAtMs - bufferMs > Date.now()) {
      return this.cachedToken.token;
    }
    // Coalesce concurrent refreshes into a single login call.
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
  }

  /**
   * Make an authenticated request against the TeamDynamix Web API.
   * `endpoint` is relative to /TDWebApi/api, e.g. "tickets/search" or "/49/tickets/12345".
   * Automatically retries on 429 (rate limit) and 503 (service unavailable) with
   * exponential backoff (2 s, then 4 s), and retries once on 401 to refresh the token.
   */
  async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    data?: unknown,
    params?: Record<string, unknown>
  ): Promise<T> {
    const token = await this.getToken();
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const retryDelaysMs = [2000, 4000];

    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        const response = await this.http.request<T>({
          url: path,
          method,
          data,
          params,
          headers: { Authorization: `Bearer ${attempt === 0 ? token : await this.getToken()}` },
        });
        return response.data;
      } catch (error) {
        lastError = error;
        if (error instanceof AxiosError) {
          const status = error.response?.status;
          if (status === 401 && attempt === 0) {
            // Token invalidated server-side: force a refresh and retry once immediately.
            this.cachedToken = undefined;
            continue;
          }
          if ((status === 429 || status === 503) && attempt < retryDelaysMs.length) {
            await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
            continue;
          }
        }
        throw error;
      }
    }
    throw lastError;
  }
}

let clientInstance: TeamDynamixClient | undefined;

export function getClient(): TeamDynamixClient {
  if (!clientInstance) {
    clientInstance = new TeamDynamixClient();
  }
  return clientInstance;
}

export async function tdRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, unknown>
): Promise<T> {
  return getClient().request<T>(endpoint, method, data, params);
}

/**
 * Convert an error thrown by tdRequest into an actionable, agent-facing message.
 */
export function handleApiError(error: unknown): string {
  if (error instanceof TeamDynamixAuthError) {
    return `Error: ${error.message}`;
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const body = error.response?.data;
    const bodyText = typeof body === "string" ? body : body ? JSON.stringify(body) : undefined;
    switch (status) {
      case 400:
        return `Error: TeamDynamix rejected the request as invalid (400).${
          bodyText ? ` Details: ${bodyText}` : ""
        } Check that all IDs and required fields are correct.`;
      case 401:
        return "Error: Not authenticated. Check TEAMDYNAMIX_USERNAME/PASSWORD or TEAMDYNAMIX_BEID/WS_KEY, and confirm the account has API access.";
      case 403:
        return "Error: Permission denied. The authenticated account lacks the TeamDynamix application/permission needed for this action.";
      case 404:
        return "Error: Resource not found. Double-check the ID (and appId, if this endpoint requires one) is correct.";
      case 429:
        return "Error: Rate limit exceeded for this TeamDynamix endpoint. Wait a bit before retrying.";
      default:
        return `Error: TeamDynamix API request failed with status ${status ?? "unknown"}.${
          bodyText ? ` Details: ${bodyText}` : ""
        }`;
    }
  }
  if (error instanceof Error && error.message.includes("ECONNABORTED")) {
    return "Error: Request to TeamDynamix timed out. Please try again.";
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}

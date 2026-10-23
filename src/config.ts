import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BrowserChannel } from "./auth/sso-types.js";
import { resolveToolPolicy, ToolPolicyError, type ToolPolicy } from "./policy/index.js";
import { ToolPolicyFileSchema, type ToolPolicyFile } from "./policy/schema.js";

/**
 * Single source of truth for environment configuration. Parsed and validated
 * once at startup; every other module imports `getConfig()` rather than reading
 * `process.env` directly.
 */

const BooleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === "true");

const IntFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? fallback : Number(value)))
    .pipe(z.number().int().min(min).max(max));

const LogLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]).default("info");

const RawEnvSchema = z.object({
  TEAMDYNAMIX_BASE_URL: z.string().url("must be an absolute URL, e.g. https://yourorg.teamdynamix.com"),
  TEAMDYNAMIX_BEID: z.string().optional(),
  TEAMDYNAMIX_WS_KEY: z.string().optional(),
  TEAMDYNAMIX_USERNAME: z.string().optional(),
  TEAMDYNAMIX_PASSWORD: z.string().optional(),
  TEAMDYNAMIX_AUTH_METHOD: z.enum(["user", "admin", "sso"]).optional(),
  TEAMDYNAMIX_SSO_EXPECTED_USER: z.string().optional(),
  TEAMDYNAMIX_SSO_BROWSER: z.enum(["msedge", "chrome", "chromium"]).default("msedge"),
  /** local opens an owner-controlled profile; external attaches only to the configured Hermes CDP endpoint. */
  TEAMDYNAMIX_MCP_DEPLOYMENT: z.enum(["local", "external"]).default("local"),
  TEAMDYNAMIX_SSO_CDP_ENDPOINT: z.string().url().optional(),
  TEAMDYNAMIX_SSO_RENEW_LEAD_MS: IntFromEnv(60 * 60 * 1000, 60_000, 23 * 60 * 60 * 1000),
  TEAMDYNAMIX_SSO_RENEW_RETRIES: IntFromEnv(3, 0, 5),
  TDX_HOME: z.string().optional(),
  LOCALAPPDATA: z.string().optional(),
  XDG_STATE_HOME: z.string().optional(),
  TEAMDYNAMIX_READ_ONLY: BooleanFromEnv,
  TEAMDYNAMIX_TOKEN_CACHE: z.enum(["memory", "file"]).default("memory"),

  TDX_TOOL_POLICY_FILE: z.string().optional(),
  TDX_ALLOW_CAPABILITIES: z.string().optional(),
  TDX_ALLOW_TOOLS: z.string().optional(),
  TDX_DENY_TOOLS: z.string().optional(),

  TEAMDYNAMIX_TIMEOUT_MS: IntFromEnv(15_000, 1_000, 300_000),
  TEAMDYNAMIX_MAX_SOCKETS: IntFromEnv(8, 1, 128),
  TEAMDYNAMIX_MAX_RETRIES: IntFromEnv(2, 0, 5),
  TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS: IntFromEnv(3, 0, 10),
  TEAMDYNAMIX_MAX_RETRY_DELAY_MS: IntFromEnv(60_000, 1_000, 300_000),
  TEAMDYNAMIX_RATE_LIMIT: IntFromEnv(30, 1, 1000),
  TEAMDYNAMIX_RATE_WINDOW_MS: IntFromEnv(60_000, 1_000, 600_000),

  TEAMDYNAMIX_CACHE_TTL_MS: IntFromEnv(600_000, 0, 86_400_000),
  TEAMDYNAMIX_SEARCH_CACHE_TTL_MS: IntFromEnv(60_000, 0, 3_600_000),
  TEAMDYNAMIX_RECORD_CACHE_TTL_MS: IntFromEnv(30_000, 0, 3_600_000),
  TEAMDYNAMIX_CACHE_MAX_ENTRIES: IntFromEnv(500, 10, 100_000),
  TEAMDYNAMIX_DEFAULT_APP_ID: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? undefined : Number(value)))
    .pipe(z.number().int().positive().optional()),

  TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  HOST: z.string().default("127.0.0.1"),
  PORT: IntFromEnv(3000, 1, 65_535),
  MCP_AUTH_TOKEN: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),

  TDX_LOG_LEVEL: LogLevelSchema,
});

export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface Config {
  baseUrl: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  auth:
    | { method: "admin"; beid: string; wsKey: string }
    | { method: "user"; username: string; password: string }
    | {
        method: "sso";
        expectedUser?: string;
        deployment: "local" | "external";
        browser: BrowserChannel;
        cdpEndpoint?: string;
        renewLeadMs: number;
        renewRetries: number;
      };
  authCacheKey: string;
  readOnly: boolean;
  /** Which tools may be registered and invoked; see src/policy. */
  toolPolicy: ToolPolicy;
  tokenCache: "memory" | "file";
  http: {
    timeoutMs: number;
    maxSockets: number;
    maxRetries: number;
    /** Rate-limit waits are budgeted separately: a 429 is a wait instruction, not a failure. */
    maxRateLimitWaits: number;
    maxRetryDelayMs: number;
    rateLimit: number;
    rateWindowMs: number;
  };
  cache: {
    referenceTtlMs: number;
    searchTtlMs: number;
    recordTtlMs: number;
    maxEntries: number;
  };
  /** Used when an app-scoped tool is called without an explicit app_id. */
  defaultAppId?: number;
  transport: "stdio" | "http";
  server: {
    host: string;
    port: number;
    isLoopback: boolean;
    authToken?: string;
    allowedHosts: string[];
    allowedOrigins: string[];
  };
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

/** TEAMDYNAMIX_BASE_URL may be an organization root, Web API root, or API root. */
export function resolveApiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) return trimmed;
  if (/(?:^|\/)\w*WebApi$/.test(trimmed)) return `${trimmed}/api`;
  return `${trimmed}/TDWebApi/api`;
}

/** Resolves the API root from the environment alone, for CLI scripts that skip full validation. */
/**
 * The environment the login CLI and scripts need, read without the full credential
 * validation (they must start with no admin key or password configured). Values are
 * trimmed strings; this and `buildConfig` are the only readers of `process.env`.
 */
const CliEnvSchema = z.object({
  TEAMDYNAMIX_BASE_URL: z.string().optional(),
  TEAMDYNAMIX_AUTH_METHOD: z.string().optional(),
  TEAMDYNAMIX_SSO_EXPECTED_USER: z.string().optional(),
  TEAMDYNAMIX_BEID: z.string().optional(),
  TEAMDYNAMIX_WS_KEY: z.string().optional(),
  TEAMDYNAMIX_USERNAME: z.string().optional(),
  TEAMDYNAMIX_PASSWORD: z.string().optional(),
  TDX_HOME: z.string().optional(),
  LOCALAPPDATA: z.string().optional(),
  XDG_STATE_HOME: z.string().optional(),
});
export type CliEnv = z.infer<typeof CliEnvSchema>;

export function parseCliEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  const parsed = CliEnvSchema.parse(env);
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) => {
      const trimmed = value?.trim();
      return trimmed ? [[key, trimmed]] : [];
    })
  ) as CliEnv;
}

export function getApiBaseUrl(): string {
  const raw = parseCliEnv().TEAMDYNAMIX_BASE_URL;
  if (!raw) {
    throw new Error(
      "TEAMDYNAMIX_BASE_URL environment variable is required (e.g. https://yourorg.teamdynamix.com)."
    );
  }
  return resolveApiBaseUrl(raw);
}

/**
 * Maps the Web API root to the TDNext browser root so rendered records can link
 * somewhere a human can actually open (TDWebApi -> TDNext, SBTDWebApi -> SBTDNext).
 */
export function resolveWebBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api$/, "").replace(/([A-Za-z]*)WebApi$/, "$1Next");
}

/** Where per-user state (SSO token files, the dedicated login browser profile) lives. */
export function resolveTdxHome(
  env: Pick<CliEnv, "TDX_HOME" | "LOCALAPPDATA" | "XDG_STATE_HOME">,
  platform: NodeJS.Platform,
  home: string
): string {
  if (env.TDX_HOME) return env.TDX_HOME;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "tdx-mcp");
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "tdx-mcp");
}

export function getTdxHome(): string {
  return resolveTdxHome(parseCliEnv(), process.platform, homedir());
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../config/tool-policy.json", import.meta.url));

function loadPolicyFile(path: string, required: boolean): { data: unknown; source: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ToolPolicyError(`Could not read tool policy file at ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolPolicyError(`Tool policy file at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const validated = ToolPolicyFileSchema.safeParse(parsed);
  if (!validated.success) {
    const details = validated.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ToolPolicyError(`Invalid tool policy file at ${path}:\n${details.join("\n")}`);
  }

  return { data: validated.data, source: path };
}

function buildConfig(env: NodeJS.ProcessEnv): Config {
  if (env.TEAMDYNAMIX_SSO_DEPLOYMENT !== undefined) {
    throw new ConfigError("TEAMDYNAMIX_SSO_DEPLOYMENT is obsolete. Use TEAMDYNAMIX_MCP_DEPLOYMENT.");
  }
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid TeamDynamix MCP server configuration:\n${details.join("\n")}`);
  }
  const raw = parsed.data;

  if (env.TEAMDYNAMIX_SSO_BROWSER_ADAPTER !== undefined) {
    throw new ConfigError(
      "TEAMDYNAMIX_SSO_BROWSER_ADAPTER was removed. Use TEAMDYNAMIX_MCP_DEPLOYMENT=local|external instead."
    );
  }

  const hasAdmin = Boolean(raw.TEAMDYNAMIX_BEID && raw.TEAMDYNAMIX_WS_KEY);
  const hasUser = Boolean(raw.TEAMDYNAMIX_USERNAME && raw.TEAMDYNAMIX_PASSWORD);
  const isSso = raw.TEAMDYNAMIX_AUTH_METHOD === "sso";
  const requested = isSso ? undefined : raw.TEAMDYNAMIX_AUTH_METHOD ?? (hasAdmin ? "admin" : hasUser ? "user" : undefined);

  if (isSso && (hasAdmin || hasUser)) {
    process.stderr.write(
      "TEAMDYNAMIX_AUTH_METHOD=sso: ignoring TEAMDYNAMIX_BEID/WS_KEY/USERNAME/PASSWORD. Requests run as the signed-in user.\n"
    );
  }

  if (!isSso && requested === undefined) {
    throw new ConfigError(
      "No TeamDynamix credentials configured. Set TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY (admin service account, preferred), " +
        "TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD (user login), or TEAMDYNAMIX_AUTH_METHOD=sso (sign in as yourself via `npm run login`)."
    );
  }
  if (requested === "admin" && !hasAdmin) {
    throw new ConfigError("TEAMDYNAMIX_AUTH_METHOD=admin requires both TEAMDYNAMIX_BEID and TEAMDYNAMIX_WS_KEY.");
  }
  if (requested === "user" && !hasUser) {
    throw new ConfigError("TEAMDYNAMIX_AUTH_METHOD=user requires both TEAMDYNAMIX_USERNAME and TEAMDYNAMIX_PASSWORD.");
  }

  const expectedUser = raw.TEAMDYNAMIX_SSO_EXPECTED_USER?.trim();
  const externalSso = raw.TEAMDYNAMIX_MCP_DEPLOYMENT === "external";
  if (externalSso && !isSso) {
    throw new ConfigError("TEAMDYNAMIX_MCP_DEPLOYMENT=external requires TEAMDYNAMIX_AUTH_METHOD=sso.");
  }
  if (externalSso && !expectedUser) {
    throw new ConfigError("External Hermes SSO requires TEAMDYNAMIX_SSO_EXPECTED_USER.");
  }
  if (externalSso && raw.TRANSPORT !== "http") {
    throw new ConfigError("External Hermes SSO requires TRANSPORT=http on its loopback MCP endpoint.");
  }
  if (externalSso && !raw.MCP_AUTH_TOKEN) {
    throw new ConfigError("External Hermes SSO requires a separate MCP_AUTH_TOKEN.");
  }
  let cdpEndpoint: string | undefined;
  if (externalSso) {
    if (!raw.TEAMDYNAMIX_SSO_CDP_ENDPOINT) {
      throw new ConfigError("External Hermes SSO requires TEAMDYNAMIX_SSO_CDP_ENDPOINT.");
    }
    try {
      const parsedEndpoint = new URL(raw.TEAMDYNAMIX_SSO_CDP_ENDPOINT);
      if (!isLoopbackHost(parsedEndpoint.hostname) || !["http:", "https:", "ws:", "wss:"].includes(parsedEndpoint.protocol)) {
        throw new Error("not loopback");
      }
      cdpEndpoint = parsedEndpoint.toString().replace(/\/$/, "");
    } catch {
      throw new ConfigError("External Hermes SSO requires a valid loopback CDP endpoint.");
    }
  }
  if (isSso && !expectedUser) {
    process.stderr.write(
      "TEAMDYNAMIX_SSO_EXPECTED_USER is not set: a different account in the dedicated SSO browser profile will be accepted. Set it to the expected email or username to bind local SSO to one person.\n"
    );
  }
  const auth: Config["auth"] = isSso
    ? {
        method: "sso",
        deployment: raw.TEAMDYNAMIX_MCP_DEPLOYMENT,
        browser: raw.TEAMDYNAMIX_SSO_BROWSER,
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
        renewLeadMs: raw.TEAMDYNAMIX_SSO_RENEW_LEAD_MS,
        renewRetries: raw.TEAMDYNAMIX_SSO_RENEW_RETRIES,
        ...(expectedUser ? { expectedUser } : {}),
      }
    : requested === "admin"
      ? { method: "admin", beid: raw.TEAMDYNAMIX_BEID!, wsKey: raw.TEAMDYNAMIX_WS_KEY! }
      : { method: "user", username: raw.TEAMDYNAMIX_USERNAME!, password: raw.TEAMDYNAMIX_PASSWORD! };

  const host = raw.HOST;
  const isLoopback = isLoopbackHost(host);

  if (raw.TRANSPORT === "http" && !isLoopback && !raw.MCP_AUTH_TOKEN) {
    throw new ConfigError(
      "MCP_AUTH_TOKEN is required when HOST is not a loopback address. Set a strong bearer token before exposing write-capable tools remotely."
    );
  }

  if (isSso && raw.TRANSPORT === "http" && !isLoopback) {
    throw new ConfigError(
      "TEAMDYNAMIX_AUTH_METHOD=sso is single-user and local-only. Use stdio, or bind HTTP to a loopback HOST."
    );
  }

  let toolPolicy: ToolPolicy;
  try {
    const explicitPolicyPath = raw.TDX_TOOL_POLICY_FILE?.trim();
    const policyPath = explicitPolicyPath || DEFAULT_POLICY_PATH;
    const loaded = loadPolicyFile(policyPath, explicitPolicyPath !== undefined && explicitPolicyPath !== "");
    toolPolicy = resolveToolPolicy({
      ...(loaded ? { policyData: loaded.data as Partial<ToolPolicyFile>, source: loaded.source } : {}),
      allowCapabilities: splitList(raw.TDX_ALLOW_CAPABILITIES),
      allowTools: splitList(raw.TDX_ALLOW_TOOLS),
      denyTools: splitList(raw.TDX_DENY_TOOLS),
      readOnly: raw.TEAMDYNAMIX_READ_ONLY,
    });
  } catch (error) {
    if (error instanceof ToolPolicyError) throw new ConfigError(error.message);
    throw error;
  }

  return {
    baseUrl: raw.TEAMDYNAMIX_BASE_URL,
    apiBaseUrl: resolveApiBaseUrl(raw.TEAMDYNAMIX_BASE_URL),
    webBaseUrl: resolveWebBaseUrl(resolveApiBaseUrl(raw.TEAMDYNAMIX_BASE_URL)),
    auth,
    authCacheKey:
      auth.method === "admin" ? `admin:${auth.beid}` : auth.method === "user" ? `user:${auth.username}` : "sso",
    readOnly: raw.TEAMDYNAMIX_READ_ONLY,
    toolPolicy,
    tokenCache: raw.TEAMDYNAMIX_TOKEN_CACHE,
    http: {
      timeoutMs: raw.TEAMDYNAMIX_TIMEOUT_MS,
      maxSockets: raw.TEAMDYNAMIX_MAX_SOCKETS,
      maxRetries: raw.TEAMDYNAMIX_MAX_RETRIES,
      maxRateLimitWaits: raw.TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS,
      maxRetryDelayMs: raw.TEAMDYNAMIX_MAX_RETRY_DELAY_MS,
      rateLimit: raw.TEAMDYNAMIX_RATE_LIMIT,
      rateWindowMs: raw.TEAMDYNAMIX_RATE_WINDOW_MS,
    },
    cache: {
      referenceTtlMs: raw.TEAMDYNAMIX_CACHE_TTL_MS,
      searchTtlMs: raw.TEAMDYNAMIX_SEARCH_CACHE_TTL_MS,
      recordTtlMs: raw.TEAMDYNAMIX_RECORD_CACHE_TTL_MS,
      maxEntries: raw.TEAMDYNAMIX_CACHE_MAX_ENTRIES,
    },
    ...(raw.TEAMDYNAMIX_DEFAULT_APP_ID !== undefined ? { defaultAppId: raw.TEAMDYNAMIX_DEFAULT_APP_ID } : {}),
    transport: raw.TRANSPORT,
    server: {
      host,
      port: raw.PORT,
      isLoopback,
      ...(raw.MCP_AUTH_TOKEN ? { authToken: raw.MCP_AUTH_TOKEN } : {}),
      allowedHosts: splitList(raw.MCP_ALLOWED_HOSTS),
      allowedOrigins: splitList(raw.MCP_ALLOWED_ORIGINS),
    },
    logLevel: raw.TDX_LOG_LEVEL,
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) cached = buildConfig(process.env);
  return cached;
}

/** Test-only: rebuild configuration from the current environment. */
export function resetConfig(): void {
  cached = undefined;
}

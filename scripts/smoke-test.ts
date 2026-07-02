#!/usr/bin/env tsx
/**
 * smoke-test.ts
 *
 * Read-only integration smoke test against a live TeamDynamix org.
 * Calls a representative endpoint for each read-only tool category,
 * logs PASS / FAIL / SKIP per check, and exits non-zero if anything fails.
 *
 * Requires the same env vars as the MCP server (.env or environment).
 * Deliberately skips all write tools (create / update / delete) — no
 * test-data cleanup needed.
 *
 * Usage:
 *   npm run smoke-test
 *   npx tsx scripts/smoke-test.ts
 */

import axios, { type AxiosInstance } from "axios";
import { getApiBaseUrl } from "../src/constants.js";

// ── Auth helpers (mirror verify-connection.ts) ────────────────────────────────

function getAuthMethod(): "admin" | "user" {
  const explicit = process.env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase();
  if (explicit === "user" || explicit === "admin") return explicit;
  if (process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY) return "admin";
  if (process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD) return "user";
  throw new Error(
    "No credentials found.\n" +
      "Set TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY  (admin service account)\n" +
      "  OR  TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD  (user login)\n" +
      "in your .env or environment."
  );
}

async function authenticate(http: AxiosInstance, method: "admin" | "user"): Promise<string> {
  if (method === "admin") {
    const res = await http.post<string>("/auth/loginadmin", {
      BEID: process.env.TEAMDYNAMIX_BEID,
      WebServicesKey: process.env.TEAMDYNAMIX_WS_KEY,
    });
    return typeof res.data === "string" ? res.data.trim() : String(res.data);
  }
  const res = await http.post<string>("/auth/login", {
    username: process.env.TEAMDYNAMIX_USERNAME,
    password: process.env.TEAMDYNAMIX_PASSWORD,
  });
  return typeof res.data === "string" ? res.data.trim() : String(res.data);
}

// ── Check runner ──────────────────────────────────────────────────────────────

interface Check {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  skipReason?: string;
}

interface Result {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

async function runCheck(
  http: AxiosInstance,
  headers: Record<string, string>,
  check: Check
): Promise<Result> {
  if (check.skipReason) {
    return { name: check.name, status: "SKIP", detail: check.skipReason };
  }
  try {
    const res =
      check.method === "POST"
        ? await http.post(check.path, check.body ?? {}, { headers })
        : await http.get(check.path, { headers });
    const code = res.status;
    return {
      name: check.name,
      status: code >= 200 && code < 300 ? "PASS" : "FAIL",
      detail: `HTTP ${code}`,
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      return { name: check.name, status: "FAIL", detail: `HTTP ${err.response.status}` };
    }
    return { name: check.name, status: "FAIL", detail: (err as Error).message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = getApiBaseUrl();
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  let authMethod: "admin" | "user";
  try {
    authMethod = getAuthMethod();
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  const http = axios.create({ baseURL: baseUrl, timeout: 15000 });
  console.log(`\nTeamDynamix Smoke Test`);
  console.log("─".repeat(60));
  console.log(`Base URL : ${baseUrl}`);
  console.log(`Auth     : ${authMethod}\n`);

  // ── 1. Authenticate ──────────────────────────────────────────────────────────
  let token: string;
  try {
    token = await authenticate(http, authMethod);
    console.log("✅ Authentication succeeded\n");
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Authentication failed: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Authentication failed:", (err as Error).message);
    }
    process.exit(1);
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  // ── 2. Discover app IDs ──────────────────────────────────────────────────────
  interface TdApp {
    AppID: number;
    Name: string;
    Type: string;
    Active: boolean;
  }

  let ticketingAppId: number | undefined;
  let assetAppId: number | undefined;
  let projectsAppId: number | undefined;

  try {
    const res = await http.get<TdApp[]>("/applications", { headers: authHeaders });
    const active = res.data.filter((a) => a.Active);
    ticketingAppId = active.find((a) => a.Type === "Ticketing")?.AppID;
    assetAppId = active.find((a) => a.Type === "Assets")?.AppID;
    projectsAppId = active.find((a) => a.Type === "Projects")?.AppID;
    console.log(
      `Apps: ticketing=${ticketingAppId ?? "none"}, assets=${assetAppId ?? "none"}, projects=${projectsAppId ?? "none"}\n`
    );
  } catch (err) {
    console.error("❌ Could not list applications:", (err as Error).message);
    process.exit(1);
  }

  const noTicketing = ticketingAppId === undefined ? "no Ticketing app found" : undefined;
  const noAssets    = assetAppId    === undefined ? "no Assets app found"    : undefined;
  const noProjects  = projectsAppId === undefined ? "no Projects app found"  : undefined;

  // Fallback to 0 — these paths are never reached when skipReason is set.
  const t = ticketingAppId ?? 0;
  const a = assetAppId ?? 0;
  const p = projectsAppId ?? 0;

  // ── 3. Build check list ───────────────────────────────────────────────────────
  const checks: Check[] = [
    // Auth
    { name: "get_current_user            GET  /auth/getuser",                       method: "GET",  path: "/auth/getuser" },

    // Reference — global
    { name: "list_accounts               GET  /accounts",                           method: "GET",  path: "/accounts" },
    { name: "list_locations              GET  /locations",                          method: "GET",  path: "/locations" },
    { name: "list_custom_attributes      GET  /attributes/custom?componentId=9",    method: "GET",  path: "/attributes/custom?componentId=9" },

    // Reference — ticketing app
    { name: `list_ticket_types           GET  /${t}/tickets/types`,                 method: "GET",  path: `/${t}/tickets/types`,          skipReason: noTicketing },
    { name: `list_ticket_statuses        GET  /${t}/tickets/statuses`,              method: "GET",  path: `/${t}/tickets/statuses`,       skipReason: noTicketing },
    { name: `list_ticket_priorities      GET  /${t}/tickets/priorities`,            method: "GET",  path: `/${t}/tickets/priorities`,     skipReason: noTicketing },
    { name: `list_ticket_sources         GET  /${t}/tickets/sources`,               method: "GET",  path: `/${t}/tickets/sources`,        skipReason: noTicketing },
    { name: `list_ticket_forms           GET  /${t}/tickets/forms`,                 method: "GET",  path: `/${t}/tickets/forms`,          skipReason: noTicketing },
    { name: `list_ticket_impacts         GET  /${t}/tickets/impacts`,               method: "GET",  path: `/${t}/tickets/impacts`,        skipReason: noTicketing },
    { name: `list_ticket_urgencies       GET  /${t}/tickets/urgencies`,             method: "GET",  path: `/${t}/tickets/urgencies`,      skipReason: noTicketing },

    // Tickets
    { name: `search_tickets              POST /${t}/tickets/search`,                method: "POST", path: `/${t}/tickets/search`,         body: {}, skipReason: noTicketing },

    // Reports / saved searches
    { name: "list_reports                GET  /reports",                            method: "GET",  path: "/reports" },
    { name: `list_saved_searches         GET  /${t}/tickets/searches`,              method: "GET",  path: `/${t}/tickets/searches`,       skipReason: noTicketing },

    // Reference — asset / CMDB app
    { name: `list_asset_statuses         GET  /${a}/assets/statuses`,               method: "GET",  path: `/${a}/assets/statuses`,        skipReason: noAssets },
    { name: `list_product_models         GET  /${a}/assets/models`,                 method: "GET",  path: `/${a}/assets/models`,          skipReason: noAssets },
    { name: `list_ci_types               GET  /${a}/cmdb/types`,                    method: "GET",  path: `/${a}/cmdb/types`,             skipReason: noAssets },
    { name: `list_ci_relationship_types  GET  /${a}/cmdb/relationshiptypes`,        method: "GET",  path: `/${a}/cmdb/relationshiptypes`, skipReason: noAssets },

    // Assets / CMDB
    { name: `search_assets               POST /${a}/assets/search`,                 method: "POST", path: `/${a}/assets/search`,          body: {}, skipReason: noAssets },
    { name: `search_cis                  POST /${a}/cmdb/search`,                   method: "POST", path: `/${a}/cmdb/search`,            body: {}, skipReason: noAssets },

    // People / Groups
    { name: "lookup_people               GET  /people/lookup?searchText=a",         method: "GET",  path: "/people/lookup?searchText=a" },
    { name: "search_groups               POST /groups/search",                      method: "POST", path: "/groups/search", body: {} },

    // Projects / Issues
    { name: "search_projects             POST /projects/search",                    method: "POST", path: "/projects/search", body: {} },
    { name: `search_issues               POST /${p}/projects/issues/search`,        method: "POST", path: `/${p}/projects/issues/search`, body: {}, skipReason: noProjects },
  ];

  // ── 4. Run all checks ─────────────────────────────────────────────────────────
  const results: Result[] = [];
  for (const check of checks) {
    const result = await runCheck(http, authHeaders, check);
    const icon =
      result.status === "PASS" ? "✅" :
      result.status === "SKIP" ? "⏭ " :
      "❌";
    const detail = result.status === "SKIP"
      ? `(${result.detail})`
      : result.detail;
    console.log(`${icon} ${result.status.padEnd(4)}  ${detail.padEnd(22)}  ${result.name}`);
    results.push(result);
  }

  // ── 5. Summary ────────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.status === "PASS").length;
  const failed  = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  console.log("\n" + "─".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log("\nFailed checks:");
    results
      .filter((r) => r.status === "FAIL")
      .forEach((r) => console.log(`  ❌ ${r.name}  —  ${r.detail}`));
    process.exit(1);
  }
}

run();

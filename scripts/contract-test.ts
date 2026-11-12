#!/usr/bin/env tsx
/**
 * contract-test.ts
 *
 * Live contract checks against a TeamDynamix organization. The unit suite mocks TeamDynamix, so it
 * proves what the server sends, not whether TeamDynamix honours it. Each check here states a
 * property you can observe (open and closed result sets are disjoint, saved-search pages do not
 * overlap) and goes through the real tool contract: the server is mounted in memory and called with
 * an MCP client, exactly as a model would call it.
 *
 * Read-only. Refuses a production organization unless --production is given.
 *
 * Usage:
 *   npm run test:contract -- --app-id <ticketing app>
 *   npm run test:contract -- --app-id <id> --asset-app-id <id>
 *   npm run test:contract -- --app-id <id> --discover      # print API shapes (keys only, no record text)
 *   npm run test:contract -- --app-id <id> --production
 */

import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { environmentLabel } from "../src/auth/sso-login.js";
import { getConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { htmlToText } from "../src/services/text.js";
import { authorizationHeader } from "./auth.js";

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  status: Status;
  detail: string;
}

class Skip extends Error {}

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function numberOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
}

const appId = numberOption("--app-id");
const assetAppId = numberOption("--asset-app-id");
const discover = flag("--discover");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── Calling tools the way a model does ────────────────────────────────────────

let mcp: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = result.content.map((block) => block.text ?? "").join("\n");
  return { text, isError: result.isError === true };
}

async function callJson<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const { text, isError } = await call(name, { ...args, response_format: "json" });
  assert(!isError, `${name} failed: ${text.slice(0, 300)}`);
  // An empty result is a plain sentence in every response format, not JSON.
  if (/^No .+ (found|matched)/.test(text)) return { items: [], total: 0, count: 0, has_more: false } as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} response_format=json did not return parseable JSON in the text block: ${text.slice(0, 120)}`);
  }
}

interface Page {
  items: Array<Record<string, unknown>>;
  total: number;
  total_is_lower_bound?: boolean;
  next_cursor?: string;
  has_more: boolean;
}

const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

// ── Checks ────────────────────────────────────────────────────────────────────

const shared: { openTicketIds?: number[] } = {};

async function checkOpenClosed(): Promise<string> {
  assert(appId, "--app-id is required");
  const base = { app_id: appId, created_date_from: since, limit: 100, sort_by: "created", sort_order: "desc" };
  const open = await callJson<Page>("tdx_search_tickets", { ...base, is_open: true });
  const closed = await callJson<Page>("tdx_search_tickets", { ...base, is_open: false });
  if (open.items.length === 0 || closed.items.length === 0) {
    throw new Skip(`need tickets created in the last 14 days in both states (open ${open.items.length}, closed ${closed.items.length})`);
  }
  shared.openTicketIds = open.items.map((item) => Number(item.ID));
  const openIds = new Set(open.items.map((item) => item.ID));
  const overlap = closed.items.filter((item) => openIds.has(item.ID));
  assert(overlap.length === 0, `${overlap.length} ticket(s) appear in both the open and the closed result. TeamDynamix is not honouring the status class filter; check STATUS_CLASS_IDS in src/services/status-class.ts against --discover output.`);
  const statuses = (page: Page) => new Set(page.items.map((item) => String(item.StatusName)));
  const closedStatuses = statuses(closed);
  const leaked = [...statuses(open)].filter((name) => closedStatuses.has(name));
  assert(leaked.length === 0, `status name(s) appear as both open and closed: ${leaked.join(", ")}`);
  return `open ${open.items.length}${open.total_is_lower_bound ? "+" : ""}, closed ${closed.items.length}${closed.total_is_lower_bound ? "+" : ""}, disjoint`;
}

async function checkStatusClassArgument(): Promise<string> {
  assert(appId, "--app-id is required");
  const hold = await callJson<Page>("tdx_search_tickets", { app_id: appId, status_classes: ["on_hold"], limit: 5 });
  const all = await callJson<Page>("tdx_search_tickets", { app_id: appId, limit: 5, count_only: true });
  assert(hold.total <= all.total, "on_hold matched more tickets than an unfiltered search");
  return `on_hold matched ${hold.total}${hold.total_is_lower_bound ? "+" : ""}`;
}

async function checkSavedSearch(domain: "tickets" | "assets", app: number | undefined): Promise<string> {
  if (!app) throw new Skip(`pass --asset-app-id to check ${domain}`);
  const listed = await callJson<{ items: Array<{ ID: number; Name: string }> }>("tdx_list_saved_searches", { app_id: app, domain });
  if (listed.items.length === 0) throw new Skip(`no saved ${domain} searches in this application`);
  for (const search of listed.items.slice(0, 5)) {
    const first = await callJson<Page>("tdx_run_saved_search", { app_id: app, domain, search_id: search.ID, limit: 5 });
    if (first.total < 6) continue;
    assert(first.next_cursor, "a result with more rows must return next_cursor");
    const second = await callJson<Page>("tdx_run_saved_search", { app_id: app, domain, search_id: search.ID, limit: 5, cursor: first.next_cursor });
    const firstIds = new Set(first.items.map((item) => item.ID ?? item.Id));
    const repeated = second.items.filter((item) => firstIds.has(item.ID ?? item.Id));
    assert(repeated.length === 0, `page 2 repeated ${repeated.length} row(s) from page 1`);
    assert(second.total === first.total, `total changed between pages (${first.total} then ${second.total})`);
    const counted = await callJson<Page>("tdx_run_saved_search", { app_id: app, domain, search_id: search.ID, count_only: true });
    assert(counted.total === first.total, `count_only (${counted.total}) disagrees with total (${first.total})`);
    return `search ${search.ID}: ${first.total} rows, pages disjoint, count matches`;
  }
  throw new Skip("no saved search had more than 5 rows to page through");
}

async function checkJsonText(): Promise<string> {
  assert(appId, "--app-id is required");
  const { text, isError } = await call("tdx_search_tickets", { app_id: appId, limit: 2, response_format: "json" });
  assert(!isError, text.slice(0, 200));
  const parsed = JSON.parse(text) as Page;
  assert(Array.isArray(parsed.items), "json text block has no items");
  return `text block parses (${text.length} characters)`;
}

async function checkFullTicket(): Promise<string> {
  assert(appId, "--app-id is required");
  const ids = shared.openTicketIds ?? [];
  if (ids.length === 0) throw new Skip("no ticket from the open/closed check to inspect");
  let checked = 0;
  for (const id of ids.slice(0, 15)) {
    const raw = await callJson<Record<string, unknown>>("tdx_get_ticket", { app_id: appId, ticket_id: id });
    const description = typeof raw.Description === "string" ? htmlToText(raw.Description) : "";
    const attributes = Array.isArray(raw.Attributes) ? (raw.Attributes as Array<{ Name?: string; Value?: unknown; ValueText?: unknown }>) : [];
    if (description.length <= 500 && attributes.filter((a) => a.Value || a.ValueText).length === 0) continue;
    const { text } = await call("tdx_get_ticket", { app_id: appId, ticket_id: id });
    checked += 1;
    if (description.length > 500) {
      assert(text.includes(description.slice(-40)), `ticket ${id}: the end of a ${description.length}-character description is missing from the markdown`);
    }
    for (const attribute of attributes) {
      if ((attribute.Value || attribute.ValueText) && attribute.Name) {
        assert(text.includes(attribute.Name), `ticket ${id}: custom attribute '${attribute.Name}' is missing from the markdown`);
      }
    }
    return `ticket ${id}: ${description.length}-character description and ${attributes.length} attribute(s) rendered`;
  }
  throw new Skip(`none of ${ids.length} tickets had a long description or custom attributes (checked ${checked})`);
}

async function checkRateLimitHeaders(): Promise<string> {
  assert(appId, "--app-id is required");
  const header = await authorizationHeader();
  const response = await axios.post(
    `${getConfig().apiBaseUrl}/${appId}/tickets/search`,
    { MaxResults: 1 },
    { headers: { Authorization: header, "Content-Type": "application/json" } }
  );
  const limit = response.headers["x-ratelimit-limit"];
  const remaining = response.headers["x-ratelimit-remaining"];
  const reset = response.headers["x-ratelimit-reset"];
  if (limit === undefined && remaining === undefined && reset === undefined) {
    throw new Skip("this endpoint sent no X-RateLimit-* headers (it may not be rate limited)");
  }
  assert(limit !== undefined && remaining !== undefined && reset !== undefined, `partial rate limit headers: limit=${limit} remaining=${remaining} reset=${reset}`);
  return `limit ${limit}, remaining ${remaining}, reset ${reset}`;
}

async function checkNames(): Promise<string> {
  assert(appId, "--app-id is required");
  const apps = await callJson<Page>("tdx_list_applications", {});
  const app = apps.items.find((item) => Number(item.AppID) === appId);
  if (!app || typeof app.Name !== "string") throw new Skip("the application list did not include --app-id");
  const byId = await callJson<Page>("tdx_search_tickets", { app_id: appId, count_only: true });
  const byName = await callJson<Page>("tdx_search_tickets", { app_id: app.Name, count_only: true });
  assert(byName.total === byId.total, `searching by application name found ${byName.total} but by ID found ${byId.total}`);

  const sample = await callJson<Page>("tdx_search_tickets", { app_id: appId, limit: 1 });
  const statusName = sample.items[0]?.StatusName;
  if (typeof statusName !== "string") throw new Skip("no ticket to take a status name from");
  const byStatus = await callJson<Page>("tdx_search_tickets", { app_id: appId, status_ids: [statusName], limit: 25 });
  assert(byStatus.items.length > 0, `status_ids: ["${statusName}"] matched nothing, although a ticket has that status`);
  const wrong = byStatus.items.filter((item) => item.StatusName !== statusName);
  assert(wrong.length === 0, `${wrong.length} ticket(s) returned for status "${statusName}" have a different status`);
  return `application and status names resolved ("${statusName}")`;
}

async function checkExtraFilters(): Promise<string> {
  assert(appId, "--app-id is required");
  const unfiltered = await callJson<Page>("tdx_search_tickets", { app_id: appId, count_only: true });
  if (unfiltered.total === 0) throw new Skip("no tickets to narrow");
  // A filter TeamDynamix honours narrows the result; one it ignores returns everything. Each probe
  // uses a value that cannot match, so an ignored property shows up as a non-empty result.
  const probes: Array<[string, Record<string, unknown>]> = [
    ["location_ids -> LocationIDs", { location_ids: [2147483647] }],
    ["closed_date_from -> ClosedDateFrom", { closed_date_from: "2999-01-01T00:00:00Z" }],
  ];
  const notes: string[] = [];
  for (const [label, extra] of probes) {
    const page = await callJson<Page>("tdx_search_tickets", { app_id: appId, count_only: true, ...extra });
    assert(page.total < unfiltered.total, `${label}: the filter did not narrow the result (${page.total} of ${unfiltered.total}). TeamDynamix may ignore this property; remove the argument.`);
    notes.push(label.split(" ")[0]!);
  }
  const hold = await callJson<Page>("tdx_search_tickets", { app_id: appId, count_only: true, is_on_hold: true });
  assert(hold.total <= unfiltered.total, "is_on_hold matched more tickets than an unfiltered search");
  return `narrowed by ${notes.join(", ")}; is_on_hold matched ${hold.total}`;
}

async function checkReport(): Promise<string> {
  const reports = await callJson<Page>("tdx_list_reports", {});
  const report = reports.items[0];
  if (!report) throw new Skip("no reports are visible to this account");
  const first = await callJson<Page & { columns: string[] }>("tdx_get_report", { report_id: Number(report.ID), limit: 2 });
  if (first.total === 0) throw new Skip("the first report returned no rows");
  assert(Array.isArray(first.columns) && first.columns.length > 0, "the report returned rows but no column names; check reportColumns() in src/tools/reports.ts against --discover");
  assert(first.items.length <= 2, `limit=2 returned ${first.items.length} rows`);
  if (first.has_more) {
    const second = await callJson<Page>("tdx_get_report", { report_id: Number(report.ID), limit: 2, cursor: first.next_cursor });
    assert(JSON.stringify(second.items[0]) !== JSON.stringify(first.items[0]) || first.total < 2, "the second report page repeated the first row");
  }
  const subset = await callJson<Page & { columns: string[] }>("tdx_get_report", { report_id: Number(report.ID), limit: 1, columns: [first.columns[0]!] });
  assert(subset.columns.length === 1, `columns: [one] returned ${subset.columns.length} columns`);
  return `${first.total} row(s), columns: ${first.columns.slice(0, 4).join(", ")}${first.columns.length > 4 ? "…" : ""}`;
}

async function checkMe(): Promise<string> {
  if (getConfig().auth.method !== "sso") throw new Skip("'me' needs SSO; a service account has no signed-in user");
  assert(appId, "--app-id is required");
  const page = await callJson<Page>("tdx_search_tickets", { app_id: appId, requestor_uids: ["me"], count_only: true });
  return `requestor_uids: ["me"] matched ${page.total}${page.total_is_lower_bound ? "+" : ""}`;
}

// ── Discovery: API shapes, keys only ──────────────────────────────────────────

function shape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  return typeof value;
}

function describeKeys(record: Record<string, unknown>): string {
  return Object.keys(record)
    .sort()
    .map((key) => `${key}:${shape(record[key])}`)
    .join(", ");
}

async function runDiscovery(): Promise<void> {
  assert(appId, "--app-id is required");
  const header = await authorizationHeader();
  const http = axios.create({ baseURL: getConfig().apiBaseUrl, headers: { Authorization: header, "Content-Type": "application/json" } });
  const section = (title: string) => console.log(`\n## ${title}`);
  const attempt = async (title: string, run: () => Promise<void>) => {
    section(title);
    try {
      await run();
    } catch (error) {
      console.log(axios.isAxiosError(error) ? `request failed: HTTP ${error.response?.status} ${JSON.stringify(error.response?.data)}` : String(error));
    }
  };

  await attempt("Ticket statuses (look for the status class field; names and numbers only)", async () => {
    const statuses = (await http.get(`/${appId}/tickets/statuses`)).data as Array<Record<string, unknown>>;
    console.log(`fields: ${describeKeys(statuses[0] ?? {})}`);
    for (const status of statuses.slice(0, 40)) {
      const numbers = Object.entries(status)
        .filter(([key, value]) => typeof value === "number" && key !== "ID")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      console.log(`  ${status.Name}: ID=${status.ID} ${numbers}`);
    }
  });

  await attempt("Ticket search result fields", async () => {
    const tickets = (await http.post(`/${appId}/tickets/search`, { MaxResults: 1 })).data as Array<Record<string, unknown>>;
    console.log(describeKeys(tickets[0] ?? {}));
  });

  await attempt("Saved-search results, raw response shape", async () => {
    const saved = (await http.get(`/${appId}/tickets/searches`)).data as Array<{ ID: number; Name: string }>;
    const first = saved[0];
    if (!first) console.log("no saved ticket searches");
    else {
      for (const body of [{ Page: { PageIndex: 0, PageSize: 2 } }, {}]) {
        try {
          const response = await http.post(`/${appId}/tickets/searches/${first.ID}/results`, body);
          const data = response.data as unknown;
          console.log(`body ${JSON.stringify(body)} -> HTTP ${response.status}, ${Array.isArray(data) ? `array(${data.length})` : `object { ${describeKeys(data as Record<string, unknown>)} }`}`);
          if (data && !Array.isArray(data)) {
            const record = data as Record<string, unknown>;
            if (record.Page && typeof record.Page === "object") console.log(`  Page: ${JSON.stringify(record.Page)}`);
          }
        } catch (error) {
          const failure = axios.isAxiosError(error) ? `${error.response?.status} ${JSON.stringify(error.response?.data)}` : String(error);
          console.log(`body ${JSON.stringify(body)} -> ${failure}`);
        }
      }
    }
  });

  await attempt("One ticket, full record fields", async () => {
    const found = (await http.post(`/${appId}/tickets/search`, { MaxResults: 1 })).data as Array<Record<string, unknown>>;
    const id = found[0]?.ID;
    if (id !== undefined) {
      const record = (await http.get(`/${appId}/tickets/${id}`)).data as Record<string, unknown>;
      console.log(describeKeys(record));
      const attribute = Array.isArray(record.Attributes) ? (record.Attributes[0] as Record<string, unknown> | undefined) : undefined;
      if (attribute) console.log(`Attributes[0]: ${describeKeys(attribute)}`);
    }
  });

  await attempt("Reports", async () => {
    const reports = (await http.get("/reports")).data as Array<{ ID: number }>;
    if (reports[0]) {
      const report = (await http.get(`/reports/${reports[0].ID}`, { params: { withData: true } })).data as Record<string, unknown>;
      console.log(describeKeys(report));
      const column = Array.isArray(report.DisplayedColumns) ? (report.DisplayedColumns[0] as Record<string, unknown> | undefined) : undefined;
      if (column) console.log(`DisplayedColumns[0]: ${describeKeys(column)}`);
    } else console.log("no reports");
  });

  console.log("\nCompare with src/services/status-class.ts and src/services/paged-search.ts (normalizePagedResponse).");
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!appId) {
    console.error("Usage: npm run test:contract -- --app-id <ticketing application ID> [--asset-app-id <id>] [--discover] [--production]");
    process.exit(2);
  }
  const config = getConfig();
  const realm = environmentLabel(config.apiBaseUrl);
  if (realm === "production" && !flag("--production")) {
    console.error("This is a production organization. The checks are read-only, but pass --production to run them here, or point at the sandbox.");
    process.exit(2);
  }
  console.log(`Contract test against ${realm}, application ${appId}${assetAppId ? `, asset application ${assetAppId}` : ""}\n`);

  if (discover) {
    await runDiscovery();
    return;
  }

  const { server } = buildServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);

  const checks: Array<[string, () => Promise<string>]> = [
    ["is_open: open and closed results are disjoint", checkOpenClosed],
    ["status_classes: on_hold is accepted", checkStatusClassArgument],
    ["json mode: the text block parses as JSON", checkJsonText],
    ["get_ticket: whole description and custom attributes render", checkFullTicket],
    ["saved search (tickets): pages are disjoint, totals agree", () => checkSavedSearch("tickets", appId)],
    ["saved search (assets): pages are disjoint, totals agree", () => checkSavedSearch("assets", assetAppId)],
    ["rate limit headers are present", checkRateLimitHeaders],
    ["names: application and status names resolve", checkNames],
    ["filters: location and closed date narrow results", checkExtraFilters],
    ["reports: columns, paging and a column subset", checkReport],
    ["me: resolves to the signed-in user", checkMe],
  ];

  const results: Result[] = [];
  for (const [name, run] of checks) {
    try {
      results.push({ name, status: "PASS", detail: await run() });
    } catch (error) {
      if (error instanceof Skip) results.push({ name, status: "SKIP", detail: error.message });
      else results.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const result of results) console.log(`${result.status.padEnd(4)}  ${result.name}\n      ${result.detail}`);
  const counts = (status: Status) => results.filter((result) => result.status === status).length;
  console.log(`\n${counts("PASS")} passed, ${counts("FAIL")} failed, ${counts("SKIP")} skipped`);
  await mcp.close();
  process.exit(counts("FAIL") > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(() => {
    // Sockets and timers from the client keep a script alive; the checks are done.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });

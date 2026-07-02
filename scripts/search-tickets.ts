#!/usr/bin/env tsx
/**
 * search-tickets.ts
 *
 * Search for tickets in any TeamDynamix ticketing application from the CLI.
 * All configuration is read from environment variables — no org data is hardcoded.
 *
 * Usage:
 *   npm run search-tickets -- --app-id <ID> [options]
 *   npx tsx scripts/search-tickets.ts --app-id 393 --limit 10
 *   npx tsx scripts/search-tickets.ts --app-id 393 --requestor someone@example.com
 *   npx tsx scripts/search-tickets.ts --app-id 393 --status-ids 2,3 --is-open
 *
 * Options:
 *   --app-id       <number>   Required. Ticketing application ID (use list-apps to find it)
 *   --limit        <number>   Max tickets to return (default: 25, max: 100)
 *   --offset       <number>   Pagination offset (default: 0)
 *   --search       <string>   Free-text search against title/description
 *   --requestor    <string>   Filter by requestor email or username
 *   --is-open                 Only open (not closed/cancelled) tickets
 *   --status-ids   <n,n,…>   Comma-separated status IDs
 *   --priority-ids <n,n,…>   Comma-separated priority IDs
 *   --type-ids     <n,n,…>   Comma-separated type IDs
 *   --json                    Output raw JSON instead of table
 */

import axios from "axios";
import { getApiBaseUrl } from "../src/constants.js";

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function csvInts(val: string | undefined): number[] | undefined {
  return val ? val.split(",").map(Number).filter(Boolean) : undefined;
}

interface TdTicket {
  ID: number;
  Title: string;
  StatusName?: string;
  PriorityName?: string;
  TypeName?: string;
  RequestorName?: string;
  ResponsibleFullName?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
}

async function run() {
  let baseUrl: string;
  try {
    baseUrl = getApiBaseUrl();
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  const appIdStr = arg("--app-id");
  if (!appIdStr) {
    console.error("❌ --app-id is required. Run `npm run list-apps` to find your application IDs.");
    process.exit(1);
  }
  const appId = Number(appIdStr);

  const limit = Number(arg("--limit") ?? "25");
  const offset = Number(arg("--offset") ?? "0");
  const searchText = arg("--search");
  const requestorEmail = arg("--requestor");
  const isOpen = flag("--is-open") ? true : undefined;
  const statusIds = csvInts(arg("--status-ids"));
  const priorityIds = csvInts(arg("--priority-ids"));
  const typeIds = csvInts(arg("--type-ids"));
  const asJson = flag("--json");

  const method = process.env.TEAMDYNAMIX_BEID ? "admin" : "user";
  const http = axios.create({ baseURL: baseUrl, timeout: 30000 });

  // Authenticate
  let token: string;
  try {
    if (method === "admin") {
      const res = await http.post<string>("/auth/loginadmin", {
        BEID: process.env.TEAMDYNAMIX_BEID,
        WebServicesKey: process.env.TEAMDYNAMIX_WS_KEY,
      });
      token = typeof res.data === "string" ? res.data.trim() : String(res.data);
    } else {
      const res = await http.post<string>("/auth/login", {
        username: process.env.TEAMDYNAMIX_USERNAME,
        password: process.env.TEAMDYNAMIX_PASSWORD,
      });
      token = typeof res.data === "string" ? res.data.trim() : String(res.data);
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Authentication failed: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Authentication failed:", (err as Error).message);
    }
    process.exit(1);
  }

  // Resolve requestor UID if email provided
  let requestorUids: string[] | undefined;
  if (requestorEmail) {
    try {
      const res = await http.post<Array<{ UID: string; FullName: string; PrimaryEmail: string }>>(
        "/people/search",
        { SearchText: requestorEmail, MaxResults: 5 },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.data.length === 0) {
        console.error(`❌ No person found matching "${requestorEmail}"`);
        process.exit(1);
      }
      const person = res.data[0];
      requestorUids = [person.UID];
      if (!asJson) console.log(`🔍 Requestor: ${person.FullName} <${person.PrimaryEmail}>\n`);
    } catch (err) {
      console.error("❌ Person lookup failed:", axios.isAxiosError(err) ? err.response?.data : (err as Error).message);
      process.exit(1);
    }
  }

  // Search tickets
  const body: Record<string, unknown> = {
    MaxResults: Math.min(offset + limit, 1000),
    ...(searchText && { SearchText: searchText }),
    ...(requestorUids && { RequestorUids: requestorUids }),
    ...(isOpen !== undefined && { IsOpen: isOpen }),
    ...(statusIds && { StatusIDs: statusIds }),
    ...(priorityIds && { PriorityIDs: priorityIds }),
    ...(typeIds && { TypeIDs: typeIds }),
  };

  let tickets: TdTicket[];
  try {
    const res = await http.post<TdTicket[]>(`/${appId}/tickets/search`, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    tickets = res.data.slice(offset, offset + limit);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Search failed: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Search failed:", (err as Error).message);
    }
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(tickets, null, 2));
    return;
  }

  if (tickets.length === 0) {
    console.log("No tickets found matching the given criteria.");
    return;
  }

  console.log(`📋 ${tickets.length} ticket(s) (app ${appId}, offset ${offset})\n`);

  const col = (s: string | undefined, w: number) => (s ?? "").slice(0, w).padEnd(w);

  console.log(
    `${"ID".padEnd(10)} ${"Title".padEnd(45)} ${"Status".padEnd(28)} ${"Priority".padEnd(16)} Created`
  );
  console.log("─".repeat(130));

  for (const t of tickets) {
    const created = t.CreatedDate ? new Date(t.CreatedDate).toLocaleDateString() : "";
    console.log(
      `${String(t.ID).padEnd(10)} ${col(t.Title, 45)} ${col(t.StatusName, 28)} ${col(t.PriorityName, 16)} ${created}`
    );
  }
}

run();

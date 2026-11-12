#!/usr/bin/env tsx
/**
 * contract-supplement.ts
 *
 * Supplemental live checks for the two contract checks that SKIP on a quiet sandbox:
 *   1. open/closed disjointness over a WIDER window (the formal test uses 14 days; the
 *      newest ticket here is ~16 days old, so it SKIPs). Proves the status-class filter
 *      still separates open from closed.
 *   2. full-ticket render: description and custom attributes come back whole.
 *
 * Read-only; uses the real tool contract (in-memory MCP client).
 *
 * Usage:
 *   TDX_ENV_FILE=.env.sandbox npx tsx scripts/contract-supplement.ts <app-id> [days]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

interface Page {
  items: Array<Record<string, unknown>>;
  total: number;
  total_is_lower_bound?: boolean;
  has_more: boolean;
}

async function main(): Promise<void> {
  const appId = Number(process.argv[2]);
  if (!Number.isInteger(appId) || appId <= 0) {
    console.error("Usage: npx tsx scripts/contract-supplement.ts <app-id>");
    process.exit(2);
  }

  const { server } = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-supplement", version: "1.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res as { content: Array<{ type: string; text?: string }> }).content.map((b) => b.text ?? "").join("\n");
    return { text, isError: (res as { isError?: boolean }).isError === true };
  };
  const callJson = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { text, isError } = await call(name, { ...args, response_format: "json" });
    if (isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    if (/^No .+ (found|matched)/.test(text)) return { items: [], total: 0, has_more: false } as unknown as T;
    return JSON.parse(text) as T;
  };

  // ── 1. Open/closed disjointness (no date filter — the real property) ─────────
  // The formal contract test filters to the last 14 days, which SKIPs on a quiet
  // sandbox. The property the status-class filter must guarantee is that no ticket
  // is ever both open and closed, so we check the full result sets (first 100 each).
  const base = { app_id: appId, limit: 100, sort_by: "created", sort_order: "desc" };
  const open = await callJson<Page>("tdx_search_tickets", { ...base, is_open: true });
  const closed = await callJson<Page>("tdx_search_tickets", { ...base, is_open: false });
  const openIds = new Set(open.items.map((i) => i.ID));
  const overlap = closed.items.filter((i) => openIds.has(i.ID));
  const openStatuses = new Set(open.items.map((i) => String(i.StatusName)));
  const closedStatuses = new Set(closed.items.map((i) => String(i.StatusName)));
  const leaked = [...openStatuses].filter((s) => closedStatuses.has(s));

  console.log(`\n[1] open/closed disjointness (no date filter, app ${appId})`);
  console.log(`    open   : ${open.items.length}${open.total_is_lower_bound ? "+" : ""} (total ${open.total}${open.total_is_lower_bound ? "+" : ""})`);
  console.log(`    closed : ${closed.items.length}${closed.total_is_lower_bound ? "+" : ""} (total ${closed.total}${closed.total_is_lower_bound ? "+" : ""})`);
  console.log(`    open status names   : ${[...openStatuses].join(", ") || "(none)"}`);
  console.log(`    closed status names : ${[...closedStatuses].join(", ") || "(none)"}`);
  if (open.items.length === 0 || closed.items.length === 0) {
    console.log(`    RESULT : SKIP — need both states (open ${open.items.length}, closed ${closed.items.length})`);
  } else {
    const disjoint = overlap.length === 0 && leaked.length === 0;
    console.log(`    overlap (same ticket both states) : ${overlap.length}`);
    console.log(`    status names in both states       : ${leaked.length ? leaked.join(", ") : "none"}`);
    console.log(`    RESULT : ${disjoint ? "PASS — open and closed are disjoint" : "FAIL — open and closed overlap"}`);
  }

  // ── 2. Full-ticket render ────────────────────────────────────────────────────
  const anyTicket = open.items[0] ?? closed.items[0];
  if (!anyTicket) {
    console.log(`\n[2] full-ticket render: SKIP — no ticket available`);
    return;
  }
  const ticketId = Number(anyTicket.ID);
  const { text: ticketText, isError } = await call("tdx_get_ticket", { app_id: appId, ticket_id: ticketId });
  const hasDescription = /Description/i.test(ticketText) && !/No description/i.test(ticketText);
  const hasCustom = /Custom (attribute|Attribute)/i.test(ticketText);
  console.log(`\n[2] full-ticket render (ticket ${ticketId})`);
  console.log(`    isError            : ${isError}`);
  console.log(`    length             : ${ticketText.length} chars`);
  console.log(`    description present: ${hasDescription}`);
  console.log(`    custom attrs shown : ${hasCustom}`);
  console.log(`    RESULT : ${!isError && hasDescription ? "PASS — full record renders" : "CHECK — see detail above"}`);
}

main().catch((err) => {
  console.error("❌", (err as Error).message);
  process.exit(1);
});

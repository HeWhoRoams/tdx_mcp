#!/usr/bin/env tsx
/**
 * write-smoke-test.ts
 *
 * Exercises the write paths that read-only checks cannot reach.
 *
 *   Tier A (default) creates nothing: a rejected create proves the 400 path and
 *   the "valid values are..." hints.
 *   Tier B creates one ticket, updates it, comments on it, and cancels it. The
 *   TeamDynamix API cannot delete tickets, so that record is permanent.
 *
 * Usage:
 *   $env:TDX_ALLOW_WRITE_TESTS="true"
 *   npx tsx scripts/write-smoke-test.ts --app-id 671 [--tier b]
 */

import "dotenv/config";
import { getConfig } from "../src/config.js";
import { registerTools, type AnyToolDefinition } from "../src/framework/defineTool.js";
import { getClient } from "../src/services/client.js";
import { allTools } from "../src/tools/index.js";

interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<CallResult>;

const handlers = new Map<string, Handler>();
let failures = 0;

function numericArg(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function check(label: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`tool ${name} is not registered`);
  return handler(args);
}

function text(result: CallResult): string {
  return result.content.map((entry) => entry.text).join("\n");
}

/** Captures the framework-wrapped handlers so error mapping and hints are exercised. */
function collectHandlers(): void {
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as Parameters<typeof registerTools>[0];
  registerTools(server, allTools as AnyToolDefinition[]);
}

async function tierA(appId: number): Promise<void> {
  console.log("\nTier A — rejected writes (no records created)");

  // Hints read cache only, so the reference data has to be warm first.
  await call("teamdynamix_list_ticket_statuses", { app_id: appId, response_format: "markdown" });
  await call("teamdynamix_list_ticket_types", { app_id: appId, response_format: "markdown" });
  await call("teamdynamix_list_ticket_priorities", { app_id: appId, response_format: "markdown" });

  const rejected = await call("teamdynamix_create_ticket", {
    app_id: appId,
    title: "[MCP TEST] this create is expected to fail",
    type_id: 999999999,
    status_id: 999999999,
    notify_requestor: false,
    notify_responsible: false,
    response_format: "markdown",
  });
  const body = text(rejected);
  check("invalid create is reported as an error", rejected.isError === true, body);
  check("error names the rejection", /400|invalid|not found/i.test(body), body);
  check("error lists valid status_id values", /Valid status_id values/.test(body), body);
  check("error lists valid type_id values", /Valid type_id values/.test(body), body);

  const missingPerson = await call("teamdynamix_search_tickets", {
    app_id: appId,
    responsible_uids: ["definitely.not.real@example.invalid"],
    limit: 1,
    offset: 0,
    count_only: false,
    verbosity: "full",
    sort_order: "desc",
    response_format: "markdown",
  });
  check(
    "unknown email is explained rather than silently ignored",
    missingPerson.isError === true && /No TeamDynamix person found/.test(text(missingPerson)),
    text(missingPerson)
  );
}

async function tierB(appId: number): Promise<void> {
  console.log("\nTier B — live record lifecycle (creates one permanent ticket)");

  const statuses = await call("teamdynamix_list_ticket_statuses", { app_id: appId, response_format: "json" });
  const types = await call("teamdynamix_list_ticket_types", { app_id: appId, response_format: "json" });
  const statusList = (statuses.structuredContent?.items ?? []) as Array<{ ID: number; Name: string }>;
  const typeList = (types.structuredContent?.items ?? []) as Array<{ ID: number; Name: string }>;
  if (typeList.length === 0 || statusList.length === 0) throw new Error("no ticket types/statuses available");

  const me = await call("teamdynamix_get_current_user", { response_format: "json" });
  const requestorEmail = (me.structuredContent as { PrimaryEmail?: string } | undefined)?.PrimaryEmail;

  const created = await call("teamdynamix_create_ticket", {
    app_id: appId,
    title: `[MCP TEST] write smoke test ${new Date().toISOString()}`,
    description: "Created by scripts/write-smoke-test.ts. Safe to close.",
    type_id: typeList[0].ID,
    ...(requestorEmail ? { requestor_email: requestorEmail } : {}),
    notify_requestor: false,
    notify_responsible: false,
    response_format: "json",
  });
  check("ticket created", created.isError !== true, text(created));
  const ticket = created.structuredContent as { ID: number } | undefined;
  if (!ticket?.ID) {
    check("ticket id returned", false, text(created));
    return;
  }
  console.log(`        ticket #${ticket.ID}`);

  const readArgs = { app_id: appId, ticket_id: ticket.ID, response_format: "json" };
  const before = await call("teamdynamix_get_ticket", readArgs);
  check("created ticket is readable", before.isError !== true);

  const newTitle = `[MCP TEST] renamed ${Date.now()}`;
  const updated = await call("teamdynamix_update_ticket", {
    app_id: appId,
    ticket_id: ticket.ID,
    title: newTitle,
    notify_responsible: false,
    response_format: "json",
  });
  check("ticket updated", updated.isError !== true, text(updated));

  const after = await call("teamdynamix_get_ticket", readArgs);
  const afterTitle = (after.structuredContent as { Title?: string } | undefined)?.Title;
  check("read after write is fresh, not a cached pre-update copy", afterTitle === newTitle, `got: ${afterTitle}`);

  const commented = await call("teamdynamix_add_ticket_comment", {
    app_id: appId,
    ticket_id: ticket.ID,
    comment: "Automated write smoke test comment.",
    is_private: true,
    response_format: "json",
  });
  check("comment added", commented.isError !== true, text(commented));

  const feed = await call("teamdynamix_get_ticket_feed", {
    app_id: appId,
    ticket_id: ticket.ID,
    limit: 1,
    offset: 0,
    response_format: "json",
  });
  const feedPage = feed.structuredContent as { count?: number; total?: number } | undefined;
  check("feed honours limit", feedPage?.count === 1, JSON.stringify(feedPage));

  // Concurrency: a read in flight while a write lands must not poison the cache.
  const raceTitle = `[MCP TEST] race ${Date.now()}`;
  await Promise.all([
    call("teamdynamix_get_ticket", readArgs),
    call("teamdynamix_update_ticket", {
      app_id: appId,
      ticket_id: ticket.ID,
      title: raceTitle,
      notify_responsible: false,
      response_format: "json",
    }),
  ]);
  const afterRace = await call("teamdynamix_get_ticket", readArgs);
  const racedTitle = (afterRace.structuredContent as { Title?: string } | undefined)?.Title;
  check("concurrent read+write leaves no stale cache entry", racedTitle === raceTitle, `got: ${racedTitle}`);

  const cancelled = statusList.find((status) => /cancel|closed/i.test(status.Name));
  if (cancelled) {
    const closing = await call("teamdynamix_update_ticket", {
      app_id: appId,
      ticket_id: ticket.ID,
      status_id: cancelled.ID,
      notify_responsible: false,
      response_format: "json",
    });
    check(`test ticket set to '${cancelled.Name}'`, closing.isError !== true, text(closing));
  } else {
    console.log("  NOTE  no Cancelled/Closed status found; ticket left open");
  }
  console.log(`\n        Permanent record: ticket #${ticket.ID} in app ${appId}.`);
}

async function run(): Promise<void> {
  const appId = numericArg("--app-id");
  const tier = process.argv.includes("--tier") ? process.argv[process.argv.indexOf("--tier") + 1] : "a";

  if (process.env.TDX_ALLOW_WRITE_TESTS !== "true") {
    console.error("Refusing to run: set TDX_ALLOW_WRITE_TESTS=true to acknowledge these tests write to TeamDynamix.");
    process.exit(1);
  }
  if (!appId) {
    console.error("Refusing to run: --app-id <ID> is required.");
    process.exit(1);
  }
  const config = getConfig();
  if (!/sb|sandbox|preview|test/i.test(config.apiBaseUrl)) {
    console.error(`Refusing to run against ${config.apiBaseUrl}: it does not look like a sandbox.`);
    process.exit(1);
  }
  if (config.readOnly) {
    console.error("Refusing to run: TEAMDYNAMIX_READ_ONLY=true, so write tools are not registered.");
    process.exit(1);
  }

  console.log(`\nWrite smoke test → ${config.apiBaseUrl} app ${appId} (tier ${tier})`);
  collectHandlers();

  await tierA(appId);
  if (tier.toLowerCase() === "b") await tierB(appId);
  else console.log("\nTier B skipped. Pass --tier b to run the record lifecycle.");

  getClient().destroy();
  console.log(failures === 0 ? "\nWrite smoke test passed." : `\nWrite smoke test failed: ${failures} check(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error("Write smoke test errored:", error);
  process.exit(1);
});

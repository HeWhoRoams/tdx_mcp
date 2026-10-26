#!/usr/bin/env tsx
/**
 * list-apps.ts
 *
 * List all active TeamDynamix applications with their IDs and types.
 * Useful for discovering the app_id values required by most MCP tools.
 *
 * Usage:
 *   npm run list-apps
 *   npx tsx scripts/list-apps.ts [--all]   # --all includes inactive apps
 *   npx tsx scripts/list-apps.ts --type Ticketing
 */

import axios from "axios";
import { getApiBaseUrl } from "../src/constants.js";
import { getAuthMethod, authenticate } from "./auth.js";

interface TdApp {
  AppID: number;
  Name: string;
  Type: string;
  Description?: string;
  Active: boolean;
}

async function run() {
  let baseUrl: string;
  try {
    baseUrl = getApiBaseUrl();
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  const showAll = process.argv.includes("--all");
  const typeFilter = (() => {
    const idx = process.argv.indexOf("--type");
    return idx !== -1 ? process.argv[idx + 1]?.toLowerCase() : null;
  })();

  const method = getAuthMethod();
  const http = axios.create({ baseURL: baseUrl, timeout: 15000 });

  // Authenticate
  let token: string;
  try {
    token = await authenticate(http, method);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Authentication failed: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Authentication failed:", (err as Error).message);
    }
    process.exit(1);
  }

  // Fetch applications
  let apps: TdApp[];
  try {
    const res = await http.get<TdApp[]>("/applications", {
      headers: { Authorization: `Bearer ${token}` },
    });
    apps = res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Failed: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Failed:", (err as Error).message);
    }
    process.exit(1);
  }

  let filtered = showAll ? apps : apps.filter((a) => a.Active);
  if (typeFilter) {
    filtered = filtered.filter((a) => a.Type.toLowerCase() === typeFilter);
  }

  // Group by type
  const byType = filtered.reduce<Record<string, TdApp[]>>((acc, app) => {
    (acc[app.Type] ??= []).push(app);
    return acc;
  }, {});

  const totalLabel = showAll ? "total" : "active";
  console.log(`\n📦 TeamDynamix applications (${filtered.length} ${totalLabel})\n`);

  for (const [type, list] of Object.entries(byType).sort()) {
    console.log(`  ── ${type} (${list.length}) ──`);
    list
      .sort((a, b) => a.Name.localeCompare(b.Name))
      .forEach((a) => {
        const inactive = !a.Active ? "  [inactive]" : "";
        console.log(`    ${String(a.AppID).padEnd(6)} ${a.Name}${inactive}`);
      });
    console.log();
  }
}

run();

#!/usr/bin/env tsx
/**
 * verify-connection.ts
 *
 * Pre-flight check: authenticate with TeamDynamix using the credentials in
 * your .env (or environment) and print basic org info.
 *
 * Usage:
 *   npm run verify
 *   npx tsx scripts/verify-connection.ts
 */

import axios from "axios";
import { getApiBaseUrl } from "../src/config.js";
import { getAuthMethod, authorizationHeader } from "./auth.js";

async function run() {
  let baseUrl: string;
  try {
    baseUrl = getApiBaseUrl();
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  const http = axios.create({ baseURL: baseUrl, timeout: 15000 });

  console.log(`\n🔗 TeamDynamix base URL : ${baseUrl}`);
  try {
    console.log(`🔑 Auth method          : ${getAuthMethod()}\n`);
  } catch (err) {
    console.error("❌", (err as Error).message);
    process.exit(1);
  }

  // ── 1. Authenticate ─────────────────────────────────────────────────────────
  let header: string;
  try {
    header = await authorizationHeader();
    console.log("✅ Authentication succeeded");
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Authentication failed: HTTP ${err.response?.status}`);
      console.error("   Response:", err.response?.data ?? err.message);
    } else {
      console.error("❌ Authentication failed:", (err as Error).message);
    }
    process.exit(1);
  }

  // ── 2. List applications ─────────────────────────────────────────────────────
  try {
    const res = await http.get<Array<{ AppID: number; Name: string; Type: string; Active: boolean }>>(
      "/applications",
      { headers: { Authorization: header } }
    );
    const apps = res.data.filter((a) => a.Active);
    const ticketingApps = apps.filter((a) => a.Type === "Ticketing");

    console.log(`✅ Connected — ${apps.length} active application(s), ${ticketingApps.length} ticketing\n`);
    console.log("📋 Ticketing applications (use these app_id values with ticket tools):\n");
    ticketingApps.forEach((a) => console.log(`   ${String(a.AppID).padEnd(6)} ${a.Name}`));
    console.log();
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`❌ Failed to list applications: HTTP ${err.response?.status}`, err.response?.data ?? err.message);
    } else {
      console.error("❌ Failed to list applications:", (err as Error).message);
    }
    process.exit(1);
  }
}

run();

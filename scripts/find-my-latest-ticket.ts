#!/usr/bin/env tsx
/**
 * find-my-latest-ticket.ts
 *
 * Finds the most recently created ticket where the current user is the requestor,
 * scanning every ticketing application.
 *
 * Usage:
 *   npx tsx scripts/find-my-latest-ticket.ts
 */

import axios from "axios";
import { getApiBaseUrl } from "../src/config.js";
import { authorizationHeader } from "./auth.js";

interface TdApp {
  AppID: number;
  Name: string;
  Type: string;
  Active: boolean;
}

interface TdTicket {
  ID: number;
  Title: string;
  StatusName?: string;
  PriorityName?: string;
  TypeName?: string;
  ResponsibleFullName?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
}

async function run() {
  const baseUrl = getApiBaseUrl();
  const http = axios.create({ baseURL: baseUrl, timeout: 30000 });
  const auth = { Authorization: await authorizationHeader() };

  const me = await http.get("/auth/getuser", { headers: auth });
  const uid = me.data.UID as string;
  console.log(`👤 ${me.data.FullName} <${me.data.PrimaryEmail}> (UID ${uid})\n`);

  const apps = await http.get<TdApp[]>("/applications", { headers: auth });
  const ticketing = apps.data.filter((a) => a.Active && a.Type === "Ticketing");
  console.log(`🔍 Scanning ${ticketing.length} ticketing applications for tickets you opened...\n`);

  let latest: { app: TdApp; ticket: TdTicket } | undefined;
  let latestCreated = 0;
  for (const app of ticketing) {
    try {
      const res = await http.post<TdTicket[]>(`/${app.AppID}/tickets/search`, {
        MaxResults: 100,
        RequestorUids: [uid],
      }, { headers: auth });
      for (const t of res.data) {
        if (!t.CreatedDate) continue;
        const created = new Date(t.CreatedDate).getTime();
        if (!latest || created > latestCreated) {
          latest = { app, ticket: t };
          latestCreated = created;
        }
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 403) continue; // no access to this app
      console.error(`  ⚠️ app ${app.AppID} (${app.Name}): ${axios.isAxiosError(err) ? err.response?.status : err}`);
    }
  }

  if (!latest) {
    console.log("No tickets found where you are the requestor.");
    return;
  }

  const t = latest.ticket;
  console.log(`🎫 Most recent ticket you opened:`);
  console.log(`   ID:        ${t.ID}`);
  console.log(`   Title:     ${t.Title}`);
  console.log(`   App:       ${latest.app.Name} (${latest.app.AppID})`);
  console.log(`   Status:    ${t.StatusName ?? "?"}`);
  console.log(`   Priority:  ${t.PriorityName ?? "?"}`);
  console.log(`   Type:      ${t.TypeName ?? "?"}`);
  console.log(`   Assigned:  ${t.ResponsibleFullName ?? "?"}`);
  console.log(`   Created:   ${t.CreatedDate ? new Date(t.CreatedDate).toLocaleString() : "?"}`);
  console.log(`   Modified:  ${t.ModifiedDate ? new Date(t.ModifiedDate).toLocaleString() : "?"}`);
}

run().catch((err) => {
  console.error("❌", axios.isAxiosError(err) ? `HTTP ${err.response?.status}: ${err.response?.data}` : err);
  process.exit(1);
});

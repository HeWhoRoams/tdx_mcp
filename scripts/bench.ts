#!/usr/bin/env tsx
/**
 * bench.ts
 *
 * Measures the latency the performance work targets: cold start to first
 * result, repeated reference lookups (cache), and search paging.
 *
 * Usage:
 *   npm run bench -- --app-id 49
 */

import "dotenv/config";
import { getClient, resetClient, tdRequest } from "../src/services/client.js";
import { getConfig } from "../src/config.js";
import { getCounters } from "../src/services/logger.js";
import { searchPage } from "../src/services/search.js";

interface Sample {
  label: string;
  durations: number[];
}

function parseAppId(): number | undefined {
  const index = process.argv.indexOf("--app-id");
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function time<T>(action: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function report(samples: Sample[]): void {
  const rows = samples.map(({ label, durations }) => ({
    scenario: label,
    runs: durations.length,
    p50_ms: Math.round(percentile(durations, 0.5)),
    p95_ms: Math.round(percentile(durations, 0.95)),
    min_ms: Math.round(Math.min(...durations)),
    max_ms: Math.round(Math.max(...durations)),
  }));
  console.table(rows);
}

async function run(): Promise<void> {
  const appId = parseAppId();
  const config = getConfig();
  console.log(`\nTeamDynamix benchmark → ${config.apiBaseUrl}`);
  console.log(
    `keep-alive sockets: ${config.http.maxSockets} | rate limit: ${config.http.rateLimit}/${config.http.rateWindowMs}ms | ` +
      `reference TTL: ${config.cache.referenceTtlMs}ms | search TTL: ${config.cache.searchTtlMs}ms\n`
  );

  const samples: Sample[] = [];

  const coldStart = await time(async () => {
    resetClient();
    await getClient().warmUp();
    await tdRequest("/auth/getuser");
  });
  samples.push({ label: "cold start → first result (login + call)", durations: [coldStart] });

  const warmCalls: number[] = [];
  for (let index = 0; index < 5; index++) {
    warmCalls.push(await time(() => tdRequest("/auth/getuser")));
  }
  samples.push({ label: "warm call, connection reused", durations: warmCalls });

  const firstReference = await time(() => tdRequest("/applications", { cacheKey: "/applications", cacheTtlMs: 600_000 }));
  const cachedReference: number[] = [];
  for (let index = 0; index < 5; index++) {
    cachedReference.push(await time(() => tdRequest("/applications", { cacheKey: "/applications", cacheTtlMs: 600_000 })));
  }
  samples.push({ label: "reference lookup, uncached", durations: [firstReference] });
  samples.push({ label: "reference lookup, cached", durations: cachedReference });

  if (appId) {
    const searchArgs = { limit: 10, offset: 0 };
    const firstPage = await time(() => searchPage(`/${appId}/tickets/search`, { IsOpen: true }, searchArgs));
    const secondPage = await time(() => searchPage(`/${appId}/tickets/search`, { IsOpen: true }, { limit: 10, offset: 10 }));
    samples.push({ label: "ticket search, first page", durations: [firstPage] });
    samples.push({ label: "ticket search, second page (cached)", durations: [secondPage] });

    const concurrent = await time(() =>
      Promise.all([
        searchPage(`/${appId}/tickets/search`, { IsOpen: false }, searchArgs),
        searchPage(`/${appId}/tickets/search`, { IsOpen: false }, searchArgs),
        searchPage(`/${appId}/tickets/search`, { IsOpen: false }, searchArgs),
      ])
    );
    samples.push({ label: "3 identical concurrent searches (deduped)", durations: [concurrent] });
  } else {
    console.log("Tip: pass --app-id <ID> to include ticket search scenarios.\n");
  }

  report(samples);
  console.log("\nCounters:", getCounters());
  resetClient();
}

run().catch((error) => {
  console.error("Benchmark failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

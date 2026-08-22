#!/usr/bin/env tsx
/**
 * measure-window.ts
 *
 * Answers one question: does TeamDynamix search latency scale with MaxResults?
 * The answer decides whether the server can cheaply fetch a wide window once
 * (so paging is free) or must keep fetching the minimum.
 *
 * Each sample uses a distinct SearchText so TeamDynamix cannot serve a cached
 * result set, and sizes are interleaved so warm-up cost cannot bias one size.
 *
 * Usage:
 *   npx tsx scripts/measure-window.ts --app-id 671 [--runs 4]
 */

import "dotenv/config";
import { getClient, tdRequest } from "../src/services/client.js";
import { getConfig } from "../src/config.js";

const SIZES = [26, 51, 101, 251];

function numericArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function run(): Promise<void> {
  const appId = numericArg("--app-id", 0);
  if (!appId) {
    console.error("Usage: npx tsx scripts/measure-window.ts --app-id <ID> [--runs 4]");
    process.exit(1);
  }
  const runs = numericArg("--runs", 4);
  console.log(`\nMaxResults sweep → ${getConfig().apiBaseUrl} app ${appId}, ${runs} runs per size\n`);

  const samples = new Map<number, number[]>(SIZES.map((size) => [size, []]));
  const rowCounts = new Map<number, number>();

  for (let run = 0; run < runs; run++) {
    // Interleave sizes so warm-up cost is spread evenly rather than landing on the first size.
    for (const size of [...SIZES].sort(() => Math.random() - 0.5)) {
      // A broad filter with a jittered start date matches many rows while still
      // being a distinct query, so TeamDynamix cannot serve a cached result set.
      const daysBack = 1500 + Math.floor(Math.random() * 2000);
      const createdFrom = new Date(Date.now() - daysBack * 86_400_000).toISOString();
      const started = performance.now();
      const rows = await tdRequest<unknown[]>(`/${appId}/tickets/search`, {
        method: "POST",
        data: { MaxResults: size, CreatedDateFrom: createdFrom },
      });
      samples.get(size)!.push(performance.now() - started);
      rowCounts.set(size, rows?.length ?? 0);
    }
  }

  console.table(
    SIZES.map((size) => {
      const values = samples.get(size)!;
      return {
        MaxResults: size,
        runs: values.length,
        p50_ms: Math.round(percentile(values, 0.5)),
        min_ms: Math.round(Math.min(...values)),
        max_ms: Math.round(Math.max(...values)),
        last_rows: rowCounts.get(size),
      };
    })
  );

  const emptied = SIZES.filter((size) => (rowCounts.get(size) ?? 0) === 0);
  if (emptied.length > 0) {
    console.log(`\nWARNING: sizes ${emptied.join(", ")} returned no rows; the sweep measured overhead, not row cost.`);
  }

  const baseline = percentile(samples.get(SIZES[0])!, 0.5);
  const widest = percentile(samples.get(SIZES[SIZES.length - 1])!, 0.5);
  const ratio = baseline === 0 ? 0 : widest / baseline;
  console.log(
    `\n251 rows costs ${ratio.toFixed(2)}x a 26-row fetch. ` +
      (ratio < 1.5
        ? "Latency is effectively flat: fetch a wide window once and page from cache."
        : "Latency scales with MaxResults: keep the first fetch small and grow only when an agent pages.")
  );

  getClient().destroy();
}

run().catch((error) => {
  console.error("Measurement failed:", error);
  process.exit(1);
});

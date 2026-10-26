import { getConfig, type LogLevel } from "../config.js";

/**
 * Structured logging to stderr. stdout is reserved for the stdio MCP transport,
 * so nothing here may ever write to it.
 */

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let cachedThreshold: number | undefined;

function threshold(): number {
  if (cachedThreshold === undefined) {
    try {
      cachedThreshold = LEVEL_RANK[getConfig().logLevel];
    } catch {
      cachedThreshold = LEVEL_RANK.info; // config not yet validated (e.g. during startup failure)
    }
  }
  return cachedThreshold;
}

export function resetLogger(): void {
  cachedThreshold = undefined;
}

function emit(level: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < threshold()) return;
  const record = { ts: new Date().toISOString(), level, msg: message, ...fields };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};

export interface Counters {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  staleServed: number;
  retries: number;
  rateLimitWaits: number;
  dedupedRequests: number;
  toolCalls: number;
  toolErrors: number;
}

const counters: Counters = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  staleServed: 0,
  retries: 0,
  rateLimitWaits: 0,
  dedupedRequests: 0,
  toolCalls: 0,
  toolErrors: 0,
};

export function increment(counter: keyof Counters, by = 1): void {
  counters[counter] += by;
}

export function getCounters(): Readonly<Counters> {
  return { ...counters };
}

export function resetCounters(): void {
  for (const key of Object.keys(counters) as Array<keyof Counters>) counters[key] = 0;
}

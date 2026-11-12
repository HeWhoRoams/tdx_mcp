import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, type Config } from "./config.js";
import { getAvailability, type Availability } from "./policy/availability.js";
import { buildServer, type ServerControls } from "./server.js";
import { logger } from "./services/logger.js";
import { catalog } from "./surface/catalog.js";
import { resolveSurface, surfaceAuthOf } from "./surface/resolve.js";

/**
 * The server lifecycle: when application availability is resolved, when a server is built, and when
 * a server that started without that knowledge is pruned. Transports only supply how requests
 * arrive; they never decide any of this.
 */

export type AvailabilitySource = (options: { timeoutMs: number; bypassNegativeCache?: boolean }) => Promise<Availability>;

export interface LifecycleOptions {
  config?: Config;
  /** Where availability comes from. Defaults to the live application lookup. */
  availability?: AvailabilitySource;
  /** Backoff for the background retry of a long-lived server. */
  retryDelaysMs?: number[];
  /** How long one background retry may wait for the lookup. */
  retryTimeoutMs?: number;
}

export interface Session {
  server: McpServer;
  /** What was registered, so a transport can log it once at start-up. */
  registration: Record<string, unknown>;
  close(): Promise<void>;
}

export interface GatingHealth {
  mode: "auto" | "off";
  state: "off" | "known" | "unknown";
  /** Tools hidden because their application is missing. A count only: application names identify the organization. */
  gatedCount: number;
}

export interface ServerLifecycle {
  /**
   * A server ready to connect.
   * - `long-lived` (stdio): availability is resolved once, with a timeout. If it is still unknown,
   *   the lifecycle keeps retrying in the background and hides unusable tools once it is known.
   * - `per-request` (HTTP): availability is resolved per call and nothing is retried; the negative
   *   cache in the lookup bounds the cost.
   */
  open(mode: "long-lived" | "per-request"): Promise<Session>;
  health(): GatingHealth;
  /** Cancels background retries. */
  stop(): void;
}

/** Backoff for the background retry after a start-up lookup could not complete. */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

export function createServerLifecycle(options: LifecycleOptions = {}): ServerLifecycle {
  const config = options.config ?? getConfig();
  const source: AvailabilitySource = options.availability ?? getAvailability;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const gating = config.appGating.mode === "auto";
  const cancels = new Set<() => void>();
  let last: Availability | undefined;

  const resolve = async (retry = false): Promise<Availability | undefined> => {
    if (!gating) return undefined;
    last = await source(
      retry
        ? { timeoutMs: options.retryTimeoutMs ?? 30_000, bypassNegativeCache: true }
        : { timeoutMs: config.appGating.timeoutMs }
    );
    return last;
  };

  /** Bounded and unref'd, so it never keeps the process alive. Returns a cancel function. */
  const retryInBackground = (controls: ServerControls): (() => void) => {
    let stopped = false;
    let attempts = 0;
    let timer: NodeJS.Timeout | undefined;

    const attempt = async (): Promise<void> => {
      if (stopped) return;
      const availability = await resolve(true);
      if (stopped || !availability) return;
      if (availability.known) {
        const hidden = controls.applyAvailability(availability);
        logger.info("application gating applied after start-up", { hidden: hidden.length });
        return;
      }
      const delay = delays[attempts];
      attempts += 1;
      if (delay === undefined) {
        logger.debug("application availability still unknown; leaving every permitted tool registered");
        return;
      }
      timer = setTimeout(() => void attempt(), delay);
      timer.unref();
    };

    void attempt();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  };

  return {
    async open(mode) {
      const availability = await resolve();
      const controls = buildServer(availability ? { availability } : {});
      // A long-lived server is built once per process; per-request servers are built for every call.
      if (mode === "long-lived") logger.info("tools registered", controls.registration);
      let cancel: (() => void) | undefined;
      if (mode === "long-lived" && availability && !availability.known) {
        cancel = retryInBackground(controls);
        cancels.add(cancel);
      }
      return {
        server: controls.server,
        registration: controls.registration,
        async close() {
          if (cancel) {
            cancel();
            cancels.delete(cancel);
          }
          await controls.server.close();
        },
      };
    },

    health() {
      if (!gating) return { mode: "off", state: "off", gatedCount: 0 };
      if (!last?.known) return { mode: "auto", state: "unknown", gatedCount: 0 };
      return {
        mode: "auto",
        state: "known",
        gatedCount: resolveSurface(catalog, config.toolPolicy, last, surfaceAuthOf(config)).counts.tool.hidden,
      };
    },

    stop() {
      for (const cancel of cancels) cancel();
      cancels.clear();
    },
  };
}

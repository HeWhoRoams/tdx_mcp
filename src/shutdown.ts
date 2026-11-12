import { resetClient } from "./services/client.js";
import { getCounters, logger } from "./services/logger.js";

/** Runs `cleanup` once on SIGINT or SIGTERM, then exits. */
export function onShutdown(cleanup: () => void | Promise<void>): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutting down", { signal, counters: getCounters() });
      void Promise.resolve(cleanup())
        .catch(() => undefined)
        .finally(() => {
          resetClient();
          process.exit(0);
        });
    });
  }
}

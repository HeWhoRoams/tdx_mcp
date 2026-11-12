import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerLifecycle } from "../lifecycle.js";
import { SERVER_VERSION } from "../server.js";
import { getClient } from "../services/client.js";
import { logger } from "../services/logger.js";
import { onShutdown } from "../shutdown.js";

export async function runStdio(lifecycle: ServerLifecycle): Promise<void> {
  // Sign-in and reference prefetch start first: the application lookup the lifecycle makes shares that work.
  void getClient().warmUp();
  const session = await lifecycle.open("long-lived");
  await session.server.connect(new StdioServerTransport());
  onShutdown(() => {
    lifecycle.stop();
    return session.close();
  });
  logger.info("teamdynamix mcp server ready", { transport: "stdio", version: SERVER_VERSION });
}

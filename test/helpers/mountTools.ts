import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../../src/config.js";
import type { AnyToolDefinition } from "../../src/framework/defineTool.js";
import { mountSurface } from "../../src/surface/mount.js";
import { resolveSurface } from "../../src/surface/resolve.js";

/** Mounts only the given tools under the current configuration's policy, on a fake or real server. */
export function mountTools(server: unknown, tools: AnyToolDefinition[]) {
  const policy = getConfig().toolPolicy;
  const catalog = { tools, prompts: [] };
  return mountSurface(server as McpServer, catalog, resolveSurface(catalog, policy), policy);
}

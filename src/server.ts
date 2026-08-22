import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, type Config } from "./config.js";
import { registerTools } from "./framework/defineTool.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { logger } from "./services/logger.js";
import { allTools } from "./tools/index.js";

export const SERVER_VERSION = "2.1.0";

const INSTRUCTIONS = [
  "TeamDynamix ticketing, assets, CMDB, projects, issues, people, and reports.",
  "Workflow: teamdynamix_list_applications for app_id -> teamdynamix_list_* for reference IDs -> search/get -> create/update.",
  "Search tools return partial records; call the matching get tool for full detail.",
  "Page with limit/offset or the next_cursor returned in each response; a total shown as 'N+' is a lower bound.",
  "Use count_only=true for 'how many' questions and verbosity='compact' when scanning many records.",
  "Person arguments accept an email address as well as a UID, so a lookup call is usually unnecessary.",
  "Pass response_format='json' when you need structured data instead of prose.",
  "For large or cross-entity questions prefer teamdynamix_get_report and teamdynamix_run_saved_search.",
  "Tools annotated readOnlyHint:false change TeamDynamix records; obtain user approval before invoking them.",
].join(" ");

const READ_ONLY_INSTRUCTIONS =
  "This TeamDynamix MCP server is configured read-only; write tools are not registered. " + INSTRUCTIONS;

function instructionsFor(config: Config): string {
  const base = config.readOnly ? READ_ONLY_INSTRUCTIONS : INSTRUCTIONS;
  return config.defaultAppId === undefined
    ? base
    : `${base} This server defaults to application ${config.defaultAppId}, so app_id may be omitted unless another application is needed.`;
}

export function createServer(): McpServer {
  const config = getConfig();
  const server = new McpServer(
    { name: "teamdynamix-mcp-server", version: SERVER_VERSION },
    { instructions: instructionsFor(config) }
  );

  const registered = registerTools(server, allTools);
  registerResources(server);
  registerPrompts(server);
  logger.debug("tools registered", { registered, total: allTools.length, readOnly: config.readOnly });
  return server;
}

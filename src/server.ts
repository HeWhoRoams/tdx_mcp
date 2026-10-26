import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, type Config } from "./config.js";
import { CAPABILITIES } from "./framework/annotations.js";
import { findUnknownPolicyNames, registerTools } from "./framework/defineTool.js";
import { summarizePolicy } from "./policy/index.js";
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
  "To record progress on a ticket use teamdynamix_add_ticket_comment; teamdynamix_edit_ticket rewrites core fields and may be disabled.",
  "Tools annotated readOnlyHint:false change TeamDynamix records; obtain user approval before invoking them.",
].join(" ");

/**
 * Tools denied by policy are never registered, so the model is told which tiers
 * are unavailable rather than being left to discover it through failures.
 */
function policyNotice(config: Config): string {
  if (config.readOnly) {
    return "This TeamDynamix MCP server is configured read-only; no write tools are registered.";
  }
  const denied = CAPABILITIES.filter(
    (capability) => capability !== "read" && config.toolPolicy.defaults[capability] !== "allow"
  );
  if (denied.length === 0) return "";
  return `This server's policy denies ${denied.join(" and ")} tools by default, so some write tools are not registered.`;
}

function instructionsFor(config: Config): string {
  const parts = [policyNotice(config), INSTRUCTIONS];
  if (config.defaultAppId !== undefined) {
    parts.push(
      `This server defaults to application ${config.defaultAppId}, so app_id may be omitted unless another application is needed.`
    );
  }
  return parts.filter(Boolean).join(" ");
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
  const unknown = findUnknownPolicyNames(allTools);
  if (unknown.length > 0) logger.warn("tool policy names no tool in this server", { unknown });
  logger.info("tools registered", {
    registered,
    denied: allTools.length - registered,
    policy: summarizePolicy(config.toolPolicy),
  });
  return server;
}

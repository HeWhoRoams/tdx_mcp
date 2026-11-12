import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, type Config } from "./config.js";
import { CAPABILITIES } from "./framework/annotations.js";
import { APP_LABEL, type AppKey, type Availability } from "./policy/availability.js";
import { summarizePolicy, type ToolDomain } from "./policy/index.js";
import { registerResources } from "./resources/index.js";
import { logger } from "./services/logger.js";
import { catalog } from "./surface/catalog.js";
import { mountSurface } from "./surface/mount.js";
import { resolveSurface, surfaceAuthOf, unknownPolicyNames, type Surface } from "./surface/resolve.js";

export const SERVER_VERSION = "4.0.0";

/** Areas named in the instructions, in the order they are listed. */
const AREAS: Array<[ToolDomain, string]> = [
  ["tickets", "ticketing"],
  ["assets", "assets"],
  ["cmdb", "CMDB"],
  ["projects", "projects"],
  ["issues", "issues"],
  ["people", "people"],
  ["reports", "reports"],
];

const INSTRUCTION_BODY = [
  "Workflow: search/get/create/update directly. app_id accepts an application name ('Help Desk') or ID, and status, priority, type and similar arguments accept names ('On Hold') or IDs; a wrong name returns the valid choices.",
  "Search tools return partial records; call the matching get tool for full detail.",
  "Page with limit/offset or the next_cursor returned in each response; a total shown as 'N+' is a lower bound.",
  "Use count_only=true for 'how many' questions and verbosity='compact' when scanning many records.",
  "Person arguments accept an email address or 'me' (the signed-in user under SSO) as well as a UID, so a lookup call is usually unnecessary.",
  "Pass response_format='json' when you need structured data instead of prose.",
  "For large or cross-entity questions prefer tdx_get_report and tdx_run_saved_search.",
  "To record progress on a ticket use tdx_add_ticket_comment; tdx_edit_ticket rewrites core fields and may be disabled.",
  "Tools annotated readOnlyHint:false change TeamDynamix records; obtain user approval before invoking them.",
].join(" ");

function joinWithAnd(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

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

const GATED_PHRASE: Record<AppKey, string> = {
  tickets: "Ticketing tools",
  assets: "Asset and CMDB tools",
  projects: "Project and issue tools",
};

/** Says which areas are absent because the account has no application for them, so the model does not ask for them. */
function gatingNotice(gated: readonly AppKey[]): string {
  return gated
    .map((key) => `${GATED_PHRASE[key]} are not registered because no ${APP_LABEL[key]} application is available to this account.`)
    .join(" ");
}

function toolsetNotice(config: Config): string {
  const toolsets = config.toolPolicy.toolsets;
  if (!toolsets) return "";
  return `This server exposes only these areas: ${[...toolsets].filter((domain) => domain !== "auth").join(", ")}.`;
}

function instructionsFor(config: Config, surface: Surface): string {
  const areas = surface.areas;
  const gated = surface.gatedApps;
  const labels = AREAS.filter(([domain]) => areas.has(domain)).map(([, label]) => label);
  const head = labels.length > 0 ? `TeamDynamix ${joinWithAnd(labels)}.` : "TeamDynamix.";
  const parts = [policyNotice(config), toolsetNotice(config), gatingNotice(gated), head, INSTRUCTION_BODY];
  if (config.defaultAppId !== undefined) {
    parts.push(
      `This server defaults to application ${config.defaultAppId}, so app_id may be omitted unless another application is needed.`
    );
  }
  return parts.filter(Boolean).join(" ");
}

export interface ServerOptions {
  /**
   * Which application kinds the account has. When known, tools for missing applications are not
   * registered. Omit it (or pass an unknown result) to register everything the policy allows.
   */
  availability?: Availability;
}

export interface ServerControls {
  server: McpServer;
  /** What was registered, for one start-up log line. */
  registration: Record<string, unknown>;
  /**
   * Hides tools and prompts for applications that turned out not to exist, for a server that started
   * before that was known. Idempotent; sends one `tools/list_changed`. Returns the hidden tool names.
   */
  applyAvailability(availability: Availability): string[];
}

function describeAvailability(availability: Availability | undefined): string {
  if (!availability) return "off";
  return availability.known ? "known" : "unknown";
}

export function buildServer(options: ServerOptions = {}): ServerControls {
  const config = getConfig();
  const { availability } = options;
  const policy = config.toolPolicy;

  // Decide first, so the instructions describe exactly what gets registered.
  const auth = surfaceAuthOf(config);
  const surface = resolveSurface(catalog, policy, availability, auth);
  const server = new McpServer(
    { name: "teamdynamix-mcp-server", version: SERVER_VERSION },
    { instructions: instructionsFor(config, surface) }
  );

  const mounted = mountSurface(server, catalog, surface, policy);
  registerResources(server);
  const unknown = unknownPolicyNames(catalog, policy);
  if (unknown.length > 0) logger.warn("tool policy names no tool in this server", { unknown });
  // Debug here: over HTTP this runs for every request. The lifecycle logs it once at info.
  const registration = {
    registered: surface.counts.tool.registered,
    gated: surface.counts.tool.hidden,
    denied: surface.counts.tool.denied,
    availability: describeAvailability(availability),
    policy: summarizePolicy(policy),
  };
  logger.debug("tools registered", registration);

  return {
    server,
    registration,
    applyAvailability: (late) => mounted.apply(resolveSurface(catalog, policy, late, auth)).hiddenTools,
  };
}

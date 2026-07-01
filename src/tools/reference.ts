import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown } from "../services/format.js";
import { AppIdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

interface NamedRef {
  ID: number;
  Name: string;
  IsActive?: boolean;
  [key: string]: unknown;
}

function listMarkdown(title: string, items: NamedRef[]): string {
  const lines = [`# ${title}`, ""];
  for (const item of items) {
    lines.push(`- **${item.Name}** (ID: ${item.ID})${item.IsActive === false ? " _[inactive]_" : ""}`);
  }
  return lines.join("\n");
}

/** Registers a simple read-only "list reference data" tool that GETs an endpoint returning an array. */
function registerSimpleListTool(
  server: McpServer,
  toolName: string,
  title: string,
  endpointTemplate: (appId?: number) => string,
  description: string,
  requiresAppId: boolean
): void {
  const schema = requiresAppId
    ? z.object({ app_id: AppIdSchema, response_format: ResponseFormatSchema }).strict()
    : z.object({ response_format: ResponseFormatSchema }).strict();

  server.registerTool(
    toolName,
    {
      title,
      description,
      inputSchema: schema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: Record<string, unknown>) => {
      try {
        const appId = requiresAppId ? (params.app_id as number) : undefined;
        const items = await tdRequest<NamedRef[]>(endpointTemplate(appId));
        const responseFormat = params.response_format as ResponseFormat;
        if (!items || items.length === 0) {
          return { content: [{ type: "text" as const, text: "No results found." }] };
        }
        const text =
          responseFormat === ResponseFormat.MARKDOWN ? truncateMarkdown(listMarkdown(title, items)) : toJsonText(items);
        return { content: [{ type: "text" as const, text }], structuredContent: { items } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

export function registerReferenceTools(server: McpServer): void {
  registerSimpleListTool(
    server,
    "teamdynamix_list_applications",
    "List TeamDynamix Applications",
    () => `/applications`,
    `Lists all platform applications in this TeamDynamix organization (ticketing apps, asset/CI apps, etc.), with their IDs.

This is the primary way to discover the 'app_id' values needed by ticket and asset tools.

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of applications with ID and Name.`,
    false
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_types",
    "List TeamDynamix Ticket Types",
    (appId) => `/${appId}/tickets/types`,
    `Lists the ticket types configured for a ticketing application. Ticket type IDs are required when creating tickets.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket types with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_statuses",
    "List TeamDynamix Ticket Statuses",
    (appId) => `/${appId}/tickets/statuses`,
    `Lists the ticket statuses configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket statuses with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_priorities",
    "List TeamDynamix Ticket Priorities",
    (appId) => `/${appId}/tickets/priorities`,
    `Lists the ticket priorities configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket priorities with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_sources",
    "List TeamDynamix Ticket Sources",
    (appId) => `/${appId}/tickets/sources`,
    `Lists the ticket sources (e.g. Email, Phone, Web) configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket sources with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_forms",
    "List TeamDynamix Ticket Forms",
    (appId) => `/${appId}/tickets/forms`,
    `Lists the active ticket forms configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket forms with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_asset_statuses",
    "List TeamDynamix Asset Statuses",
    (appId) => `/${appId}/assets/statuses`,
    `Lists the asset statuses configured for an Assets/CI application. Required when creating or updating assets.

Args:
  - app_id (number): The Assets/CI application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of asset statuses with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_accounts",
    "List TeamDynamix Accounts/Departments",
    () => `/accounts`,
    `Lists Accounts/Departments in this TeamDynamix organization. These represent the customer's organizational unit and are commonly referenced as account_id/AccountID on tickets, projects, and assets.

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of accounts/departments with ID and Name.`,
    false
  );
}

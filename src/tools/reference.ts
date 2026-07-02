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

  registerSimpleListTool(
    server,
    "teamdynamix_list_locations",
    "List TeamDynamix Locations",
    () => `/locations`,
    `Lists all active locations in the TeamDynamix organization. Location IDs are used when creating or filtering assets.

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of locations with ID and Name.`,
    false
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_impacts",
    "List TeamDynamix Ticket Impacts",
    (appId) => `/${appId}/tickets/impacts`,
    `Lists the ticket impact values configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket impacts with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ticket_urgencies",
    "List TeamDynamix Ticket Urgencies",
    (appId) => `/${appId}/tickets/urgencies`,
    `Lists the ticket urgency values configured for a ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket urgencies with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_product_models",
    "List TeamDynamix Product Models",
    (appId) => `/${appId}/assets/models`,
    `Lists all active product models for an Assets application. Product model IDs are used when creating or filtering assets.

Args:
  - app_id (number): The Assets application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of product models with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ci_types",
    "List TeamDynamix CI Types",
    (appId) => `/${appId}/cmdb/types`,
    `Lists the configuration item types configured for an Assets/CMDB application. CI type IDs are required when creating CIs.

Args:
  - app_id (number): The Assets/CMDB application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of CI types with ID and Name.`,
    true
  );

  registerSimpleListTool(
    server,
    "teamdynamix_list_ci_relationship_types",
    "List TeamDynamix CI Relationship Types",
    (appId) => `/${appId}/cmdb/relationshiptypes`,
    `Lists the CI relationship types configured for an Assets/CMDB application. Required when adding relationships between CIs with teamdynamix_add_ci_relationship.

Args:
  - app_id (number): The Assets/CMDB application ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of relationship types with ID and Name.`,
    true
  );

  // Custom attributes tool — uses a different pattern (query param, not path param)
  server.registerTool(
    "teamdynamix_list_custom_attributes",
    {
      title: "List TeamDynamix Custom Attributes",
      description: `Lists the custom attribute definitions for a given component type. Use this to discover the attribute IDs and valid choice values needed to read or set custom attributes on tickets, assets, or CIs.

Common component_id values:
  - 9  = Ticket
  - 63 = Asset / CI

Args:
  - component_id (number): The component type ID (9 for Ticket, 63 for Asset/CI)
  - app_id (number, optional): Scope to a specific application (recommended)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of custom attribute definitions including ID, Name, field type, and choice options.

Error Handling:
  - Returns empty list if no custom attributes are configured for the component`,
      inputSchema: z
        .object({
          component_id: z.number().int().positive().describe("The component type ID (9 = Ticket, 63 = Asset/CI)."),
          app_id: z.number().int().positive().optional().describe("Optional: scope to a specific application."),
          response_format: ResponseFormatSchema,
        })
        .strict().shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ component_id, app_id, response_format }) => {
      try {
        const queryParams: Record<string, unknown> = { componentId: component_id };
        if (app_id !== undefined) queryParams.appId = app_id;
        const attrs = await tdRequest<Array<Record<string, unknown>>>(`/attributes/custom`, "GET", undefined, queryParams);
        if (!attrs || attrs.length === 0) {
          return { content: [{ type: "text" as const, text: `No custom attributes found for component ID ${component_id}.` }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Custom Attributes for Component ${component_id} (${attrs.length})`, ""];
          for (const attr of attrs) {
            lines.push(`- **${attr.Name}** (ID: ${attr.ID}, type: ${attr.FieldType ?? attr.DataType ?? "unknown"})`);
            const choices = attr.Choices as Array<Record<string, unknown>> | undefined;
            if (choices && choices.length > 0) {
              for (const c of choices) lines.push(`  - Choice: ${c.Name} (ID: ${c.ID})`);
            }
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(attrs);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

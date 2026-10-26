import { z } from "zod";
import { getConfig } from "../config.js";
import { READ } from "../framework/annotations.js";
import { defineTool, items, type AnyToolDefinition } from "../framework/defineTool.js";
import { AppIdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolveAppId } from "../services/context.js";
import { renderNamedList, truncate } from "../services/format.js";
import type { TdApp } from "../types.js";

interface NamedRef {
  ID: number;
  Name: string;
  IsActive?: boolean;
  [key: string]: unknown;
}

const GlobalInput = z.object({ response_format: ResponseFormatSchema }).strict();
const AppScopedInput = z.object({ app_id: AppIdSchema, response_format: ResponseFormatSchema }).strict();

const ApplicationsInput = z
  .object({
    app_type: z
      .string()
      .optional()
      .describe("Only return applications of this type, e.g. 'Ticketing', 'Assets', 'Projects'. Case-insensitive."),
    include_inactive: z.boolean().default(false).describe("Include applications that are not active."),
    response_format: ResponseFormatSchema,
  })
  .strict();

/**
 * Reference data changes rarely and every write path requires it first, so these
 * responses are cached for TEAMDYNAMIX_CACHE_TTL_MS.
 */
function listTool<Shape extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<Shape>;
  endpoint: (args: z.infer<z.ZodObject<Shape>>) => string;
}): AnyToolDefinition {
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    annotations: READ,
    handler: async (args) => {
      const endpoint = spec.endpoint(args);
      const data = await tdRequest<NamedRef[]>(endpoint, {
        cacheKey: endpoint,
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      });
      return items(data ?? []);
    },
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No results found.",
    render: (data) => renderNamedList(spec.title, data.items),
  });
}

const CustomAttributesInput = z
  .object({
    component_id: z.number().int().positive().describe("Component type ID: 9 = Ticket, 63 = Asset/CI."),
    app_id: z.number().int().positive().optional().describe("Optional: scope to a specific application."),
    response_format: ResponseFormatSchema,
  })
  .strict();

interface CustomAttribute {
  ID: number;
  Name: string;
  FieldType?: string;
  DataType?: string;
  Choices?: Array<{ ID: number; Name: string }>;
  [key: string]: unknown;
}

export const referenceTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_list_applications",
    title: "List TeamDynamix Applications",
    description:
      "Lists platform applications with the app_id every other tool needs, grouped by type.\n" +
      "Filter with app_type='Ticketing' to narrow a large organization to its ticketing apps.",
    input: ApplicationsInput,
    annotations: READ,
    handler: async (args) => {
      const all = await tdRequest<TdApp[]>("/applications", {
        cacheKey: "/applications",
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      });
      const wanted = args.app_type?.toLowerCase();
      const filtered = (all ?? []).filter(
        (app) =>
          (args.include_inactive || app.Active !== false) &&
          (wanted === undefined || app.Type?.toLowerCase() === wanted)
      );
      return items(filtered);
    },
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No applications matched. Omit app_type to see every application.",
    render: (data) => {
      const byType = new Map<string, TdApp[]>();
      for (const app of data.items) {
        const type = app.Type ?? "Other";
        const existing = byType.get(type);
        if (existing) existing.push(app);
        else byType.set(type, [app]);
      }
      const defaultAppId = getConfig().defaultAppId;
      const lines = [`# TeamDynamix Applications (${data.items.length})`, ""];
      for (const [type, apps] of [...byType.entries()].sort()) {
        lines.push(`## ${type} (${apps.length})`, "");
        for (const app of apps) {
          const flags = [
            app.Active === false ? "inactive" : undefined,
            app.AppID === defaultAppId ? "server default" : undefined,
          ].filter(Boolean);
          lines.push(`- **${app.Name}** — app_id: ${app.AppID}${flags.length ? ` _[${flags.join(", ")}]_` : ""}`);
        }
        lines.push("");
      }
      return truncate(lines.join("\n"));
    },
  }),

  listTool({
    name: "teamdynamix_list_ticket_types",
    title: "List TeamDynamix Ticket Types",
    description:
      "Lists ticket types for a ticketing application.\nA type_id from here is required to create a ticket.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/types`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_statuses",
    title: "List TeamDynamix Ticket Statuses",
    description:
      "Lists ticket statuses for a ticketing application.\nUse for status_id values when creating, updating, or filtering tickets.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/statuses`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_priorities",
    title: "List TeamDynamix Ticket Priorities",
    description:
      "Lists ticket priorities for a ticketing application.\nUse for priority_id values when creating, updating, or filtering tickets.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/priorities`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_sources",
    title: "List TeamDynamix Ticket Sources",
    description: "Lists ticket sources (Email, Phone, Web) for a ticketing application.\nUse for source_id when creating tickets.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/sources`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_forms",
    title: "List TeamDynamix Ticket Forms",
    description: "Lists active ticket forms for a ticketing application.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/forms`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_impacts",
    title: "List TeamDynamix Ticket Impacts",
    description: "Lists ticket impact values for a ticketing application.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/impacts`,
  }),
  listTool({
    name: "teamdynamix_list_ticket_urgencies",
    title: "List TeamDynamix Ticket Urgencies",
    description: "Lists ticket urgency values for a ticketing application.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/tickets/urgencies`,
  }),
  listTool({
    name: "teamdynamix_list_asset_statuses",
    title: "List TeamDynamix Asset Statuses",
    description: "Lists asset statuses for an Assets application.\nRequired when creating or updating assets.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/assets/statuses`,
  }),
  listTool({
    name: "teamdynamix_list_product_models",
    title: "List TeamDynamix Product Models",
    description: "Lists active product models for an Assets application.\nUse for product_model_id when creating or filtering assets.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/assets/models`,
  }),
  listTool({
    name: "teamdynamix_list_ci_types",
    title: "List TeamDynamix CI Types",
    description: "Lists configuration item types for an Assets/CMDB application.\nA type_id from here is required to create a CI.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/cmdb/types`,
  }),
  listTool({
    name: "teamdynamix_list_ci_relationship_types",
    title: "List TeamDynamix CI Relationship Types",
    description:
      "Lists CI relationship types for an Assets/CMDB application.\nRequired by teamdynamix_add_ci_relationship.",
    input: AppScopedInput,
    endpoint: (args) => `/${resolveAppId(args.app_id)}/cmdb/relationshiptypes`,
  }),
  listTool({
    name: "teamdynamix_list_accounts",
    title: "List TeamDynamix Accounts/Departments",
    description:
      "Lists organization Accounts/Departments.\nUse for account_id on tickets, projects, and assets.",
    input: GlobalInput,
    endpoint: () => "/accounts",
  }),
  listTool({
    name: "teamdynamix_list_locations",
    title: "List TeamDynamix Locations",
    description: "Lists active organization locations.\nUse for location_id when creating or filtering assets.",
    input: GlobalInput,
    endpoint: () => "/locations",
  }),

  defineTool({
    name: "teamdynamix_list_custom_attributes",
    title: "List TeamDynamix Custom Attributes",
    description:
      "Lists custom attribute definitions and their valid choice values for a component type.\n" +
      "Use component_id=9 for tickets, 63 for assets/CIs, then pass IDs to create/update tools.",
    input: CustomAttributesInput,
    annotations: READ,
    handler: async (args) => {
      const params: Record<string, unknown> = { componentId: args.component_id };
      if (args.app_id !== undefined) params.appId = args.app_id;
      const cacheKey = `/attributes/custom?${args.component_id}:${args.app_id ?? "all"}`;
      const attrs = await tdRequest<CustomAttribute[]>("/attributes/custom", {
        params,
        cacheKey,
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      });
      return items(attrs ?? []);
    },
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No custom attributes are configured for that component type.",
    render: (data, args) => {
      const lines = [`# Custom Attributes for Component ${args.component_id} (${data.items.length})`, ""];
      for (const attr of data.items) {
        lines.push(`- **${attr.Name}** (ID: ${attr.ID}, type: ${attr.FieldType ?? attr.DataType ?? "unknown"})`);
        for (const choice of attr.Choices ?? []) lines.push(`  - Choice: ${choice.Name} (ID: ${choice.ID})`);
      }
      return truncate(lines.join("\n"));
    },
  }),
];

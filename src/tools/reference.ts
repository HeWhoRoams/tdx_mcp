import { toolName } from "../constants.js";
import { z } from "zod";
import { getConfig } from "../config.js";
import { READ } from "../framework/annotations.js";
import { defineTool, items, type AnyToolDefinition } from "../framework/defineTool.js";
import type { AppKey } from "../policy/availability.js";
import type { ToolDomain } from "../policy/schema.js";
import { AppIdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { handleApiError, tdRequest } from "../services/client.js";
import { resolveAppId } from "../services/context.js";
import { renderNamedList, truncate } from "../services/format.js";
import { ASSET_KINDS, TICKET_KINDS, type KindSpec } from "../services/reference-kinds.js";
import type { TdApp } from "../types.js";

export { TICKET_KINDS };
export type { KindSpec };

export interface NamedRef {
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
      .describe("Only return applications of this type, e.g. 'Ticketing', 'Asset/CI', 'Projects'. Case-insensitive."),
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
  /** The application this lookup needs, or null for a lookup that works in any account. Required so none is forgotten. */
  requiresApp: AppKey | null;
}): AnyToolDefinition {
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    requiresApp: spec.requiresApp,
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

interface ReferenceData {
  /** Requested kinds, in order. */
  kinds: string[];
  reference: Record<string, NamedRef[]>;
  /** A kind that could not be loaded does not fail the others. */
  errors: Record<string, string>;
}

/**
 * Fetches several cached reference lists for one application. Each list is cached under its
 * endpoint path. A list that fails is reported in `errors` without failing the others; `failure`
 * is set only when every list failed, so callers can surface one real error.
 */
export async function loadReference(
  appId: number,
  table: Record<string, KindSpec>,
  requested: string[]
): Promise<ReferenceData & { failure?: unknown }> {
  const kinds = [...new Set(requested)];
  const settled = await Promise.allSettled(
    kinds.map((kind) => {
      const endpoint = `/${appId}/${table[kind]!.path}`;
      return tdRequest<NamedRef[]>(endpoint, { cacheKey: endpoint, cacheTtlMs: getConfig().cache.referenceTtlMs });
    })
  );
  const reference: Record<string, NamedRef[]> = {};
  const errors: Record<string, string> = {};
  let failure: unknown;
  settled.forEach((result, index) => {
    const kind = kinds[index]!;
    if (result.status === "fulfilled") reference[kind] = result.value ?? [];
    else {
      failure ??= result.reason;
      errors[kind] = handleApiError(result.reason);
    }
  });
  const allFailed = Object.keys(errors).length === kinds.length;
  return { kinds, reference, errors, ...(allFailed ? { failure } : {}) };
}

/**
 * One tool over a table of cached reference lookups. Reference data changes rarely and every write
 * path needs it first, so each list is cached for TEAMDYNAMIX_CACHE_TTL_MS under its endpoint path.
 */
function referenceTool(spec: {
  name: string;
  title: string;
  description: string;
  kinds: Record<string, KindSpec>;
  defaults: string[];
  requiresApp: AppKey;
  serves: ToolDomain[];
}): AnyToolDefinition {
  const names = Object.keys(spec.kinds) as [string, ...string[]];
  const input = z
    .object({
      app_id: AppIdSchema,
      kinds: z
        .array(z.enum(names))
        .min(1)
        .optional()
        .describe(`Which lists to return. One or more of: ${names.join(", ")}. Default: ${spec.defaults.join(", ")}.`),
      response_format: ResponseFormatSchema,
    })
    .strict();

  return defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input,
    requiresApp: spec.requiresApp,
    serves: spec.serves,
    annotations: READ,
    handler: async (args): Promise<ReferenceData> => {
      const { failure, ...data } = await loadReference(resolveAppId(args.app_id), spec.kinds, args.kinds ?? spec.defaults);
      // Nothing to show: surface the failure as the tool error instead of a page of error lines.
      if (failure !== undefined) throw failure;
      return data;
    },
    isEmpty: (data) => Object.keys(data.errors).length === 0 && data.kinds.every((kind) => (data.reference[kind] ?? []).length === 0),
    emptyMessage: "No results found.",
    render: (data) =>
      truncate(
        data.kinds
          .map((kind) => {
            const title = spec.kinds[kind]!.title;
            const error = data.errors[kind];
            return error ? `# ${title}\n\n_Could not be loaded: ${error}_` : renderNamedList(title, data.reference[kind] ?? []);
          })
          .join("\n\n")
      ),
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
    name: toolName("list_applications"),
    requiresApp: null,
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

  referenceTool({
    name: toolName("get_ticket_reference"),
    title: "Get TeamDynamix Ticket Reference Data",
    description:
      "Returns ticket reference lists (types, statuses, priorities, sources, forms, impacts, urgencies) for a ticketing application.\n" +
      "Call before creating or filtering tickets: type_id, status_id and priority_id values come from here.",
    kinds: TICKET_KINDS,
    defaults: ["types", "statuses", "priorities"],
    requiresApp: "tickets",
    serves: ["tickets"],
  }),
  referenceTool({
    name: toolName("get_asset_reference"),
    title: "Get TeamDynamix Asset and CI Reference Data",
    description:
      "Returns asset and CMDB reference lists (asset_statuses, product_models, ci_types, ci_relationship_types) for an Asset/CI application.\n" +
      "Call before creating assets or CIs: status_id, type_id and product_model_id values come from here.",
    kinds: ASSET_KINDS,
    defaults: ["asset_statuses", "ci_types"],
    requiresApp: "assets",
    serves: ["assets", "cmdb"],
  }),
  listTool({
    name: toolName("list_accounts"),
    title: "List TeamDynamix Accounts/Departments",
    description:
      "Lists organization Accounts/Departments.\nUse for account_id on tickets, projects, and assets.",
    input: GlobalInput,
    endpoint: () => "/accounts",
    requiresApp: null,
  }),
  listTool({
    name: toolName("list_locations"),
    title: "List TeamDynamix Locations",
    description: "Lists active organization locations.\nUse for location_id when creating or filtering assets.",
    input: GlobalInput,
    endpoint: () => "/locations",
    requiresApp: null,
  }),

  defineTool({
    name: toolName("list_custom_attributes"),
    requiresApp: null,
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

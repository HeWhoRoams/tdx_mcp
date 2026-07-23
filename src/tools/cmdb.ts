import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown, formatDate, nameWithId } from "../services/format.js";
import { AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdCi, TdFeedEntry, paginate } from "../types.js";

// ── Input Schemas ─────────────────────────────────────────────────────────────

const SearchCiInputSchema = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against CI name/serial/tag."),
    serial_number: z.string().optional().describe("Exact serial number to search for."),
    type_ids: z.array(z.number().int()).optional().describe("Filter by CI type IDs (see teamdynamix_list_ci_types)."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by asset status IDs (see teamdynamix_list_asset_statuses)."),
    owning_customer_uids: z.array(z.string()).optional().describe("Filter by owning customer (person) UID."),
    owning_department_ids: z.array(z.number().int()).optional().describe("Filter by owning department/account ID."),
    location_ids: z.array(z.number().int()).optional().describe("Filter by location ID."),
    product_model_ids: z.array(z.number().int()).optional().describe("Filter by product model ID."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetCiInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The configuration item ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateCiInputSchema = z
  .object({
    app_id: AppIdSchema,
    name: z.string().min(1).max(500).describe("The CI name."),
    type_id: z.number().int().positive().describe("The CI type ID (see teamdynamix_list_ci_types)."),
    status_id: z.number().int().positive().describe("The asset/CI status ID (see teamdynamix_list_asset_statuses)."),
    serial_number: z.string().optional(),
    tag: z.string().optional().describe("Asset tag."),
    product_model_id: z.number().int().positive().optional(),
    location_id: z.number().int().positive().optional(),
    owning_customer_uid: z.string().optional().describe("Person UID of the owning customer."),
    owning_department_id: z.number().int().positive().optional().describe("Owning department/account ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateCiInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The CI ID to update."),
    name: z.string().min(1).max(500).optional(),
    status_id: z.number().int().positive().optional(),
    serial_number: z.string().optional(),
    tag: z.string().optional(),
    location_id: z.number().int().positive().optional(),
    owning_customer_uid: z.string().optional(),
    owning_department_id: z.number().int().positive().optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetCiFeedInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The CI ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const AddCiCommentInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The CI ID to comment on."),
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    notify_uids: z.array(z.string()).optional().describe("Person UIDs to notify."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetCiRelationshipsInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The CI ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const AddCiRelationshipInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The source CI ID."),
    related_ci_id: z.number().int().positive().describe("The CI ID to relate to."),
    relationship_type_id: z.number().int().positive().describe("The relationship type ID (see teamdynamix_list_ci_relationship_types)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const RemoveCiRelationshipInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The source CI ID."),
    relationship_id: z.number().int().positive().describe("The relationship record ID to remove (from teamdynamix_get_ci_relationships)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const LinkCiToTicketInputSchema = z
  .object({
    app_id: AppIdSchema,
    ci_id: z.number().int().positive().describe("The CI ID to associate."),
    ticket_id: z.number().int().positive().describe("The ticket ID to link the CI to."),
    response_format: ResponseFormatSchema,
  })
  .strict();

// ── Formatters ────────────────────────────────────────────────────────────────

function formatCiMarkdown(ci: TdCi): string {
  const lines = [
    `## ${ci.Name} (#${ci.ID})`,
    `- **Type**: ${nameWithId(ci.TypeName, ci.TypeID)}`,
    `- **Status**: ${nameWithId(ci.StatusName, ci.StatusID)}`,
    `- **Serial**: ${ci.SerialNumber ?? "N/A"}`,
    `- **Tag**: ${ci.Tag ?? "N/A"}`,
    `- **Model**: ${ci.ProductModelName ?? "N/A"}`,
    `- **Location**: ${ci.LocationName ?? "N/A"}`,
    `- **Owner**: ${ci.OwningCustomerName ?? ci.OwningDepartmentName ?? "N/A"}`,
  ];
  return lines.join("\n");
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerCmdbTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_search_cis",
    {
      title: "Search TeamDynamix Configuration Items",
      description: `Search for configuration items (CIs) in the TeamDynamix CMDB.

CIs are distinct from Assets — they live in the CMDB namespace (/{appId}/cmdb) and support
relationships between CIs (e.g. "Server A hosts Database B"). Use teamdynamix_search_assets for
the Assets namespace.

This is a search (not a full load): descriptions and custom attributes are NOT returned. Use
teamdynamix_get_ci for full details.

Args:
  - app_id (number): The Assets/CMDB application ID
  - search_text (string, optional): Free-text search
  - serial_number (string, optional): Exact serial number match
  - type_ids (number[], optional): Filter by CI type (see teamdynamix_list_ci_types)
  - status_ids (number[], optional): Filter by status (see teamdynamix_list_asset_statuses)
  - owning_customer_uids, owning_department_ids, location_ids, product_model_ids (optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching CIs.

Error Handling:
  - Returns "Error: Resource not found" if app_id is invalid`,
      inputSchema: SearchCiInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.search_text) body.SearchText = params.search_text;
        if (params.serial_number) body.SerialNumber = params.serial_number;
        if (params.type_ids) body.TypeIDs = params.type_ids;
        if (params.status_ids) body.StatusIDs = params.status_ids;
        if (params.owning_customer_uids) body.OwningCustomerUids = params.owning_customer_uids;
        if (params.owning_department_ids) body.OwningDepartmentIDs = params.owning_department_ids;
        if (params.location_ids) body.LocationIDs = params.location_ids;
        if (params.product_model_ids) body.ProductModelIDs = params.product_model_ids;

        const results = await tdRequest<TdCi[]>(`/${params.app_id}/cmdb/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);

        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No configuration items found matching the given criteria." }] };
        }

        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# CI Search Results`, "", `Found ${page.total} item(s), showing ${page.items.length}`, ""];
          for (const ci of page.items) lines.push(formatCiMarkdown(ci), "");
          if (page.has_more) lines.push(`_More results available. Use offset=${page.next_offset} to continue._`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(page);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: page as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_ci",
    {
      title: "Get TeamDynamix Configuration Item",
      description: `Gets full details on a single CI, including description, custom attributes, and all fields omitted from search results.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full CI details.

Error Handling:
  - Returns "Error: Resource not found" if ci_id is invalid`,
      inputSchema: GetCiInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, response_format }) => {
      try {
        const ci = await tdRequest<TdCi>(`/${app_id}/cmdb/${ci_id}`);
        const text = response_format === ResponseFormat.MARKDOWN ? truncateMarkdown(formatCiMarkdown(ci)) : toJsonText(ci);
        return { content: [{ type: "text" as const, text }], structuredContent: ci as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_ci",
    {
      title: "Create TeamDynamix Configuration Item",
      description: `Creates a new configuration item in the TeamDynamix CMDB.

Before calling this tool:
  1. Call teamdynamix_list_applications to get the app_id
  2. Call teamdynamix_list_ci_types to get a valid type_id
  3. Call teamdynamix_list_asset_statuses to get a valid status_id

Args:
  - app_id (number): The Assets/CMDB application ID
  - name (string): CI name
  - type_id (number): CI type ID
  - status_id (number): Status ID
  - serial_number, tag, product_model_id, location_id (optional)
  - owning_customer_uid, owning_department_id (optional)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The newly created CI with its assigned ID.`,
      inputSchema: CreateCiInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          Name: params.name,
          TypeID: params.type_id,
          StatusID: params.status_id,
        };
        if (params.serial_number) body.SerialNumber = params.serial_number;
        if (params.tag) body.Tag = params.tag;
        if (params.product_model_id) body.ProductModelID = params.product_model_id;
        if (params.location_id) body.LocationID = params.location_id;
        if (params.owning_customer_uid) body.OwningCustomerUID = params.owning_customer_uid;
        if (params.owning_department_id) body.OwningDepartmentID = params.owning_department_id;

        const ci = await tdRequest<TdCi>(`/${params.app_id}/cmdb`, "POST", body);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# CI Created\n\n${formatCiMarkdown(ci)}`)
            : toJsonText(ci);
        return { content: [{ type: "text" as const, text }], structuredContent: ci as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_ci",
    {
      title: "Update TeamDynamix Configuration Item",
      description: `Updates an existing CI. Only the fields you provide are changed.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID to update
  - name, status_id, serial_number, tag, location_id, owning_customer_uid, owning_department_id (all optional)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated CI.

Error Handling:
  - Returns "Error: Resource not found" if ci_id is invalid`,
      inputSchema: UpdateCiInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (
          params.name === undefined &&
          params.status_id === undefined &&
          params.serial_number === undefined &&
          params.tag === undefined &&
          params.location_id === undefined &&
          params.owning_customer_uid === undefined &&
          params.owning_department_id === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided." }],
          };
        }
        const existing = await tdRequest<TdCi>(`/${params.app_id}/cmdb/${params.ci_id}`);
        const merged: Record<string, unknown> = {
          ...existing,
          ...(params.name !== undefined ? { Name: params.name } : {}),
          ...(params.status_id !== undefined ? { StatusID: params.status_id } : {}),
          ...(params.serial_number !== undefined ? { SerialNumber: params.serial_number } : {}),
          ...(params.tag !== undefined ? { Tag: params.tag } : {}),
          ...(params.location_id !== undefined ? { LocationID: params.location_id } : {}),
          ...(params.owning_customer_uid !== undefined ? { OwningCustomerUID: params.owning_customer_uid } : {}),
          ...(params.owning_department_id !== undefined ? { OwningDepartmentID: params.owning_department_id } : {}),
        };
        const ci = await tdRequest<TdCi>(`/${params.app_id}/cmdb/${params.ci_id}`, "PUT", merged);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# CI Updated\n\n${formatCiMarkdown(ci)}`)
            : toJsonText(ci);
        return { content: [{ type: "text" as const, text }], structuredContent: ci as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_ci_feed",
    {
      title: "Get TeamDynamix CI Feed",
      description: `Gets the feed entries (comments/updates/history) for a configuration item.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of feed entries.

Error Handling:
  - Returns "Error: Resource not found" if ci_id is invalid`,
      inputSchema: GetCiFeedInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, response_format }) => {
      try {
        const feed = await tdRequest<TdFeedEntry[]>(`/${app_id}/cmdb/${ci_id}/feed`);
        if (!feed || feed.length === 0) {
          return { content: [{ type: "text" as const, text: "No feed entries found for this CI." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Feed for CI #${ci_id}`, ""];
          for (const entry of feed) {
            lines.push(`### ${entry.CreatedByName ?? "Unknown"} — ${formatDate(entry.CreatedDate)}`);
            lines.push(entry.Body ?? "(no content)");
            lines.push("");
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(feed);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: feed } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_add_ci_comment",
    {
      title: "Add Comment to TeamDynamix CI",
      description: `Adds a comment (feed entry) to a configuration item.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID
  - comment (string): The comment text
  - notify_uids (string[], optional): Person UIDs to notify
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation message.

Error Handling:
  - Returns "Error: Resource not found" if ci_id is invalid`,
      inputSchema: AddCiCommentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ app_id, ci_id, comment, notify_uids, response_format }) => {
      try {
        const body: Record<string, unknown> = { Comments: comment };
        if (notify_uids?.length) body.Notify = notify_uids;
        const entry = await tdRequest<TdFeedEntry>(`/${app_id}/cmdb/${ci_id}/feed`, "POST", body);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Comment added to CI #${ci_id} at ${formatDate(entry.CreatedDate)}.`
            : toJsonText(entry);
        return { content: [{ type: "text" as const, text }], structuredContent: entry as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_ci_relationships",
    {
      title: "Get TeamDynamix CI Relationships",
      description: `Gets the relationships defined on a configuration item — e.g. "this server hosts these databases", "this workstation depends on this network switch".

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of CI relationships with related CI IDs, names, and relationship type.

Error Handling:
  - Returns "Error: Resource not found" if ci_id is invalid`,
      inputSchema: GetCiRelationshipsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, response_format }) => {
      try {
        const rels = await tdRequest<Array<Record<string, unknown>>>(`/${app_id}/cmdb/${ci_id}/relationships`);
        if (!rels || rels.length === 0) {
          return { content: [{ type: "text" as const, text: "No relationships found for this CI." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Relationships for CI #${ci_id}`, ""];
          for (const r of rels) {
            lines.push(
              `- **${r.TypeName ?? r.TypeID ?? "Relationship"}** → ${r.RelatedConfigurationItemName ?? r.RelatedConfigurationItemID} (#${r.RelatedConfigurationItemID}) [rel ID: ${r.ID}]`
            );
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(rels);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: rels } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_add_ci_relationship",
    {
      title: "Add TeamDynamix CI Relationship",
      description: `Adds a relationship between two configuration items — e.g. linking a server to the databases it hosts, or a workstation to its network switch.

Before calling this tool, call teamdynamix_list_ci_relationship_types to find valid relationship_type_id values.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The source CI ID
  - related_ci_id (number): The CI to relate to
  - relationship_type_id (number): The relationship type (see teamdynamix_list_ci_relationship_types)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation with the created relationship details.

Error Handling:
  - Returns "Error: Resource not found" if either CI ID or relationship type ID is invalid`,
      inputSchema: AddCiRelationshipInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, related_ci_id, relationship_type_id, response_format }) => {
      try {
        const body = { RelatedConfigurationItemID: related_ci_id, TypeID: relationship_type_id };
        const result = await tdRequest<Record<string, unknown>>(`/${app_id}/cmdb/${ci_id}/relationships`, "PUT", body);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Relationship added: CI #${ci_id} → CI #${related_ci_id} (type ID ${relationship_type_id}).`
            : toJsonText(result);
        return { content: [{ type: "text" as const, text }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_remove_ci_relationship",
    {
      title: "Remove TeamDynamix CI Relationship",
      description: `Removes a relationship from a configuration item. Use teamdynamix_get_ci_relationships first to find the relationship_id.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The source CI ID
  - relationship_id (number): The relationship record ID to remove
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation message.

Error Handling:
  - Returns "Error: Resource not found" if the relationship or CI is invalid`,
      inputSchema: RemoveCiRelationshipInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, relationship_id, response_format }) => {
      try {
        await tdRequest<unknown>(`/${app_id}/cmdb/${ci_id}/relationships/${relationship_id}`, "DELETE");
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Relationship #${relationship_id} removed from CI #${ci_id}.`
            : toJsonText({ removed: true, ci_id, relationship_id });
        return { content: [{ type: "text" as const, text }], structuredContent: { removed: true, ci_id, relationship_id } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_link_ci_to_ticket",
    {
      title: "Link TeamDynamix CI to Ticket",
      description: `Associates a configuration item with a ticket — records that this CI is involved in, affected by, or related to the ticket.

Args:
  - app_id (number): The Assets/CMDB application ID
  - ci_id (number): The CI ID to associate
  - ticket_id (number): The ticket ID to link to
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation message.

Error Handling:
  - Returns "Error: Resource not found" if either ID is invalid`,
      inputSchema: LinkCiToTicketInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ci_id, ticket_id, response_format }) => {
      try {
        await tdRequest<unknown>(`/${app_id}/cmdb/${ci_id}/tickets/${ticket_id}`, "POST");
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `CI #${ci_id} linked to ticket #${ticket_id}.`
            : toJsonText({ linked: true, ci_id, ticket_id });
        return { content: [{ type: "text" as const, text }], structuredContent: { linked: true, ci_id, ticket_id } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

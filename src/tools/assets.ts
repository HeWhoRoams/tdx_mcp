import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown, nameWithId } from "../services/format.js";
import { AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdAsset, TdFeedEntry, paginate } from "../types.js";

const SearchAssetsInputSchema = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against asset name/tag/serial number."),
    serial_number: z.string().optional().describe("Exact serial number to search for."),
    status_ids: z.array(z.number().int()).optional().describe("Filter to these AssetStatus IDs."),
    owning_customer_uids: z.array(z.string()).optional().describe("Filter by owning customer (person) UID."),
    owning_department_ids: z.array(z.number().int()).optional().describe("Filter by owning department/account ID."),
    location_ids: z.array(z.number().int()).optional().describe("Filter by location ID."),
    product_model_ids: z.array(z.number().int()).optional().describe("Filter by product model ID."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetAssetInputSchema = z
  .object({
    app_id: AppIdSchema,
    asset_id: z.number().int().positive().describe("The asset ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateAssetInputSchema = z
  .object({
    app_id: AppIdSchema,
    name: z.string().min(1).max(500).describe("The asset name."),
    status_id: z.number().int().positive().describe("The AssetStatus ID (see teamdynamix_list_asset_statuses)."),
    serial_number: z.string().optional(),
    tag: z.string().optional().describe("Asset tag."),
    product_model_id: z.number().int().positive().optional(),
    location_id: z.number().int().positive().optional(),
    owning_customer_uid: z.string().optional().describe("Person UID of the owning customer."),
    owning_department_id: z.number().int().positive().optional().describe("Owning department/account ID."),
    custom_attributes: z
      .array(z.object({ ID: z.number().int(), Value: z.string() }))
      .optional()
      .describe("Custom attribute values to set. Use teamdynamix_list_custom_attributes (component_id=63) to discover IDs."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateAssetInputSchema = z
  .object({
    app_id: AppIdSchema,
    asset_id: z.number().int().positive().describe("The asset ID to update."),
    name: z.string().min(1).max(500).optional(),
    status_id: z.number().int().positive().optional(),
    serial_number: z.string().optional(),
    tag: z.string().optional(),
    location_id: z.number().int().positive().optional(),
    owning_customer_uid: z.string().optional(),
    owning_department_id: z.number().int().positive().optional(),
    custom_attributes: z
      .array(z.object({ ID: z.number().int(), Value: z.string() }))
      .optional()
      .describe("Custom attribute values to update. Use teamdynamix_list_custom_attributes (component_id=63) to discover IDs."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetAssetFeedInputSchema = z
  .object({
    app_id: AppIdSchema,
    asset_id: z.number().int().positive().describe("The asset ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const AddAssetCommentInputSchema = z
  .object({
    app_id: AppIdSchema,
    asset_id: z.number().int().positive().describe("The asset ID to comment on."),
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    notify_uids: z.array(z.string()).optional().describe("Person UIDs to notify."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function formatAssetMarkdown(a: TdAsset): string {
  return [
    `## ${a.Name} (#${a.ID})`,
    `- **Status**: ${nameWithId(a.StatusName, a.StatusID)}`,
    `- **Tag**: ${a.Tag ?? "N/A"}`,
    `- **Serial Number**: ${a.SerialNumber ?? "N/A"}`,
    `- **Product Model**: ${a.ProductModelName ?? "N/A"}`,
    `- **Location**: ${a.LocationName ?? "N/A"}`,
    `- **Owning Customer**: ${a.OwningCustomerName ?? "N/A"}`,
    `- **Owning Department**: ${a.OwningDepartmentName ?? "N/A"}`,
  ].join("\n");
}

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_search_assets",
    {
      title: "Search TeamDynamix Assets",
      description: `Search for assets/configuration items in a TeamDynamix Assets/CI application.

This is a search (not a full load): custom attributes are NOT returned for each result. Use teamdynamix_get_asset for full details.

Args:
  - app_id (number): The Assets/CI application ID (use teamdynamix_list_applications)
  - search_text, serial_number (string, optional)
  - status_ids, owning_department_ids, location_ids, product_model_ids (number[], optional)
  - owning_customer_uids (string[], optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching assets.

Examples:
  - Use when: "Find all laptops assigned to John" -> search_text + owning_customer_uids
  - Don't use when: You already have the asset ID (use teamdynamix_get_asset)

Error Handling:
  - Returns "No assets found matching the given criteria" if search is empty`,
      inputSchema: SearchAssetsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const fetchCount = Math.min(params.offset + params.limit, 1000);
        const body: Record<string, unknown> = { MaxResults: fetchCount };
        if (params.search_text) body.SearchText = params.search_text;
        if (params.serial_number) body.SerialLike = params.serial_number;
        if (params.status_ids) body.StatusIDs = params.status_ids;
        if (params.owning_customer_uids) body.CustomerIDs = params.owning_customer_uids;
        if (params.owning_department_ids) body.OwningDepartmentIDs = params.owning_department_ids;
        if (params.location_ids) body.LocationIDs = params.location_ids;
        if (params.product_model_ids) body.ProductModelIDs = params.product_model_ids;

        const results = await tdRequest<TdAsset[]>(`/${params.app_id}/assets/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);

        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No assets found matching the given criteria." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Asset Search Results`, "", `Found ${page.total} asset(s), showing ${page.items.length}`, ""];
          for (const a of page.items) lines.push(formatAssetMarkdown(a), "");
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
    "teamdynamix_get_asset",
    {
      title: "Get TeamDynamix Asset",
      description: `Gets full details on a single asset/configuration item, including custom attributes.

Args:
  - app_id (number): The Assets/CI application ID
  - asset_id (number): The asset ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full asset details.

Error Handling:
  - Returns "Error: Resource not found" if asset_id or app_id is invalid`,
      inputSchema: GetAssetInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, asset_id, response_format }) => {
      try {
        const asset = await tdRequest<TdAsset>(`/${app_id}/assets/${asset_id}`);
        const text =
          response_format === ResponseFormat.MARKDOWN ? truncateMarkdown(formatAssetMarkdown(asset)) : toJsonText(asset);
        return { content: [{ type: "text" as const, text }], structuredContent: asset as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_asset",
    {
      title: "Create TeamDynamix Asset",
      description: `Creates a new asset/configuration item.

Args:
  - app_id (number): The Assets/CI application ID
  - name (string): Asset name
  - status_id (number): AssetStatus ID (see teamdynamix_list_asset_statuses)
  - serial_number, tag, product_model_id, location_id, owning_customer_uid, owning_department_id (optional)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The newly created asset, including its assigned ID.

Error Handling:
  - Returns "Error: ... rejected the request as invalid (400)" if required fields are missing`,
      inputSchema: CreateAssetInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { Name: params.name, StatusID: params.status_id };
        if (params.serial_number) body.SerialNumber = params.serial_number;
        if (params.tag) body.Tag = params.tag;
        if (params.product_model_id) body.ProductModelID = params.product_model_id;
        if (params.location_id) body.LocationID = params.location_id;
        if (params.owning_customer_uid) body.OwningCustomerID = params.owning_customer_uid;
        if (params.owning_department_id) body.OwningDepartmentID = params.owning_department_id;
        if (params.custom_attributes) body.Attributes = params.custom_attributes;

        const asset = await tdRequest<TdAsset>(`/${params.app_id}/assets`, "POST", body);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Asset Created\n\n${formatAssetMarkdown(asset)}`)
            : toJsonText(asset);
        return { content: [{ type: "text" as const, text }], structuredContent: asset as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_asset",
    {
      title: "Update TeamDynamix Asset",
      description: `Patches an existing asset, changing only the fields provided.

Args:
  - app_id (number): The Assets/CI application ID
  - asset_id (number): The asset ID to update
  - name, status_id, serial_number, tag, location_id, owning_customer_uid, owning_department_id (all optional; at least one required)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated asset.

Error Handling:
  - Returns "Error: Resource not found" if asset_id is invalid`,
      inputSchema: UpdateAssetInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const ops: Array<{ op: "replace"; path: string; value: unknown }> = [];
        if (
          params.name === undefined &&
          params.status_id === undefined &&
          params.serial_number === undefined &&
          params.tag === undefined &&
          params.location_id === undefined &&
          params.owning_customer_uid === undefined &&
          params.owning_department_id === undefined &&
          params.custom_attributes === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided (name, status_id, serial_number, tag, location_id, owning_customer_uid, owning_department_id, or custom_attributes)." }],
          };
        }
        if (params.name !== undefined) ops.push({ op: "replace", path: "/Name", value: params.name });
        if (params.status_id !== undefined) ops.push({ op: "replace", path: "/StatusID", value: params.status_id });
        if (params.serial_number !== undefined) ops.push({ op: "replace", path: "/SerialNumber", value: params.serial_number });
        if (params.tag !== undefined) ops.push({ op: "replace", path: "/Tag", value: params.tag });
        if (params.location_id !== undefined) ops.push({ op: "replace", path: "/LocationID", value: params.location_id });
        if (params.owning_customer_uid !== undefined)
          ops.push({ op: "replace", path: "/OwningCustomerID", value: params.owning_customer_uid });
        if (params.owning_department_id !== undefined)
          ops.push({ op: "replace", path: "/OwningDepartmentID", value: params.owning_department_id });
        if (params.custom_attributes !== undefined)
          ops.push({ op: "replace", path: "/Attributes", value: params.custom_attributes });

        const asset = await tdRequest<TdAsset>(`/${params.app_id}/assets/${params.asset_id}`, "PATCH", ops);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Asset Updated\n\n${formatAssetMarkdown(asset)}`)
            : toJsonText(asset);
        return { content: [{ type: "text" as const, text }], structuredContent: asset as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_asset_feed",
    {
      title: "Get TeamDynamix Asset Feed",
      description: `Gets the feed entries (comments/history) for an asset, newest first.

Args:
  - app_id (number): The Assets/CI application ID
  - asset_id (number): The asset ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of feed entries.

Error Handling:
  - Returns "Error: Resource not found" if asset_id is invalid`,
      inputSchema: GetAssetFeedInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, asset_id, response_format }) => {
      try {
        const feed = await tdRequest<TdFeedEntry[]>(`/${app_id}/assets/${asset_id}/feed`);
        if (!feed || feed.length === 0) {
          return { content: [{ type: "text" as const, text: "No feed entries found for this asset." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Feed for Asset #${asset_id}`, ""];
          for (const entry of feed) {
            lines.push(`### ${entry.CreatedByName ?? "Unknown"} — ${entry.CreatedDate ?? "N/A"}`);
            lines.push(entry.Body ?? "(no content)");
            lines.push("");
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(feed);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_add_asset_comment",
    {
      title: "Add TeamDynamix Asset Comment",
      description: `Adds a comment (feed entry) to an asset.

Args:
  - app_id (number): The Assets/CI application ID
  - asset_id (number): The asset ID
  - comment (string): The comment text
  - notify_uids (string[], optional): Person UIDs to notify
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The created feed entry.

Error Handling:
  - Returns "Error: Resource not found" if asset_id is invalid`,
      inputSchema: AddAssetCommentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ app_id, asset_id, comment, notify_uids, response_format }) => {
      try {
        const body: Record<string, unknown> = { Comments: comment };
        if (notify_uids?.length) body.Notify = notify_uids;
        const entry = await tdRequest<TdFeedEntry>(`/${app_id}/assets/${asset_id}/feed`, "POST", body);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Comment added to asset #${asset_id}.`
            : toJsonText(entry);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

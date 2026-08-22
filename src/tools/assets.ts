import { z } from "zod";
import { getConfig } from "../config.js";
import { CREATE, MUTATE, READ } from "../framework/annotations.js";
import { defineTool, ToolInputError, type AnyToolDefinition } from "../framework/defineTool.js";
import {
  AppIdSchema,
  AttributesSchema,
  ChildPagingShape,
  PagingShape,
  PersonRefSchema,
  ResponseFormatSchema,
  VerbositySchema,
  sortBySchema,
} from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolveAppId, resolvePersonUid, resolvePersonUids } from "../services/context.js";
import { nameWithId, renderFeed } from "../services/format.js";
import { combineHints, referenceHint } from "../services/hints.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";
import { paginate, type TdAsset, type TdFeedEntry } from "../types.js";

const AssetIdSchema = z.number().int().positive().describe("The asset ID.");

const SORT_FIELDS = { name: "Name", status: "StatusID", id: "ID" };

const SearchInput = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against asset name/tag/serial number."),
    serial_number: z.string().optional().describe("Exact serial number to search for."),
    status_ids: z.array(z.number().int()).optional().describe("Filter to these AssetStatus IDs."),
    owning_customer_uids: z.array(z.string()).optional().describe("Filter by owning customer. Accepts UIDs or email addresses."),
    owning_department_ids: z.array(z.number().int()).optional().describe("Filter by owning department/account ID."),
    location_ids: z.array(z.number().int()).optional().describe("Filter by location ID."),
    product_model_ids: z.array(z.number().int()).optional().describe("Filter by product model ID."),
    sort_by: sortBySchema(["name", "status", "id"]),
    verbosity: VerbositySchema,
    ...PagingShape,
  })
  .strict();

const GetInput = z.object({ app_id: AppIdSchema, asset_id: AssetIdSchema, response_format: ResponseFormatSchema }).strict();

const CreateInput = z
  .object({
    app_id: AppIdSchema,
    name: z.string().min(1).max(500).describe("The asset name."),
    status_id: z.number().int().positive().describe("The AssetStatus ID (see teamdynamix_list_asset_statuses)."),
    serial_number: z.string().optional().describe("Serial number."),
    tag: z.string().optional().describe("Asset tag."),
    product_model_id: z.number().int().positive().optional().describe("Product model ID (see teamdynamix_list_product_models)."),
    location_id: z.number().int().positive().optional().describe("Location ID (see teamdynamix_list_locations)."),
    owning_customer_uid: PersonRefSchema("The owning customer").optional(),
    owning_department_id: z.number().int().positive().optional().describe("Owning department/account ID."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateInput = z
  .object({
    app_id: AppIdSchema,
    asset_id: AssetIdSchema,
    name: z.string().min(1).max(500).optional().describe("New asset name."),
    status_id: z.number().int().positive().optional().describe("New AssetStatus ID."),
    serial_number: z.string().optional().describe("New serial number."),
    tag: z.string().optional().describe("New asset tag."),
    location_id: z.number().int().positive().optional().describe("New location ID."),
    owning_customer_uid: PersonRefSchema("The new owning customer").optional(),
    owning_department_id: z.number().int().positive().optional().describe("New owning department/account ID."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const FeedInput = z.object({ app_id: AppIdSchema, asset_id: AssetIdSchema, ...ChildPagingShape }).strict();

const CommentInput = z
  .object({
    app_id: AppIdSchema,
    asset_id: AssetIdSchema,
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    notify_uids: z.array(z.string()).optional().describe("People to notify. Accepts UIDs or email addresses."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function renderAsset(asset: TdAsset): string {
  return [
    `## ${asset.Name} (#${asset.ID})`,
    `- **Status**: ${nameWithId(asset.StatusName, asset.StatusID)}`,
    `- **Tag**: ${asset.Tag ?? "N/A"}`,
    `- **Serial Number**: ${asset.SerialNumber ?? "N/A"}`,
    `- **Product Model**: ${asset.ProductModelName ?? "N/A"}`,
    `- **Location**: ${asset.LocationName ?? "N/A"}`,
    `- **Owning Customer**: ${asset.OwningCustomerName ?? "N/A"}`,
    `- **Owning Department**: ${asset.OwningDepartmentName ?? "N/A"}`,
  ].join("\n");
}

function renderAssetCompact(asset: TdAsset): string {
  const identifiers = [asset.Tag, asset.SerialNumber].filter(Boolean).join(" / ") || "no tag/serial";
  return `- **#${asset.ID}** ${asset.Name} — ${asset.StatusName ?? "?"} — ${identifiers}`;
}

const ASSETS = { domain: "assets", appIdFrom: (args: { app_id?: number }) => resolveAppId(args.app_id) };

function assetWriteHints(args: { app_id?: number }): string | undefined {
  const appId = resolveAppId(args.app_id);
  return combineHints(referenceHint(appId, "assets/statuses", "status_id values"));
}

export const assetTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_search_assets",
    title: "Search TeamDynamix Assets",
    description:
      "Searches assets by text, serial, status, owner, location, or product model.\n" +
      "Returns partial records without custom attributes — use teamdynamix_get_asset for full detail.\n" +
      "For CMDB configuration items use teamdynamix_search_cis instead.",
    input: SearchInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.serial_number) body.SerialLike = args.serial_number;
      if (args.status_ids) body.StatusIDs = args.status_ids;
      const owners = await resolvePersonUids(args.owning_customer_uids);
      if (owners) body.CustomerIDs = owners;
      if (args.owning_department_ids) body.OwningDepartmentIDs = args.owning_department_ids;
      if (args.location_ids) body.LocationIDs = args.location_ids;
      if (args.product_model_ids) body.ProductModelIDs = args.product_model_ids;
      return searchPage<TdAsset>(`/${resolveAppId(args.app_id)}/assets/search`, body, args, {
        sortFields: SORT_FIELDS,
      });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No assets found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "asset");
      const lines = resultsHeading("Asset Search Results", page, "asset");
      if (args.verbosity === "compact") {
        for (const asset of page.items) lines.push(renderAssetCompact(asset));
        lines.push("");
      } else {
        for (const asset of page.items) lines.push(renderAsset(asset), "");
      }
      lines.push(...pagingFooter(page));
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_get_asset",
    title: "Get TeamDynamix Asset",
    description: "Gets one asset in full, including custom attributes that search results omit.",
    input: GetInput,
    annotations: READ,
    handler: (args) => {
      const path = `/${resolveAppId(args.app_id)}/assets/${args.asset_id}`;
      return tdRequest<TdAsset>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
    },
    render: (asset) => renderAsset(asset),
  }),

  defineTool({
    name: "teamdynamix_create_asset",
    title: "Create TeamDynamix Asset",
    description:
      "Creates an asset. Requires name and status_id.\nLook up status_id with teamdynamix_list_asset_statuses first.",
    input: CreateInput,
    annotations: CREATE,
    invalidates: ASSETS,
    errorHints: assetWriteHints,
    handler: async (args) => {
      const body: Record<string, unknown> = { Name: args.name, StatusID: args.status_id };
      if (args.serial_number) body.SerialNumber = args.serial_number;
      if (args.tag) body.Tag = args.tag;
      if (args.product_model_id) body.ProductModelID = args.product_model_id;
      if (args.location_id) body.LocationID = args.location_id;
      if (args.owning_customer_uid) body.OwningCustomerID = await resolvePersonUid(args.owning_customer_uid);
      if (args.owning_department_id) body.OwningDepartmentID = args.owning_department_id;
      if (args.custom_attributes) body.Attributes = args.custom_attributes;
      return tdRequest<TdAsset>(`/${resolveAppId(args.app_id)}/assets`, { method: "POST", data: body });
    },
    render: (asset) => `# Asset Created\n\n${renderAsset(asset)}`,
  }),

  defineTool({
    name: "teamdynamix_update_asset",
    title: "Update TeamDynamix Asset",
    description: "Patches an asset, changing only the fields you supply.\nAt least one updatable field is required.",
    input: UpdateInput,
    annotations: MUTATE,
    invalidates: ASSETS,
    errorHints: assetWriteHints,
    handler: async (args) => {
      const operations: Array<{ op: "replace"; path: string; value: unknown }> = [];
      const add = (path: string, value: unknown) => {
        if (value !== undefined) operations.push({ op: "replace", path, value });
      };
      add("/Name", args.name);
      add("/StatusID", args.status_id);
      add("/SerialNumber", args.serial_number);
      add("/Tag", args.tag);
      add("/LocationID", args.location_id);
      add("/OwningCustomerID", args.owning_customer_uid ? await resolvePersonUid(args.owning_customer_uid) : undefined);
      add("/OwningDepartmentID", args.owning_department_id);
      add("/Attributes", args.custom_attributes);
      if (operations.length === 0) {
        throw new ToolInputError(
          "At least one field to update must be provided (name, status_id, serial_number, tag, location_id, owning_customer_uid, owning_department_id, or custom_attributes)."
        );
      }
      return tdRequest<TdAsset>(`/${resolveAppId(args.app_id)}/assets/${args.asset_id}`, {
        method: "PATCH",
        data: operations,
      });
    },
    render: (asset) => `# Asset Updated\n\n${renderAsset(asset)}`,
  }),

  defineTool({
    name: "teamdynamix_get_asset_feed",
    title: "Get TeamDynamix Asset Feed",
    description: "Gets an asset's feed entries (comments and history), newest first.\nPage with limit/offset.",
    input: FeedInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/assets/${args.asset_id}/feed`;
      const feed = await tdRequest<TdFeedEntry[]>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(feed ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No feed entries found for this asset.",
    render: (page, args) => {
      const body = renderFeed(`Feed for Asset #${args.asset_id} (${page.count} of ${page.total})`, page.items);
      return page.has_more ? `${body}\n_More entries available. Use offset=${page.next_offset}._` : body;
    },
  }),

  defineTool({
    name: "teamdynamix_add_asset_comment",
    title: "Add TeamDynamix Asset Comment",
    description: "Adds a comment (feed entry) to an asset, optionally notifying people.",
    input: CommentInput,
    annotations: CREATE,
    invalidates: ASSETS,
    handler: async (args) => {
      const body: Record<string, unknown> = { Comments: args.comment };
      const notify = await resolvePersonUids(args.notify_uids);
      if (notify?.length) body.Notify = notify;
      return tdRequest<TdFeedEntry>(`/${resolveAppId(args.app_id)}/assets/${args.asset_id}/feed`, {
        method: "POST",
        data: body,
      });
    },
    render: (_entry, args) => `Comment added to asset #${args.asset_id}.`,
  }),
];

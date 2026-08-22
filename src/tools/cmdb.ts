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
import { formatDate, nameWithId, renderFeed, truncate } from "../services/format.js";
import { combineHints, referenceHint } from "../services/hints.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";
import { paginate, type TdCi, type TdFeedEntry } from "../types.js";

const CiIdSchema = z.number().int().positive().describe("The configuration item ID.");

const SORT_FIELDS = { name: "Name", status: "StatusID", id: "ID" };

const SearchInput = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against CI name/serial/tag."),
    serial_number: z.string().optional().describe("Exact serial number to search for."),
    type_ids: z.array(z.number().int()).optional().describe("Filter by CI type IDs (see teamdynamix_list_ci_types)."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by asset status IDs (see teamdynamix_list_asset_statuses)."),
    owning_customer_uids: z.array(z.string()).optional().describe("Filter by owning customer. Accepts UIDs or email addresses."),
    owning_department_ids: z.array(z.number().int()).optional().describe("Filter by owning department/account ID."),
    location_ids: z.array(z.number().int()).optional().describe("Filter by location ID."),
    product_model_ids: z.array(z.number().int()).optional().describe("Filter by product model ID."),
    sort_by: sortBySchema(["name", "status", "id"]),
    verbosity: VerbositySchema,
    ...PagingShape,
  })
  .strict();

const GetInput = z.object({ app_id: AppIdSchema, ci_id: CiIdSchema, response_format: ResponseFormatSchema }).strict();

const CreateInput = z
  .object({
    app_id: AppIdSchema,
    name: z.string().min(1).max(500).describe("The CI name."),
    type_id: z.number().int().positive().describe("The CI type ID (see teamdynamix_list_ci_types)."),
    status_id: z.number().int().positive().describe("The asset/CI status ID (see teamdynamix_list_asset_statuses)."),
    serial_number: z.string().optional().describe("Serial number."),
    tag: z.string().optional().describe("Asset tag."),
    product_model_id: z.number().int().positive().optional().describe("Product model ID."),
    location_id: z.number().int().positive().optional().describe("Location ID."),
    owning_customer_uid: PersonRefSchema("The owning customer").optional(),
    owning_department_id: z.number().int().positive().optional().describe("Owning department/account ID."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateInput = z
  .object({
    app_id: AppIdSchema,
    ci_id: CiIdSchema,
    name: z.string().min(1).max(500).optional().describe("New CI name."),
    status_id: z.number().int().positive().optional().describe("New status ID."),
    serial_number: z.string().optional().describe("New serial number."),
    tag: z.string().optional().describe("New asset tag."),
    location_id: z.number().int().positive().optional().describe("New location ID."),
    owning_customer_uid: PersonRefSchema("The new owning customer").optional(),
    owning_department_id: z.number().int().positive().optional().describe("New owning department/account ID."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const FeedInput = z.object({ app_id: AppIdSchema, ci_id: CiIdSchema, ...ChildPagingShape }).strict();

const CommentInput = z
  .object({
    app_id: AppIdSchema,
    ci_id: CiIdSchema,
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    notify_uids: z.array(z.string()).optional().describe("People to notify. Accepts UIDs or email addresses."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const RelationshipsInput = z.object({ app_id: AppIdSchema, ci_id: CiIdSchema, ...ChildPagingShape }).strict();

const AddRelationshipInput = z
  .object({
    app_id: AppIdSchema,
    ci_id: CiIdSchema,
    related_ci_id: z.number().int().positive().describe("The CI ID to relate to."),
    relationship_type_id: z
      .number()
      .int()
      .positive()
      .describe("The relationship type ID (see teamdynamix_list_ci_relationship_types)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const RemoveRelationshipInput = z
  .object({
    app_id: AppIdSchema,
    ci_id: CiIdSchema,
    relationship_id: z
      .number()
      .int()
      .positive()
      .describe("The relationship record ID to remove (from teamdynamix_get_ci_relationships)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const LinkTicketInput = z
  .object({
    app_id: AppIdSchema,
    ci_id: CiIdSchema,
    ticket_id: z.number().int().positive().describe("The ticket ID to link the CI to."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function renderCi(ci: TdCi): string {
  return [
    `## ${ci.Name} (#${ci.ID})`,
    `- **Type**: ${nameWithId(ci.TypeName, ci.TypeID)}`,
    `- **Status**: ${nameWithId(ci.StatusName, ci.StatusID)}`,
    `- **Serial**: ${ci.SerialNumber ?? "N/A"}`,
    `- **Tag**: ${ci.Tag ?? "N/A"}`,
    `- **Model**: ${ci.ProductModelName ?? "N/A"}`,
    `- **Location**: ${ci.LocationName ?? "N/A"}`,
    `- **Owner**: ${ci.OwningCustomerName ?? ci.OwningDepartmentName ?? "N/A"}`,
  ].join("\n");
}

function renderCiCompact(ci: TdCi): string {
  return `- **#${ci.ID}** ${ci.Name} — ${ci.TypeName ?? "?"}, ${ci.StatusName ?? "?"}`;
}

const CMDB = { domain: "cmdb", appIdFrom: (args: { app_id?: number }) => resolveAppId(args.app_id) };

function ciWriteHints(args: { app_id?: number }): string | undefined {
  const appId = resolveAppId(args.app_id);
  return combineHints(
    referenceHint(appId, "cmdb/types", "type_id values"),
    referenceHint(appId, "assets/statuses", "status_id values")
  );
}

export const cmdbTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_search_cis",
    title: "Search TeamDynamix Configuration Items",
    description:
      "Searches CMDB configuration items by text, serial, type, status, owner, location, or model.\n" +
      "CIs are a separate namespace from Assets and support CI-to-CI relationships; use teamdynamix_search_assets for assets.\n" +
      "Returns partial records — use teamdynamix_get_ci for full detail.",
    input: SearchInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.serial_number) body.SerialNumber = args.serial_number;
      if (args.type_ids) body.TypeIDs = args.type_ids;
      if (args.status_ids) body.StatusIDs = args.status_ids;
      const owners = await resolvePersonUids(args.owning_customer_uids);
      if (owners) body.OwningCustomerUids = owners;
      if (args.owning_department_ids) body.OwningDepartmentIDs = args.owning_department_ids;
      if (args.location_ids) body.LocationIDs = args.location_ids;
      if (args.product_model_ids) body.ProductModelIDs = args.product_model_ids;
      return searchPage<TdCi>(`/${resolveAppId(args.app_id)}/cmdb/search`, body, args, { sortFields: SORT_FIELDS });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No configuration items found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "configuration item");
      const lines = resultsHeading("CI Search Results", page, "item");
      if (args.verbosity === "compact") {
        for (const ci of page.items) lines.push(renderCiCompact(ci));
        lines.push("");
      } else {
        for (const ci of page.items) lines.push(renderCi(ci), "");
      }
      lines.push(...pagingFooter(page));
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_get_ci",
    title: "Get TeamDynamix Configuration Item",
    description: "Gets one CI in full, including description and custom attributes that search results omit.",
    input: GetInput,
    annotations: READ,
    handler: (args) => {
      const path = `/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}`;
      return tdRequest<TdCi>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
    },
    render: (ci) => renderCi(ci),
  }),

  defineTool({
    name: "teamdynamix_create_ci",
    title: "Create TeamDynamix Configuration Item",
    description:
      "Creates a CMDB configuration item. Requires name, type_id, and status_id.\n" +
      "Get type_id from teamdynamix_list_ci_types and status_id from teamdynamix_list_asset_statuses first.",
    input: CreateInput,
    annotations: CREATE,
    invalidates: CMDB,
    errorHints: ciWriteHints,
    handler: async (args) => {
      const body: Record<string, unknown> = { Name: args.name, TypeID: args.type_id, StatusID: args.status_id };
      if (args.serial_number) body.SerialNumber = args.serial_number;
      if (args.tag) body.Tag = args.tag;
      if (args.product_model_id) body.ProductModelID = args.product_model_id;
      if (args.location_id) body.LocationID = args.location_id;
      if (args.owning_customer_uid) body.OwningCustomerUID = await resolvePersonUid(args.owning_customer_uid);
      if (args.owning_department_id) body.OwningDepartmentID = args.owning_department_id;
      if (args.custom_attributes) body.Attributes = args.custom_attributes;
      return tdRequest<TdCi>(`/${resolveAppId(args.app_id)}/cmdb`, { method: "POST", data: body });
    },
    render: (ci) => `# CI Created\n\n${renderCi(ci)}`,
  }),

  defineTool({
    name: "teamdynamix_update_ci",
    title: "Update TeamDynamix Configuration Item",
    description:
      "Updates a CI, changing only the fields you supply.\n" +
      "Uses read-modify-write because TeamDynamix has no PATCH here, so concurrent edits can overwrite each other.",
    input: UpdateInput,
    annotations: MUTATE,
    invalidates: CMDB,
    errorHints: ciWriteHints,
    handler: async (args) => {
      const changes: Record<string, unknown> = {};
      if (args.name !== undefined) changes.Name = args.name;
      if (args.status_id !== undefined) changes.StatusID = args.status_id;
      if (args.serial_number !== undefined) changes.SerialNumber = args.serial_number;
      if (args.tag !== undefined) changes.Tag = args.tag;
      if (args.location_id !== undefined) changes.LocationID = args.location_id;
      if (args.owning_customer_uid !== undefined) {
        changes.OwningCustomerUID = await resolvePersonUid(args.owning_customer_uid);
      }
      if (args.owning_department_id !== undefined) changes.OwningDepartmentID = args.owning_department_id;
      if (args.custom_attributes !== undefined) changes.Attributes = args.custom_attributes;
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError("At least one field to update must be provided.");
      }
      const path = `/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}`;
      const existing = await tdRequest<TdCi>(path);
      return tdRequest<TdCi>(path, { method: "PUT", data: { ...existing, ...changes } });
    },
    render: (ci) => `# CI Updated\n\n${renderCi(ci)}`,
  }),

  defineTool({
    name: "teamdynamix_get_ci_feed",
    title: "Get TeamDynamix CI Feed",
    description: "Gets a CI's feed entries (comments, updates, history), newest first.\nPage with limit/offset.",
    input: FeedInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/feed`;
      const feed = await tdRequest<TdFeedEntry[]>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(feed ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No feed entries found for this CI.",
    render: (page, args) => {
      const body = renderFeed(`Feed for CI #${args.ci_id} (${page.count} of ${page.total})`, page.items);
      return page.has_more ? `${body}\n_More entries available. Use offset=${page.next_offset}._` : body;
    },
  }),

  defineTool({
    name: "teamdynamix_add_ci_comment",
    title: "Add Comment to TeamDynamix CI",
    description: "Adds a comment (feed entry) to a configuration item, optionally notifying people.",
    input: CommentInput,
    annotations: CREATE,
    invalidates: CMDB,
    handler: async (args) => {
      const body: Record<string, unknown> = { Comments: args.comment };
      const notify = await resolvePersonUids(args.notify_uids);
      if (notify?.length) body.Notify = notify;
      return tdRequest<TdFeedEntry>(`/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/feed`, {
        method: "POST",
        data: body,
      });
    },
    render: (entry, args) => `Comment added to CI #${args.ci_id} at ${formatDate(entry.CreatedDate)}.`,
  }),

  defineTool({
    name: "teamdynamix_get_ci_relationships",
    title: "Get TeamDynamix CI Relationships",
    description:
      "Gets a CI's relationships, e.g. 'this server hosts these databases'.\nUse the returned rel ID to remove a relationship.",
    input: RelationshipsInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/relationships`;
      const relationships = await tdRequest<Array<Record<string, unknown>>>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(relationships ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No relationships found for this CI.",
    render: (page, args) => {
      const lines = [`# Relationships for CI #${args.ci_id} (${page.count} of ${page.total})`, ""];
      for (const relationship of page.items) {
        lines.push(
          `- **${relationship.TypeName ?? relationship.TypeID ?? "Relationship"}** → ` +
            `${relationship.RelatedConfigurationItemName ?? relationship.RelatedConfigurationItemID} ` +
            `(#${relationship.RelatedConfigurationItemID}) [rel ID: ${relationship.ID}]`
        );
      }
      if (page.has_more) lines.push("", `_More relationships available. Use offset=${page.next_offset}._`);
      return truncate(lines.join("\n"));
    },
  }),

  defineTool({
    name: "teamdynamix_add_ci_relationship",
    title: "Add TeamDynamix CI Relationship",
    description:
      "Relates two configuration items, e.g. linking a server to the databases it hosts.\n" +
      "Get relationship_type_id from teamdynamix_list_ci_relationship_types first.",
    input: AddRelationshipInput,
    annotations: { ...CREATE, idempotentHint: true },
    invalidates: CMDB,
    handler: (args) =>
      tdRequest<Record<string, unknown>>(`/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/relationships`, {
        method: "PUT",
        data: { RelatedConfigurationItemID: args.related_ci_id, TypeID: args.relationship_type_id },
      }),
    render: (_result, args) =>
      `Relationship added: CI #${args.ci_id} → CI #${args.related_ci_id} (type ID ${args.relationship_type_id}).`,
  }),

  defineTool({
    name: "teamdynamix_remove_ci_relationship",
    title: "Remove TeamDynamix CI Relationship",
    description:
      "Removes a relationship from a CI.\nCall teamdynamix_get_ci_relationships first to find the relationship_id.",
    input: RemoveRelationshipInput,
    annotations: { ...MUTATE, idempotentHint: true },
    invalidates: CMDB,
    handler: async (args) => {
      await tdRequest<unknown>(
        `/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/relationships/${args.relationship_id}`,
        { method: "DELETE" }
      );
      return { removed: true, ci_id: args.ci_id, relationship_id: args.relationship_id };
    },
    render: (_result, args) => `Relationship #${args.relationship_id} removed from CI #${args.ci_id}.`,
  }),

  defineTool({
    name: "teamdynamix_link_ci_to_ticket",
    title: "Link TeamDynamix CI to Ticket",
    description: "Associates a configuration item with a ticket, recording that the CI is involved in that ticket.",
    input: LinkTicketInput,
    annotations: { ...CREATE, idempotentHint: true },
    invalidates: CMDB,
    handler: async (args) => {
      await tdRequest<unknown>(`/${resolveAppId(args.app_id)}/cmdb/${args.ci_id}/tickets/${args.ticket_id}`, {
        method: "POST",
      });
      return { linked: true, ci_id: args.ci_id, ticket_id: args.ticket_id };
    },
    render: (_result, args) => `CI #${args.ci_id} linked to ticket #${args.ticket_id}.`,
  }),
];

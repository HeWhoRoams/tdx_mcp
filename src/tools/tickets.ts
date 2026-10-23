import { z } from "zod";
import { getConfig } from "../config.js";
import { CREATE, EDIT, READ } from "../framework/annotations.js";
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
import { formatDate, nameWithId, renderFeed, ticketUrl, truncate } from "../services/format.js";
import { combineHints, referenceHint } from "../services/hints.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";
import { paginate, type TdFeedEntry, type TdTicket } from "../types.js";

const TicketIdSchema = z.number().int().positive().describe("The ticket ID.");

const SORT_FIELDS = {
  created: "CreatedDate",
  modified: "ModifiedDate",
  priority: "PriorityID",
  status: "StatusID",
  id: "ID",
};

const SearchInput = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against ticket title/description."),
    ticket_id: z.number().int().positive().optional().describe("Exact ticket ID to look up."),
    status_ids: z.array(z.number().int()).optional().describe("Filter to these TicketStatus IDs (see teamdynamix_list_ticket_statuses)."),
    priority_ids: z.array(z.number().int()).optional().describe("Filter to these TicketPriority IDs (see teamdynamix_list_ticket_priorities)."),
    type_ids: z.array(z.number().int()).optional().describe("Filter to these TicketType IDs (see teamdynamix_list_ticket_types)."),
    account_ids: z.array(z.number().int()).optional().describe("Filter to these Account/Department IDs."),
    responsible_uids: z.array(z.string()).optional().describe("Filter to tickets assigned to these people. Accepts UIDs or email addresses."),
    responsible_group_ids: z.array(z.number().int()).optional().describe("Filter to tickets assigned to these group IDs."),
    requestor_uids: z.array(z.string()).optional().describe("Filter to tickets requested by these people. Accepts UIDs or email addresses."),
    created_date_from: z.string().optional().describe("ISO 8601 date/time; only tickets created on/after this."),
    created_date_to: z.string().optional().describe("ISO 8601 date/time; only tickets created on/before this."),
    modified_date_from: z.string().optional().describe("ISO 8601 date/time; only tickets modified on/after this."),
    modified_date_to: z.string().optional().describe("ISO 8601 date/time; only tickets modified on/before this."),
    is_open: z.boolean().optional().describe("True for tickets not in a Closed/Cancelled status class; false for only closed/cancelled."),
    sort_by: sortBySchema(["created", "modified", "priority", "status", "id"]),
    verbosity: VerbositySchema,
    ...PagingShape,
  })
  .strict();

const GetInput = z.object({ app_id: AppIdSchema, ticket_id: TicketIdSchema, response_format: ResponseFormatSchema }).strict();

const CreateInput = z
  .object({
    app_id: AppIdSchema,
    title: z.string().min(1).max(500).describe("The ticket title/subject."),
    description: z.string().max(50000).optional().describe("The ticket's initial description/body."),
    type_id: z.number().int().positive().describe("The TicketType ID (see teamdynamix_list_ticket_types)."),
    form_id: z.number().int().positive().optional().describe("The TicketForm ID (see teamdynamix_list_ticket_forms). Determines which custom attributes apply, e.g. Change Request's Business Purpose/Testing Plan/Backout Plan fields."),
    status_id: z.number().int().positive().optional().describe("Initial TicketStatus ID; defaults to the type's default status."),
    priority_id: z.number().int().positive().optional().describe("The TicketPriority ID (see teamdynamix_list_ticket_priorities)."),
    impact_id: z.number().int().positive().optional().describe("The TicketImpact ID (see teamdynamix_list_ticket_impacts)."),
    urgency_id: z.number().int().positive().optional().describe("The TicketUrgency ID (see teamdynamix_list_ticket_urgencies)."),
    account_id: z.number().int().positive().optional().describe("The requesting Account/Department ID."),
    source_id: z.number().int().positive().optional().describe("The TicketSource ID (see teamdynamix_list_ticket_sources)."),
    service_id: z.number().int().positive().optional().describe("The Service Catalog service ID this ticket is for."),
    service_offering_id: z.number().int().positive().optional().describe("The Service Offering ID under service_id, if applicable."),
    start_date: z.string().optional().describe("ISO 8601 planned start date/time for the ticket, e.g. a Change's scheduled cutover."),
    end_date: z.string().optional().describe("ISO 8601 planned end date/time for the ticket."),
    location_id: z.number().int().positive().optional().describe("Location ID (see teamdynamix_list_locations)."),
    location_room_id: z.number().int().positive().optional().describe("Room ID within location_id."),
    requestor_email: z.string().email().optional().describe("Email of the requestor. Provide this or requestor_uid."),
    requestor_uid: PersonRefSchema("The requestor").optional(),
    responsible_uid: PersonRefSchema("The person to assign as responsible").optional(),
    responsible_group_id: z.number().int().positive().optional().describe("Group ID to assign as responsible."),
    reviewer_uid: PersonRefSchema("The person to assign as reviewer").optional(),
    reviewing_group_id: z.number().int().positive().optional().describe("Group ID to assign as reviewer, e.g. IT Helpdesk for Incident tickets or a CAB group for Change tickets."),
    notify_requestor: z.boolean().default(false).describe("Email the requestor about ticket creation."),
    notify_responsible: z.boolean().default(false).describe("Email the newly-responsible resource(s)."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateInput = z
  .object({
    app_id: AppIdSchema,
    ticket_id: TicketIdSchema,
    title: z.string().min(1).max(500).optional().describe("New title."),
    description: z.string().max(50000).optional().describe("New description."),
    status_id: z.number().int().positive().optional().describe("New TicketStatus ID."),
    priority_id: z.number().int().positive().optional().describe("New TicketPriority ID."),
    impact_id: z.number().int().positive().optional().describe("New TicketImpact ID (see teamdynamix_list_ticket_impacts)."),
    urgency_id: z.number().int().positive().optional().describe("New TicketUrgency ID (see teamdynamix_list_ticket_urgencies)."),
    account_id: z.number().int().positive().optional().describe("New requesting Account/Department ID."),
    source_id: z.number().int().positive().optional().describe("New TicketSource ID (see teamdynamix_list_ticket_sources)."),
    service_id: z.number().int().positive().optional().describe("New Service Catalog service ID."),
    service_offering_id: z.number().int().positive().optional().describe("New Service Offering ID under service_id, if applicable."),
    start_date: z.string().optional().describe("New ISO 8601 planned start date/time for the ticket."),
    end_date: z.string().optional().describe("New ISO 8601 planned end date/time for the ticket."),
    location_id: z.number().int().positive().optional().describe("New Location ID (see teamdynamix_list_locations)."),
    location_room_id: z.number().int().positive().optional().describe("New Room ID within location_id."),
    requestor_uid: PersonRefSchema("The new requestor").optional(),
    responsible_uid: PersonRefSchema("The new responsible person").optional(),
    responsible_group_id: z.number().int().positive().optional().describe("New responsible group ID."),
    reviewer_uid: PersonRefSchema("The new reviewer").optional(),
    reviewing_group_id: z.number().int().positive().optional().describe("New reviewing group ID."),
    notify_responsible: z.boolean().default(false).describe("Notify the newly-responsible resource(s)."),
    custom_attributes: AttributesSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const FeedInput = z.object({ app_id: AppIdSchema, ticket_id: TicketIdSchema, ...ChildPagingShape }).strict();

const CommentInput = z
  .object({
    app_id: AppIdSchema,
    ticket_id: TicketIdSchema,
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    is_private: z.boolean().default(false).describe("If true, visible only to technicians, not the requestor."),
    notify_uids: z.array(z.string()).optional().describe("People to notify. Accepts UIDs or email addresses."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const TasksInput = z.object({ app_id: AppIdSchema, ticket_id: TicketIdSchema, ...ChildPagingShape }).strict();

const CreateTaskInput = z
  .object({
    app_id: AppIdSchema,
    ticket_id: TicketIdSchema,
    title: z.string().min(1).max(500).describe("The task title."),
    description: z.string().max(50000).optional().describe("The task description."),
    start_date: z.string().optional().describe("ISO 8601 planned start date/time."),
    end_date: z.string().optional().describe("ISO 8601 planned end date/time."),
    responsible_uid: PersonRefSchema("The person responsible for the task").optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateTaskInput = z
  .object({
    app_id: AppIdSchema,
    ticket_id: TicketIdSchema,
    task_id: z.number().int().positive().describe("The ticket task ID to update."),
    title: z.string().min(1).max(500).optional().describe("New task title."),
    description: z.string().max(50000).optional().describe("New task description."),
    start_date: z.string().optional().describe("ISO 8601 planned start date/time."),
    end_date: z.string().optional().describe("ISO 8601 planned end date/time."),
    percent_complete: z.number().int().min(0).max(100).optional().describe("Completion percentage; 100 marks it complete."),
    responsible_uid: PersonRefSchema("The person responsible for the task").optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

export function renderTicket(ticket: TdTicket, appId: number): string {
  const lines = [
    `## ${ticket.Title} (#${ticket.ID})`,
    `- **Status**: ${nameWithId(ticket.StatusName, ticket.StatusID)}`,
    `- **Type**: ${nameWithId(ticket.Type as string | undefined, ticket.TypeID)}`,
    `- **Priority**: ${nameWithId(ticket.PriorityName, ticket.PriorityID)}`,
  ];
  if (ticket.ImpactID || ticket.ImpactName) lines.push(`- **Impact**: ${nameWithId(ticket.ImpactName, ticket.ImpactID)}`);
  if (ticket.UrgencyID || ticket.UrgencyName) lines.push(`- **Urgency**: ${nameWithId(ticket.UrgencyName, ticket.UrgencyID)}`);
  if (ticket.ServiceID || ticket.ServiceName) lines.push(`- **Service**: ${nameWithId(ticket.ServiceName, ticket.ServiceID)}`);
  lines.push(
    `- **Account/Dept**: ${nameWithId(ticket.AccountName, ticket.AccountID)}`,
    `- **Requestor**: ${ticket.RequestorName ?? "N/A"}${ticket.RequestorEmail ? ` <${ticket.RequestorEmail}>` : ""}`,
    `- **Responsible**: ${ticket.ResponsibleFullName ?? ticket.ResponsibleGroupName ?? "Unassigned"}`
  );
  if (ticket.ReviewerFullName || ticket.ReviewingGroupName) {
    lines.push(`- **Reviewer**: ${ticket.ReviewerFullName ?? ticket.ReviewingGroupName ?? "N/A"}`);
  }
  lines.push(
    `- **Created**: ${formatDate(ticket.CreatedDate)}`,
    `- **Modified**: ${formatDate(ticket.ModifiedDate)}`,
    `- **Link**: ${ticketUrl(appId, ticket.ID)}`
  );
  if (ticket.Description) {
    const description = String(ticket.Description);
    lines.push(`- **Description**: ${description.length > 500 ? `${description.slice(0, 500)}...` : description}`);
  }
  return lines.join("\n");
}

function renderTicketCompact(ticket: TdTicket, appId: number): string {
  const assignee = ticket.ResponsibleFullName ?? ticket.ResponsibleGroupName ?? "Unassigned";
  return (
    `- **#${ticket.ID}** ${ticket.Title} — ${ticket.StatusName ?? "?"}, ${ticket.PriorityName ?? "?"}, ` +
    `${assignee} — ${ticketUrl(appId, ticket.ID)}`
  );
}

const TICKETS = { domain: "tickets", appIdFrom: (args: { app_id?: number }) => resolveAppId(args.app_id) };

/** Cached reference data turns a rejected create/update into a self-correcting error. */
function ticketWriteHints(args: { app_id?: number }): string | undefined {
  const appId = resolveAppId(args.app_id);
  return combineHints(
    referenceHint(appId, "tickets/statuses", "status_id values"),
    referenceHint(appId, "tickets/types", "type_id values"),
    referenceHint(appId, "tickets/priorities", "priority_id values"),
    referenceHint(appId, "tickets/impacts", "impact_id values"),
    referenceHint(appId, "tickets/urgencies", "urgency_id values")
  );
}

export const ticketTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_search_tickets",
    title: "Search TeamDynamix Tickets",
    description:
      "Searches tickets by text, status, priority, type, account, assignee, requestor, or date range.\n" +
      "Use when: 'show me open high-priority tickets assigned to Jane'. Returns partial records — use teamdynamix_get_ticket for full detail.\n" +
      "Page with limit/offset or the returned next_cursor.",
    input: SearchInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.ticket_id) body.TicketID = args.ticket_id;
      if (args.status_ids) body.StatusIDs = args.status_ids;
      if (args.priority_ids) body.PriorityIDs = args.priority_ids;
      if (args.type_ids) body.TypeIDs = args.type_ids;
      if (args.account_ids) body.AccountIDs = args.account_ids;
      const [responsible, requestors] = await Promise.all([
        resolvePersonUids(args.responsible_uids),
        resolvePersonUids(args.requestor_uids),
      ]);
      if (responsible) body.ResponsibilityUids = responsible;
      if (args.responsible_group_ids) body.ResponsibilityGroupIDs = args.responsible_group_ids;
      if (requestors) body.RequestorUids = requestors;
      if (args.created_date_from) body.CreatedDateFrom = args.created_date_from;
      if (args.created_date_to) body.CreatedDateTo = args.created_date_to;
      if (args.modified_date_from) body.ModifiedDateFrom = args.modified_date_from;
      if (args.modified_date_to) body.ModifiedDateTo = args.modified_date_to;
      if (args.is_open !== undefined) body.IsOpen = args.is_open;
      return searchPage<TdTicket>(`/${resolveAppId(args.app_id)}/tickets/search`, body, args, {
        sortFields: SORT_FIELDS,
      });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No tickets found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "ticket");
      const appId = resolveAppId(args.app_id);
      const lines = resultsHeading("Ticket Search Results", page, "ticket");
      if (args.verbosity === "compact") {
        for (const ticket of page.items) lines.push(renderTicketCompact(ticket, appId));
        lines.push("");
      } else {
        for (const ticket of page.items) lines.push(renderTicket(ticket, appId), "");
      }
      lines.push(...pagingFooter(page));
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_get_ticket",
    title: "Get TeamDynamix Ticket",
    description:
      "Gets one ticket in full, including description and custom attributes that search results omit.\n" +
      "Use when you already know the ticket ID.",
    input: GetInput,
    annotations: READ,
    handler: (args) => {
      const path = `/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}`;
      return tdRequest<TdTicket>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
    },
    render: (ticket, args) => renderTicket(ticket, resolveAppId(args.app_id)),
  }),

  defineTool({
    name: "teamdynamix_create_ticket",
    title: "Create TeamDynamix Ticket",
    description:
      "Creates a ticket. Requires title and type_id.\n" +
      "Look up type_id/status_id/priority_id/impact_id/urgency_id/form_id/source_id with the teamdynamix_list_ticket_* tools first, " +
      "and location_id with teamdynamix_list_locations.\n" +
      "Requestor, assignee, and reviewer accept email addresses as well as UIDs.",
    input: CreateInput,
    annotations: CREATE,
    invalidates: TICKETS,
    errorHints: ticketWriteHints,
    handler: async (args) => {
      const body: Record<string, unknown> = { Title: args.title, TypeID: args.type_id };
      if (args.description) body.Description = args.description;
      if (args.form_id) body.FormID = args.form_id;
      if (args.status_id) body.StatusID = args.status_id;
      if (args.priority_id) body.PriorityID = args.priority_id;
      if (args.impact_id) body.ImpactID = args.impact_id;
      if (args.urgency_id) body.UrgencyID = args.urgency_id;
      if (args.account_id) body.AccountID = args.account_id;
      if (args.source_id) body.SourceID = args.source_id;
      if (args.service_id) body.ServiceID = args.service_id;
      if (args.service_offering_id) body.ServiceOfferingID = args.service_offering_id;
      if (args.start_date) body.StartDate = args.start_date;
      if (args.end_date) body.EndDate = args.end_date;
      if (args.location_id) body.LocationID = args.location_id;
      if (args.location_room_id) body.LocationRoomID = args.location_room_id;
      if (args.requestor_email) body.RequestorEmail = args.requestor_email;
      if (args.requestor_uid) body.RequestorUid = await resolvePersonUid(args.requestor_uid);
      if (args.responsible_uid) body.ResponsibleUid = await resolvePersonUid(args.responsible_uid);
      if (args.responsible_group_id) body.ResponsibleGroupID = args.responsible_group_id;
      if (args.reviewer_uid) body.ReviewerUid = await resolvePersonUid(args.reviewer_uid);
      if (args.reviewing_group_id) body.ReviewingGroupID = args.reviewing_group_id;
      if (args.custom_attributes) body.Attributes = args.custom_attributes;
      return tdRequest<TdTicket>(`/${resolveAppId(args.app_id)}/tickets`, {
        method: "POST",
        data: body,
        params: { NotifyRequestor: args.notify_requestor, NotifyResponsible: args.notify_responsible },
      });
    },
    render: (ticket, args) => `# Ticket Created\n\n${renderTicket(ticket, resolveAppId(args.app_id))}`,
  }),

  defineTool({
    name: "teamdynamix_edit_ticket",
    title: "Edit TeamDynamix Ticket",
    description:
      "Edits a ticket's core fields, changing only the ones you supply. To log progress or comment, use teamdynamix_add_ticket_comment.\n" +
      "At least one editable field is required; responsible_uid accepts an email address.",
    input: UpdateInput,
    annotations: EDIT,
    invalidates: TICKETS,
    errorHints: ticketWriteHints,
    handler: async (args) => {
      const operations: Array<{ op: "replace"; path: string; value: unknown }> = [];
      const add = (path: string, value: unknown) => {
        if (value !== undefined) operations.push({ op: "replace", path, value });
      };
      add("/Title", args.title);
      add("/Description", args.description);
      add("/StatusID", args.status_id);
      add("/PriorityID", args.priority_id);
      add("/ImpactID", args.impact_id);
      add("/UrgencyID", args.urgency_id);
      add("/AccountID", args.account_id);
      add("/SourceID", args.source_id);
      add("/ServiceID", args.service_id);
      add("/ServiceOfferingID", args.service_offering_id);
      add("/StartDate", args.start_date);
      add("/EndDate", args.end_date);
      add("/LocationID", args.location_id);
      add("/LocationRoomID", args.location_room_id);
      add("/RequestorUid", args.requestor_uid ? await resolvePersonUid(args.requestor_uid) : undefined);
      add("/ResponsibleUid", args.responsible_uid ? await resolvePersonUid(args.responsible_uid) : undefined);
      add("/ResponsibleGroupID", args.responsible_group_id);
      add("/ReviewerUid", args.reviewer_uid ? await resolvePersonUid(args.reviewer_uid) : undefined);
      add("/ReviewingGroupID", args.reviewing_group_id);
      add("/Attributes", args.custom_attributes);
      if (operations.length === 0) {
        throw new ToolInputError(
          "At least one field to update must be provided (title, description, status_id, priority_id, impact_id, urgency_id, " +
            "account_id, source_id, service_id, service_offering_id, start_date, end_date, location_id, location_room_id, " +
            "requestor_uid, responsible_uid, responsible_group_id, reviewer_uid, reviewing_group_id, or custom_attributes)."
        );
      }
      return tdRequest<TdTicket>(`/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}`, {
        method: "PATCH",
        data: operations,
        params: { notifyNewResponsible: args.notify_responsible },
      });
    },
    render: (ticket, args) => `# Ticket Edited\n\n${renderTicket(ticket, resolveAppId(args.app_id))}`,
  }),

  defineTool({
    name: "teamdynamix_get_ticket_feed",
    title: "Get TeamDynamix Ticket Feed",
    description: "Gets a ticket's feed entries (comments, updates, history), newest first.\nPage with limit/offset.",
    input: FeedInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}/feed`;
      const feed = await tdRequest<TdFeedEntry[]>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(feed ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No feed entries found for this ticket.",
    render: (page, args) => {
      const body = renderFeed(`Feed for Ticket #${args.ticket_id} (${page.count} of ${page.total})`, page.items);
      return page.has_more ? `${body}\n_More entries available. Use offset=${page.next_offset}._` : body;
    },
  }),

  defineTool({
    name: "teamdynamix_add_ticket_comment",
    title: "Add TeamDynamix Ticket Comment",
    description: "Adds a comment (feed entry) to a ticket, optionally private and optionally notifying people.",
    input: CommentInput,
    annotations: CREATE,
    invalidates: TICKETS,
    handler: async (args) => {
      const body: Record<string, unknown> = { Comments: args.comment, IsPrivate: args.is_private };
      const notify = await resolvePersonUids(args.notify_uids);
      if (notify?.length) body.Notify = notify;
      return tdRequest<TdFeedEntry>(`/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}/feed`, {
        method: "POST",
        data: body,
      });
    },
    render: (entry, args) => `Comment added to ticket #${args.ticket_id} at ${formatDate(entry.CreatedDate)}.`,
  }),

  defineTool({
    name: "teamdynamix_get_ticket_tasks",
    title: "Get TeamDynamix Ticket Tasks",
    description: "Lists the tasks currently on a ticket with their completion percentages.",
    input: TasksInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}/tasks`;
      const tasks = await tdRequest<Array<Record<string, unknown>>>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(tasks ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No tasks found for this ticket.",
    render: (data, args) => {
      const lines = [`# Tasks for Ticket #${args.ticket_id} (${data.count} of ${data.total})`, ""];
      for (const task of data.items) {
        lines.push(`- **${task.Title ?? "(untitled)"}** (#${task.ID}) — ${task.PercentComplete ?? 0}% complete`);
      }
      if (data.has_more) lines.push("", `_More tasks available. Use offset=${data.next_offset}._`);
      return truncate(lines.join("\n"));
    },
  }),

  defineTool({
    name: "teamdynamix_create_ticket_task",
    title: "Create TeamDynamix Ticket Task",
    description: "Creates a task on a ticket with an optional schedule and assignee.",
    input: CreateTaskInput,
    annotations: CREATE,
    invalidates: TICKETS,
    handler: async (args) => {
      const body: Record<string, unknown> = { Title: args.title };
      if (args.description) body.Description = args.description;
      if (args.start_date) body.StartDate = args.start_date;
      if (args.end_date) body.EndDate = args.end_date;
      if (args.responsible_uid) body.ResponsibleUid = await resolvePersonUid(args.responsible_uid);
      return tdRequest<Record<string, unknown>>(`/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}/tasks`, {
        method: "POST",
        data: body,
      });
    },
    render: (task, args) => `Task "${args.title}" created on ticket #${args.ticket_id} (task #${task.ID}).`,
  }),

  defineTool({
    name: "teamdynamix_edit_ticket_task",
    title: "Edit TeamDynamix Ticket Task",
    description:
      "Edits a ticket task's title, dates, assignee, or percent_complete.\n" +
      "Uses read-modify-write because TeamDynamix has no PATCH here, so concurrent edits can overwrite each other.",
    input: UpdateTaskInput,
    annotations: EDIT,
    readModifyWrite: true,
    invalidates: TICKETS,
    handler: async (args) => {
      const changes: Record<string, unknown> = {};
      if (args.title !== undefined) changes.Title = args.title;
      if (args.description !== undefined) changes.Description = args.description;
      if (args.start_date !== undefined) changes.StartDate = args.start_date;
      if (args.end_date !== undefined) changes.EndDate = args.end_date;
      if (args.percent_complete !== undefined) changes.PercentComplete = args.percent_complete;
      if (args.responsible_uid !== undefined) changes.ResponsibleUid = await resolvePersonUid(args.responsible_uid);
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError("At least one field to update must be provided.");
      }
      const path = `/${resolveAppId(args.app_id)}/tickets/${args.ticket_id}/tasks/${args.task_id}`;
      const existing = await tdRequest<Record<string, unknown>>(path);
      return tdRequest<Record<string, unknown>>(path, { method: "PUT", data: { ...existing, ...changes } });
    },
    render: (_task, args) =>
      `Task #${args.task_id} edited on ticket #${args.ticket_id}.` +
      (args.percent_complete !== undefined ? ` (${args.percent_complete}% complete)` : ""),
  }),
];

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown, formatDate, nameWithId } from "../services/format.js";
import { AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdFeedEntry, TdTicket, paginate } from "../types.js";

const TicketSearchInputSchema = z
  .object({
    app_id: AppIdSchema,
    search_text: z.string().max(200).optional().describe("Free-text search against ticket title/description."),
    ticket_id: z.number().int().positive().optional().describe("Exact ticket ID to look up."),
    status_ids: z.array(z.number().int()).optional().describe("Filter to these TicketStatus IDs (see teamdynamix_list_ticket_statuses)."),
    priority_ids: z.array(z.number().int()).optional().describe("Filter to these TicketPriority IDs (see teamdynamix_list_ticket_priorities)."),
    type_ids: z.array(z.number().int()).optional().describe("Filter to these TicketType IDs (see teamdynamix_list_ticket_types)."),
    account_ids: z.array(z.number().int()).optional().describe("Filter to these Account/Department IDs (the requesting customer's account)."),
    responsible_uids: z.array(z.string()).optional().describe("Filter to tickets responsible-assigned to these person UIDs."),
    responsible_group_ids: z.array(z.number().int()).optional().describe("Filter to tickets responsible-assigned to these group IDs."),
    requestor_uids: z.array(z.string()).optional().describe("Filter to tickets requested by these person UIDs."),
    created_date_from: z.string().optional().describe("ISO 8601 date/time; only include tickets created on/after this."),
    created_date_to: z.string().optional().describe("ISO 8601 date/time; only include tickets created on/before this."),
    modified_date_from: z.string().optional().describe("ISO 8601 date/time; only include tickets modified on/after this."),
    modified_date_to: z.string().optional().describe("ISO 8601 date/time; only include tickets modified on/before this."),
    is_open: z.boolean().optional().describe("If true, only tickets whose status is not a Closed/Cancelled class. If false, only closed/cancelled tickets."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();
type TicketSearchInput = z.infer<typeof TicketSearchInputSchema>;

const GetTicketInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket to retrieve."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateTicketInputSchema = z
  .object({
    app_id: AppIdSchema,
    title: z.string().min(1).max(500).describe("The ticket title/subject."),
    description: z.string().max(50000).optional().describe("The ticket's initial description/body."),
    type_id: z.number().int().positive().describe("The TicketType ID (see teamdynamix_list_ticket_types)."),
    status_id: z.number().int().positive().optional().describe("The initial TicketStatus ID (see teamdynamix_list_ticket_statuses). Defaults to the type's default status if omitted."),
    priority_id: z.number().int().positive().optional().describe("The TicketPriority ID (see teamdynamix_list_ticket_priorities)."),
    account_id: z.number().int().positive().optional().describe("The requesting Account/Department ID."),
    source_id: z.number().int().positive().optional().describe("The TicketSource ID (see teamdynamix_list_ticket_sources)."),
    requestor_email: z.string().email().optional().describe("Email of the requestor. Provide this or requestor_uid."),
    requestor_uid: z.string().optional().describe("Person UID of the requestor. Provide this or requestor_email."),
    responsible_uid: z.string().optional().describe("Person UID to assign as responsible for the ticket."),
    responsible_group_id: z.number().int().positive().optional().describe("Group ID to assign as responsible for the ticket."),
    notify_requestor: z.boolean().default(false).describe("Whether to email the requestor about ticket creation."),
    notify_responsible: z.boolean().default(false).describe("Whether to email the newly-responsible resource(s)."),
    custom_attributes: z
      .array(z.object({ ID: z.number().int(), Value: z.string() }))
      .optional()
      .describe("Custom attribute values to set. Each entry needs the attribute ID and the value (or choice ID as string). Use teamdynamix_list_custom_attributes (component_id=9) to discover IDs."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateTicketInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket to update."),
    title: z.string().min(1).max(500).optional().describe("New title."),
    description: z.string().max(50000).optional().describe("New description."),
    status_id: z.number().int().positive().optional().describe("New TicketStatus ID."),
    priority_id: z.number().int().positive().optional().describe("New TicketPriority ID."),
    responsible_uid: z.string().optional().describe("New responsible person UID."),
    responsible_group_id: z.number().int().positive().optional().describe("New responsible group ID."),
    notify_responsible: z.boolean().default(false).describe("Whether to notify the newly-responsible resource(s) if responsibility changes."),
    custom_attributes: z
      .array(z.object({ ID: z.number().int(), Value: z.string() }))
      .optional()
      .describe("Custom attribute values to update. Use teamdynamix_list_custom_attributes (component_id=9) to discover IDs."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetTicketFeedInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const AddTicketCommentInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket to comment on."),
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    is_private: z.boolean().default(false).describe("If true, the comment is only visible to technicians, not the requestor."),
    notify_uids: z.array(z.string()).optional().describe("Person UIDs to notify about this comment."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetTicketTasksInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateTicketTaskInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket to add a task to."),
    title: z.string().min(1).max(500).describe("The task title."),
    description: z.string().max(50000).optional().describe("The task description."),
    start_date: z.string().optional().describe("ISO 8601 planned start date/time."),
    end_date: z.string().optional().describe("ISO 8601 planned end date/time."),
    responsible_uid: z.string().optional().describe("Person UID responsible for the task."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateTicketTaskInputSchema = z
  .object({
    app_id: AppIdSchema,
    ticket_id: z.number().int().positive().describe("The ID of the ticket the task belongs to."),
    task_id: z.number().int().positive().describe("The ID of the ticket task to update."),
    title: z.string().min(1).max(500).optional().describe("New task title."),
    description: z.string().max(50000).optional().describe("New task description."),
    start_date: z.string().optional().describe("ISO 8601 planned start date/time."),
    end_date: z.string().optional().describe("ISO 8601 planned end date/time."),
    percent_complete: z.number().int().min(0).max(100).optional().describe("Task completion percentage (0-100)."),
    responsible_uid: z.string().optional().describe("Person UID responsible for the task."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function formatTicketMarkdown(t: TdTicket): string {
  const lines = [
    `## ${t.Title} (#${t.ID})`,
    `- **Status**: ${nameWithId(t.StatusName, t.StatusID)}`,
    `- **Type**: ${nameWithId(t.Type as string | undefined, t.TypeID)}`,
    `- **Priority**: ${nameWithId(t.PriorityName, t.PriorityID)}`,
    `- **Account/Dept**: ${nameWithId(t.AccountName, t.AccountID)}`,
    `- **Requestor**: ${t.RequestorName ?? "N/A"}${t.RequestorEmail ? ` <${t.RequestorEmail}>` : ""}`,
    `- **Responsible**: ${t.ResponsibleFullName ?? t.ResponsibleGroupName ?? "Unassigned"}`,
    `- **Created**: ${formatDate(t.CreatedDate)}`,
    `- **Modified**: ${formatDate(t.ModifiedDate)}`,
  ];
  if (t.Description) {
    const desc = String(t.Description);
    lines.push(`- **Description**: ${desc.length > 500 ? desc.slice(0, 500) + "..." : desc}`);
  }
  return lines.join("\n");
}

export function registerTicketTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_search_tickets",
    {
      title: "Search TeamDynamix Tickets",
      description: `Search for tickets in a TeamDynamix ticketing application using filters like status, priority, type, requestor, assignee, and date ranges.

This is a search (not a full load): descriptions, tasks, and custom attributes are NOT returned for each result. To get complete details on a specific ticket, use teamdynamix_get_ticket.

Args:
  - app_id (number): The ticketing application ID (use teamdynamix_list_applications to find it)
  - search_text (string, optional): Free-text search
  - status_ids / priority_ids / type_ids (number[], optional): Filter by reference data IDs
  - account_ids (number[], optional): Filter by requesting account/department
  - responsible_uids / responsible_group_ids (optional): Filter by assignee
  - requestor_uids (string[], optional): Filter by requestor
  - created_date_from/to, modified_date_from/to (string, optional): ISO 8601 date filters
  - is_open (boolean, optional): true = only open tickets, false = only closed/cancelled
  - limit (number, default 25), offset (number, default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching tickets with has_more/next_offset for continued paging.

Examples:
  - Use when: "Show me open high-priority tickets assigned to Jane" -> priority_ids + responsible_uids + is_open=true
  - Don't use when: You already know the ticket ID (use teamdynamix_get_ticket instead)

Error Handling:
  - Returns "Error: Resource not found" if app_id is invalid
  - Returns "No tickets found matching the given criteria" if search is empty`,
      inputSchema: TicketSearchInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: TicketSearchInput) => {
      try {
        const fetchCount = Math.min(params.offset + params.limit, 1000);
        const body: Record<string, unknown> = { MaxResults: fetchCount };
        if (params.search_text) body.SearchText = params.search_text;
        if (params.ticket_id) body.TicketID = params.ticket_id;
        if (params.status_ids) body.StatusIDs = params.status_ids;
        if (params.priority_ids) body.PriorityIDs = params.priority_ids;
        if (params.type_ids) body.TypeIDs = params.type_ids;
        if (params.account_ids) body.AccountIDs = params.account_ids;
        if (params.responsible_uids) body.ResponsibilityUids = params.responsible_uids;
        if (params.responsible_group_ids) body.ResponsibilityGroupIDs = params.responsible_group_ids;
        if (params.requestor_uids) body.RequestorUids = params.requestor_uids;
        if (params.created_date_from) body.CreatedDateFrom = params.created_date_from;
        if (params.created_date_to) body.CreatedDateTo = params.created_date_to;
        if (params.modified_date_from) body.ModifiedDateFrom = params.modified_date_from;
        if (params.modified_date_to) body.ModifiedDateTo = params.modified_date_to;
        if (params.is_open !== undefined) body.IsOpen = params.is_open;

        const results = await tdRequest<TdTicket[]>(`/${params.app_id}/tickets/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);

        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No tickets found matching the given criteria." }] };
        }

        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Ticket Search Results`, "", `Found ${page.total} ticket(s), showing ${page.items.length}`, ""];
          for (const t of page.items) lines.push(formatTicketMarkdown(t), "");
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
    "teamdynamix_get_ticket",
    {
      title: "Get TeamDynamix Ticket",
      description: `Gets full details on a single ticket, including description, custom attributes, and other fields omitted from search results.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full ticket details.

Error Handling:
  - Returns "Error: Resource not found" if the ticket_id or app_id is invalid`,
      inputSchema: GetTicketInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ticket_id, response_format }) => {
      try {
        const ticket = await tdRequest<TdTicket>(`/${app_id}/tickets/${ticket_id}`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(formatTicketMarkdown(ticket))
            : toJsonText(ticket);
        return { content: [{ type: "text" as const, text }], structuredContent: ticket as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_ticket",
    {
      title: "Create TeamDynamix Ticket",
      description: `Creates a new ticket in a TeamDynamix ticketing application.

Args:
  - app_id (number): The ticketing application ID
  - title (string): Ticket title/subject
  - type_id (number): TicketType ID (see teamdynamix_list_ticket_types)
  - description, status_id, priority_id, account_id, source_id (optional)
  - requestor_email or requestor_uid (optional; identifies who the ticket is for)
  - responsible_uid or responsible_group_id (optional; who it's assigned to)
  - notify_requestor, notify_responsible (boolean, default false)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The newly created ticket, including its assigned ID.

Error Handling:
  - Returns "Error: ... rejected the request as invalid (400)" if required fields for this app's ticket type are missing
  - Returns "Error: Permission denied" if the account can't create tickets in this app`,
      inputSchema: CreateTicketInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          Title: params.title,
          TypeID: params.type_id,
        };
        if (params.description) body.Description = params.description;
        if (params.status_id) body.StatusID = params.status_id;
        if (params.priority_id) body.PriorityID = params.priority_id;
        if (params.account_id) body.AccountID = params.account_id;
        if (params.source_id) body.SourceID = params.source_id;
        if (params.requestor_email) body.RequestorEmail = params.requestor_email;
        if (params.requestor_uid) body.RequestorUid = params.requestor_uid;
        if (params.responsible_uid) body.ResponsibleUid = params.responsible_uid;
        if (params.responsible_group_id) body.ResponsibleGroupID = params.responsible_group_id;
        if (params.custom_attributes) body.Attributes = params.custom_attributes;

        const created = await tdRequest<TdTicket>(`/${params.app_id}/tickets`, "POST", body, {
          NotifyRequestor: params.notify_requestor,
          NotifyResponsible: params.notify_responsible,
        });
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Ticket Created\n\n${formatTicketMarkdown(created)}`)
            : toJsonText(created);
        return { content: [{ type: "text" as const, text }], structuredContent: created as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_ticket",
    {
      title: "Update TeamDynamix Ticket",
      description: `Patches an existing ticket, changing only the fields provided. Does not touch fields you don't specify.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID to update
  - title, description, status_id, priority_id, responsible_uid, responsible_group_id (all optional; at least one required)
  - notify_responsible (boolean, default false)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated ticket.

Error Handling:
  - Returns "Error: Resource not found" if ticket_id is invalid
  - Returns "Error: Permission denied" if the account lacks edit rights on this ticket`,
      inputSchema: UpdateTicketInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const ops: Array<{ op: "replace"; path: string; value: unknown }> = [];
        if (
          params.title === undefined &&
          params.description === undefined &&
          params.status_id === undefined &&
          params.priority_id === undefined &&
          params.responsible_uid === undefined &&
          params.responsible_group_id === undefined &&
          params.custom_attributes === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided (title, description, status_id, priority_id, responsible_uid, responsible_group_id, or custom_attributes)." }],
          };
        }
        if (params.title !== undefined) ops.push({ op: "replace", path: "/Title", value: params.title });
        if (params.description !== undefined) ops.push({ op: "replace", path: "/Description", value: params.description });
        if (params.status_id !== undefined) ops.push({ op: "replace", path: "/StatusID", value: params.status_id });
        if (params.priority_id !== undefined) ops.push({ op: "replace", path: "/PriorityID", value: params.priority_id });
        if (params.responsible_uid !== undefined) ops.push({ op: "replace", path: "/ResponsibleUid", value: params.responsible_uid });
        if (params.responsible_group_id !== undefined)
          ops.push({ op: "replace", path: "/ResponsibleGroupID", value: params.responsible_group_id });
        if (params.custom_attributes !== undefined)
          ops.push({ op: "replace", path: "/Attributes", value: params.custom_attributes });

        const updated = await tdRequest<TdTicket>(`/${params.app_id}/tickets/${params.ticket_id}`, "PATCH", ops, {
          notifyNewResponsible: params.notify_responsible,
        });
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Ticket Updated\n\n${formatTicketMarkdown(updated)}`)
            : toJsonText(updated);
        return { content: [{ type: "text" as const, text }], structuredContent: updated as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_ticket_feed",
    {
      title: "Get TeamDynamix Ticket Feed",
      description: `Gets the feed entries (comments/updates/history) for a ticket, newest first.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of feed entries. Replies and likes are not included per-entry; only counts are.

Error Handling:
  - Returns "Error: Resource not found" if ticket_id is invalid`,
      inputSchema: GetTicketFeedInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ticket_id, response_format }) => {
      try {
        const feed = await tdRequest<TdFeedEntry[]>(`/${app_id}/tickets/${ticket_id}/feed`);
        if (!feed || feed.length === 0) {
          return { content: [{ type: "text" as const, text: "No feed entries found for this ticket." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Feed for Ticket #${ticket_id}`, ""];
          for (const entry of feed) {
            lines.push(`### ${entry.CreatedByName ?? "Unknown"} — ${formatDate(entry.CreatedDate)}`);
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
    "teamdynamix_add_ticket_comment",
    {
      title: "Add TeamDynamix Ticket Comment",
      description: `Adds a comment (feed entry) to a ticket. This is how you leave notes, updates, or replies on a ticket.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID
  - comment (string): The comment text
  - is_private (boolean, default false): If true, hidden from the requestor
  - notify_uids (string[], optional): Person UIDs to notify
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The created feed entry.

Error Handling:
  - Returns "Error: Resource not found" if ticket_id is invalid`,
      inputSchema: AddTicketCommentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ app_id, ticket_id, comment, is_private, notify_uids, response_format }) => {
      try {
        const body: Record<string, unknown> = {
          Comments: comment,
          IsPrivate: is_private,
        };
        if (notify_uids?.length) body.Notify = notify_uids;
        const entry = await tdRequest<TdFeedEntry>(`/${app_id}/tickets/${ticket_id}/feed`, "POST", body);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Comment added to ticket #${ticket_id} at ${formatDate(entry.CreatedDate)}.`
            : toJsonText(entry);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_ticket_tasks",
    {
      title: "Get TeamDynamix Ticket Tasks",
      description: `Gets the list of tasks currently on a ticket.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of ticket tasks.

Error Handling:
  - Returns "Error: Resource not found" if ticket_id is invalid`,
      inputSchema: GetTicketTasksInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, ticket_id, response_format }) => {
      try {
        const tasks = await tdRequest<Array<Record<string, unknown>>>(`/${app_id}/tickets/${ticket_id}/tasks`);
        if (!tasks || tasks.length === 0) {
          return { content: [{ type: "text" as const, text: "No tasks found for this ticket." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Tasks for Ticket #${ticket_id}`, ""];
          for (const t of tasks) {
            lines.push(`- **${t.Title ?? "(untitled)"}** (#${t.ID}) — ${t.PercentComplete ?? 0}% complete`);
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(tasks);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_ticket_task",
    {
      title: "Create TeamDynamix Ticket Task",
      description: `Creates a new task on a ticket.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID to add the task to
  - title (string): Task title
  - description, start_date, end_date, responsible_uid (optional)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The created ticket task.

Error Handling:
  - Returns "Error: Resource not found" if ticket_id is invalid`,
      inputSchema: CreateTicketTaskInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { Title: params.title };
        if (params.description) body.Description = params.description;
        if (params.start_date) body.StartDate = params.start_date;
        if (params.end_date) body.EndDate = params.end_date;
        if (params.responsible_uid) body.ResponsibleUid = params.responsible_uid;

        const task = await tdRequest<Record<string, unknown>>(`/${params.app_id}/tickets/${params.ticket_id}/tasks`, "POST", body);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? `Task "${params.title}" created on ticket #${params.ticket_id} (task #${task.ID}).`
            : toJsonText(task);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_ticket_task",
    {
      title: "Update TeamDynamix Ticket Task",
      description: `Updates an existing ticket task — change its title, dates, completion percentage, or responsible person.

Args:
  - app_id (number): The ticketing application ID
  - ticket_id (number): The ticket ID
  - task_id (number): The task ID to update
  - title, description, start_date, end_date, responsible_uid (optional)
  - percent_complete (number 0-100, optional): Set to 100 to mark the task complete
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated ticket task.

Error Handling:
  - Returns "Error: Resource not found" if task_id or ticket_id is invalid`,
      inputSchema: UpdateTicketTaskInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (
          params.title === undefined &&
          params.description === undefined &&
          params.start_date === undefined &&
          params.end_date === undefined &&
          params.percent_complete === undefined &&
          params.responsible_uid === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided." }],
          };
        }
        // GET existing task first so we can merge (PUT requires a full object)
        const existing = await tdRequest<Record<string, unknown>>(
          `/${params.app_id}/tickets/${params.ticket_id}/tasks/${params.task_id}`
        );
        const merged: Record<string, unknown> = {
          ...existing,
          ...(params.title !== undefined ? { Title: params.title } : {}),
          ...(params.description !== undefined ? { Description: params.description } : {}),
          ...(params.start_date !== undefined ? { StartDate: params.start_date } : {}),
          ...(params.end_date !== undefined ? { EndDate: params.end_date } : {}),
          ...(params.percent_complete !== undefined ? { PercentComplete: params.percent_complete } : {}),
          ...(params.responsible_uid !== undefined ? { ResponsibleUid: params.responsible_uid } : {}),
        };
        const task = await tdRequest<Record<string, unknown>>(
          `/${params.app_id}/tickets/${params.ticket_id}/tasks/${params.task_id}`,
          "PUT",
          merged
        );
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? `Task #${params.task_id} updated on ticket #${params.ticket_id}.${params.percent_complete !== undefined ? ` (${params.percent_complete}% complete)` : ""}`
            : toJsonText(task);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

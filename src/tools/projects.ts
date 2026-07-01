import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown, formatDate, nameWithId } from "../services/format.js";
import { LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdFeedEntry, TdProject, paginate } from "../types.js";

const SearchProjectsInputSchema = z
  .object({
    search_text: z.string().max(200).optional().describe("Free-text search against project name."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by ProjectStatus IDs."),
    is_active: z.boolean().optional().describe("If true, only active projects. If false, only inactive."),
    project_manager_uids: z.array(z.string()).optional().describe("Filter by project manager person UID."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetProjectInputSchema = z
  .object({
    project_id: z.number().int().positive().describe("The project ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateProjectInputSchema = z
  .object({
    name: z.string().min(1).max(500).describe("The project name."),
    type_id: z.number().int().positive().optional().describe("The ProjectType ID."),
    status_id: z.number().int().positive().optional().describe("The initial ProjectStatus ID."),
    account_id: z.number().int().positive().optional().describe("The owning Account/Department ID."),
    project_manager_uid: z.string().optional().describe("Person UID of the project manager."),
    start_date: z.string().optional().describe("ISO 8601 planned start date."),
    end_date: z.string().optional().describe("ISO 8601 planned end date."),
    description: z.string().max(50000).optional(),
    notify_new_manager: z.boolean().default(false),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateProjectInputSchema = z
  .object({
    project_id: z.number().int().positive().describe("The project ID to update."),
    name: z.string().min(1).max(500).optional(),
    status_id: z.number().int().positive().optional(),
    project_manager_uid: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    description: z.string().max(50000).optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetProjectFeedInputSchema = z
  .object({
    project_id: z.number().int().positive().describe("The project ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const AddProjectCommentInputSchema = z
  .object({
    project_id: z.number().int().positive().describe("The project ID to comment on."),
    comment: z.string().min(1).max(50000).describe("The comment text."),
    notify_uids: z.array(z.string()).optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

function formatProjectMarkdown(p: TdProject): string {
  return [
    `## ${p.Name} (#${p.ID})`,
    `- **Status**: ${nameWithId(p.StatusName, p.StatusID)}`,
    `- **Project Manager**: ${p.ProjectManagerName ?? "N/A"}`,
    `- **Start**: ${formatDate(p.StartDate)}`,
    `- **End**: ${formatDate(p.EndDate)}`,
    `- **Percent Complete**: ${p.PercentComplete ?? 0}%`,
  ].join("\n");
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_search_projects",
    {
      title: "Search TeamDynamix Projects",
      description: `Search for projects across the TeamDynamix Projects/Workspaces application.

Args:
  - search_text (string, optional): Free-text search on project name
  - status_ids (number[], optional): Filter by ProjectStatus ID
  - is_active (boolean, optional)
  - project_manager_uids (string[], optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching projects.

Error Handling:
  - Returns "No projects found matching the given criteria" if search is empty`,
      inputSchema: SearchProjectsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const fetchCount = Math.min(params.offset + params.limit, 1000);
        const body: Record<string, unknown> = { MaxResults: fetchCount };
        if (params.search_text) body.SearchText = params.search_text;
        if (params.status_ids) body.StatusIDs = params.status_ids;
        if (params.is_active !== undefined) body.IsActive = params.is_active;
        if (params.project_manager_uids) body.ProjectManagerUids = params.project_manager_uids;

        const results = await tdRequest<TdProject[]>(`/projects/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);
        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No projects found matching the given criteria." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Project Search Results`, "", `Found ${page.total} project(s), showing ${page.items.length}`, ""];
          for (const p of page.items) lines.push(formatProjectMarkdown(p), "");
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
    "teamdynamix_get_project",
    {
      title: "Get TeamDynamix Project",
      description: `Gets full details on a single project, including custom attributes.

Args:
  - project_id (number): The project ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full project details.

Error Handling:
  - Returns "Error: Resource not found" if project_id is invalid`,
      inputSchema: GetProjectInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, response_format }) => {
      try {
        const project = await tdRequest<TdProject>(`/projects/${project_id}`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(formatProjectMarkdown(project))
            : toJsonText(project);
        return { content: [{ type: "text" as const, text }], structuredContent: project as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_project",
    {
      title: "Create TeamDynamix Project",
      description: `Creates a new project.

Args:
  - name (string): Project name
  - type_id, status_id, account_id, project_manager_uid, start_date, end_date, description (optional)
  - notify_new_manager (boolean, default false)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The newly created project, including its assigned ID.

Error Handling:
  - Returns "Error: ... rejected the request as invalid (400)" if required fields are missing
  - Returns "Error: Permission denied" if the account can't create projects`,
      inputSchema: CreateProjectInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { Name: params.name };
        if (params.type_id) body.TypeID = params.type_id;
        if (params.status_id) body.StatusID = params.status_id;
        if (params.account_id) body.AccountID = params.account_id;
        if (params.project_manager_uid) body.ProjectManagerUid = params.project_manager_uid;
        if (params.start_date) body.StartDate = params.start_date;
        if (params.end_date) body.EndDate = params.end_date;
        if (params.description) body.Description = params.description;

        const project = await tdRequest<TdProject>(`/projects`, "POST", body, {
          notifyNewManager: params.notify_new_manager,
        });
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Project Created\n\n${formatProjectMarkdown(project)}`)
            : toJsonText(project);
        return { content: [{ type: "text" as const, text }], structuredContent: project as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_project",
    {
      title: "Update TeamDynamix Project",
      description: `Patches an existing project, changing only the fields provided.

Args:
  - project_id (number): The project ID to update
  - name, status_id, project_manager_uid, start_date, end_date, description (all optional; at least one required)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated project.

Error Handling:
  - Returns "Error: Resource not found" if project_id is invalid`,
      inputSchema: UpdateProjectInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const ops: Array<{ op: "replace"; path: string; value: unknown }> = [];
        if (
          params.name === undefined &&
          params.status_id === undefined &&
          params.project_manager_uid === undefined &&
          params.start_date === undefined &&
          params.end_date === undefined &&
          params.description === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided (name, status_id, project_manager_uid, start_date, end_date, or description)." }],
          };
        }
        if (params.name !== undefined) ops.push({ op: "replace", path: "/Name", value: params.name });
        if (params.status_id !== undefined) ops.push({ op: "replace", path: "/StatusID", value: params.status_id });
        if (params.project_manager_uid !== undefined)
          ops.push({ op: "replace", path: "/ProjectManagerUid", value: params.project_manager_uid });
        if (params.start_date !== undefined) ops.push({ op: "replace", path: "/StartDate", value: params.start_date });
        if (params.end_date !== undefined) ops.push({ op: "replace", path: "/EndDate", value: params.end_date });
        if (params.description !== undefined) ops.push({ op: "replace", path: "/Description", value: params.description });

        const project = await tdRequest<TdProject>(`/projects/${params.project_id}`, "PATCH", ops);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Project Updated\n\n${formatProjectMarkdown(project)}`)
            : toJsonText(project);
        return { content: [{ type: "text" as const, text }], structuredContent: project as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_project_feed",
    {
      title: "Get TeamDynamix Project Feed",
      description: `Gets the feed entries (comments/updates) for a project, newest first.

Args:
  - project_id (number): The project ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of feed entries.

Error Handling:
  - Returns "Error: Resource not found" if project_id is invalid`,
      inputSchema: GetProjectFeedInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, response_format }) => {
      try {
        const feed = await tdRequest<TdFeedEntry[]>(`/projects/${project_id}/feed`);
        if (!feed || feed.length === 0) {
          return { content: [{ type: "text" as const, text: "No feed entries found for this project." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Feed for Project #${project_id}`, ""];
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
    "teamdynamix_add_project_comment",
    {
      title: "Add TeamDynamix Project Comment",
      description: `Adds a comment (feed entry) to a project.

Args:
  - project_id (number): The project ID
  - comment (string): The comment text
  - notify_uids (string[], optional): Person UIDs to notify
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The created feed entry.

Error Handling:
  - Returns "Error: Resource not found" if project_id is invalid`,
      inputSchema: AddProjectCommentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ project_id, comment, notify_uids, response_format }) => {
      try {
        const body: Record<string, unknown> = { Comments: comment };
        if (notify_uids?.length) body.Notify = notify_uids;
        const entry = await tdRequest<TdFeedEntry>(`/projects/${project_id}/feed`, "POST", body);
        const text =
          response_format === ResponseFormat.MARKDOWN ? `Comment added to project #${project_id}.` : toJsonText(entry);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

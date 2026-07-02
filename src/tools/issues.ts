import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown, nameWithId } from "../services/format.js";
import { AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdIssue, paginate } from "../types.js";

const SearchIssuesInputSchema = z
  .object({
    app_id: AppIdSchema,
    project_ids: z.array(z.number().int()).optional().describe("Restrict to these project IDs."),
    search_text: z.string().max(200).optional().describe("Free-text search against issue title."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by IssueStatus IDs."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetIssueInputSchema = z
  .object({
    app_id: AppIdSchema,
    project_id: z.number().int().positive().describe("The project ID the issue belongs to."),
    issue_id: z.number().int().positive().describe("The issue ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const CreateIssueInputSchema = z
  .object({
    app_id: AppIdSchema,
    project_id: z.number().int().positive().describe("The project ID to create the issue under."),
    title: z.string().min(1).max(500).describe("The issue title."),
    description: z.string().max(50000).optional(),
    status_id: z.number().int().positive().optional(),
    priority_name: z.string().optional().describe("The issue priority name, e.g. 'High'."),
    responsible_uid: z.string().optional().describe("Person UID responsible for the issue."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateIssueInputSchema = z
  .object({
    app_id: AppIdSchema,
    project_id: z.number().int().positive().describe("The project ID the issue belongs to."),
    issue_id: z.number().int().positive().describe("The issue ID to update."),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(50000).optional(),
    status_id: z.number().int().positive().optional(),
    responsible_uid: z.string().optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

function formatIssueMarkdown(i: TdIssue): string {
  return [
    `## ${i.Title} (#${i.ID})`,
    `- **Project**: #${i.ProjectID}`,
    `- **Status**: ${nameWithId(i.StatusName, i.StatusID)}`,
    `- **Priority**: ${i.PriorityName ?? "N/A"}`,
  ].join("\n");
}

export function registerIssueTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_search_issues",
    {
      title: "Search TeamDynamix Issues",
      description: `Search for issues (not tickets — project-level issue tracking) across TeamDynamix projects.

Args:
  - project_ids (number[], optional): Restrict search to these projects
  - search_text (string, optional)
  - status_ids (number[], optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching issues. Attributes are not included; use teamdynamix_get_issue for full details.

Error Handling:
  - Returns "No issues found matching the given criteria" if search is empty`,
      inputSchema: SearchIssuesInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const fetchCount = Math.min(params.offset + params.limit, 1000);
        const body: Record<string, unknown> = { MaxResults: fetchCount };
        if (params.project_ids) body.ProjectIDs = params.project_ids;
        if (params.search_text) body.SearchText = params.search_text;
        if (params.status_ids) body.StatusIDs = params.status_ids;

        const results = await tdRequest<TdIssue[]>(`/${params.app_id}/projects/issues/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);
        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No issues found matching the given criteria." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Issue Search Results`, "", `Found ${page.total} issue(s), showing ${page.items.length}`, ""];
          for (const i of page.items) lines.push(formatIssueMarkdown(i), "");
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
    "teamdynamix_get_issue",
    {
      title: "Get TeamDynamix Issue",
      description: `Gets full details on a single project issue.

Args:
  - project_id (number): The project ID
  - issue_id (number): The issue ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full issue details.

Error Handling:
  - Returns "Error: Resource not found" if project_id or issue_id is invalid`,
      inputSchema: GetIssueInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, project_id, issue_id, response_format }) => {
      try {
        const issue = await tdRequest<TdIssue>(`/${app_id}/projects/${project_id}/issues/${issue_id}`);
        const text =
          response_format === ResponseFormat.MARKDOWN ? truncateMarkdown(formatIssueMarkdown(issue)) : toJsonText(issue);
        return { content: [{ type: "text" as const, text }], structuredContent: issue as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_create_issue",
    {
      title: "Create TeamDynamix Issue",
      description: `Creates a new issue under a project.

Args:
  - project_id (number): The project to create the issue under
  - title (string): Issue title
  - description, status_id, priority_name, responsible_uid (optional)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The newly created issue, including its assigned ID.

Error Handling:
  - Returns "Error: ... rejected the request as invalid (400)" if required fields are missing
  - Returns "Error: Permission denied" if the account lacks TDProjects access`,
      inputSchema: CreateIssueInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { ProjectID: params.project_id, Title: params.title };
        if (params.description) body.Description = params.description;
        if (params.status_id) body.StatusID = params.status_id;
        if (params.priority_name) body.PriorityName = params.priority_name;
        if (params.responsible_uid) body.ResponsibleUid = params.responsible_uid;

        const issue = await tdRequest<TdIssue>(`/${params.app_id}/projects/issues`, "POST", body);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Issue Created\n\n${formatIssueMarkdown(issue)}`)
            : toJsonText(issue);
        return { content: [{ type: "text" as const, text }], structuredContent: issue as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_update_issue",
    {
      title: "Update TeamDynamix Issue",
      description: `Updates an existing project issue. This is a full-field edit endpoint on the TeamDynamix side, but this tool only sends the fields you provide, merged onto the existing issue.

Args:
  - project_id (number): The project ID
  - issue_id (number): The issue ID to update
  - title, description, status_id, responsible_uid (all optional; at least one required)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The updated issue.

Error Handling:
  - Returns "Error: Resource not found" if project_id or issue_id is invalid`,
      inputSchema: UpdateIssueInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (
          params.title === undefined &&
          params.description === undefined &&
          params.status_id === undefined &&
          params.responsible_uid === undefined
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: At least one field to update must be provided (title, description, status_id, or responsible_uid)." }],
          };
        }
        const existing = await tdRequest<TdIssue>(`/${params.app_id}/projects/${params.project_id}/issues/${params.issue_id}`);
        const merged = {
          ...existing,
          ...(params.title !== undefined ? { Title: params.title } : {}),
          ...(params.description !== undefined ? { Description: params.description } : {}),
          ...(params.status_id !== undefined ? { StatusID: params.status_id } : {}),
          ...(params.responsible_uid !== undefined ? { ResponsibleUid: params.responsible_uid } : {}),
        };
        const issue = await tdRequest<TdIssue>(`/${params.app_id}/projects/${params.project_id}/issues/${params.issue_id}`, "POST", merged);
        const text =
          params.response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`# Issue Updated\n\n${formatIssueMarkdown(issue)}`)
            : toJsonText(issue);
        return { content: [{ type: "text" as const, text }], structuredContent: issue as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

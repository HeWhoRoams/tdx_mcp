import { z } from "zod";
import { getConfig } from "../config.js";
import { CREATE, EDIT, READ } from "../framework/annotations.js";
import { defineTool, ToolInputError, type AnyToolDefinition } from "../framework/defineTool.js";
import { ChildPagingShape, PagingShape, PersonRefSchema, ResponseFormatSchema, sortBySchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolvePersonUid, resolvePersonUids } from "../services/context.js";
import { formatDate, nameWithId, renderFeed } from "../services/format.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";
import { paginate, type TdFeedEntry, type TdProject } from "../types.js";

const ProjectIdSchema = z.number().int().positive().describe("The project ID.");

const SORT_FIELDS = { name: "Name", start: "StartDate", end: "EndDate", id: "ID" };

const SearchInput = z
  .object({
    search_text: z.string().max(200).optional().describe("Free-text search against project name."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by ProjectStatus IDs."),
    is_active: z.boolean().optional().describe("True for only active projects, false for only inactive."),
    project_manager_uids: z
      .array(z.string())
      .optional()
      .describe("Filter by project manager. Accepts UIDs or email addresses."),
    sort_by: sortBySchema(["name", "start", "end", "id"]),
    ...PagingShape,
  })
  .strict();

const GetInput = z.object({ project_id: ProjectIdSchema, response_format: ResponseFormatSchema }).strict();

const CreateInput = z
  .object({
    name: z.string().min(1).max(500).describe("The project name."),
    type_id: z.number().int().positive().optional().describe("The ProjectType ID."),
    status_id: z.number().int().positive().optional().describe("The initial ProjectStatus ID."),
    account_id: z.number().int().positive().optional().describe("The owning Account/Department ID."),
    project_manager_uid: PersonRefSchema("The project manager").optional(),
    start_date: z.string().optional().describe("ISO 8601 planned start date."),
    end_date: z.string().optional().describe("ISO 8601 planned end date."),
    description: z.string().max(50000).optional().describe("The project description."),
    notify_new_manager: z.boolean().default(false).describe("Email the assigned project manager."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateInput = z
  .object({
    project_id: ProjectIdSchema,
    name: z.string().min(1).max(500).optional().describe("New project name."),
    status_id: z.number().int().positive().optional().describe("New ProjectStatus ID."),
    project_manager_uid: PersonRefSchema("The new project manager").optional(),
    start_date: z.string().optional().describe("ISO 8601 planned start date."),
    end_date: z.string().optional().describe("ISO 8601 planned end date."),
    description: z.string().max(50000).optional().describe("New project description."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const FeedInput = z.object({ project_id: ProjectIdSchema, ...ChildPagingShape }).strict();

const CommentInput = z
  .object({
    project_id: ProjectIdSchema,
    comment: z.string().min(1).max(50000).describe("The comment text to add."),
    notify_uids: z.array(z.string()).optional().describe("People to notify. Accepts UIDs or email addresses."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function renderProject(project: TdProject): string {
  return [
    `## ${project.Name} (#${project.ID})`,
    `- **Status**: ${nameWithId(project.StatusName, project.StatusID)}`,
    `- **Project Manager**: ${project.ProjectManagerName ?? "N/A"}`,
    `- **Start**: ${formatDate(project.StartDate)}`,
    `- **End**: ${formatDate(project.EndDate)}`,
    `- **Percent Complete**: ${project.PercentComplete ?? 0}%`,
  ].join("\n");
}

const PROJECTS = { domain: "projects" };

export const projectTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_search_projects",
    title: "Search TeamDynamix Projects",
    description:
      "Searches projects by name, status, active state, or project manager.\nThis endpoint is organization-wide and needs no app_id.",
    input: SearchInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.status_ids) body.StatusIDs = args.status_ids;
      if (args.is_active !== undefined) body.IsActive = args.is_active;
      const managers = await resolvePersonUids(args.project_manager_uids);
      if (managers) body.ProjectManagerUids = managers;
      return searchPage<TdProject>("/projects/search", body, args, { sortFields: SORT_FIELDS });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No projects found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "project");
      const lines = resultsHeading("Project Search Results", page, "project");
      for (const project of page.items) lines.push(renderProject(project), "");
      lines.push(...pagingFooter(page));
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_get_project",
    title: "Get TeamDynamix Project",
    description: "Gets one project in full, including custom attributes.",
    input: GetInput,
    annotations: READ,
    handler: (args) => {
      const path = `/projects/${args.project_id}`;
      return tdRequest<TdProject>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
    },
    render: (project) => renderProject(project),
  }),

  defineTool({
    name: "teamdynamix_create_project",
    title: "Create TeamDynamix Project",
    description: "Creates a project. Only name is required.",
    input: CreateInput,
    annotations: CREATE,
    invalidates: PROJECTS,
    handler: async (args) => {
      const body: Record<string, unknown> = { Name: args.name };
      if (args.type_id) body.TypeID = args.type_id;
      if (args.status_id) body.StatusID = args.status_id;
      if (args.account_id) body.AccountID = args.account_id;
      if (args.project_manager_uid) body.ProjectManagerUid = await resolvePersonUid(args.project_manager_uid);
      if (args.start_date) body.StartDate = args.start_date;
      if (args.end_date) body.EndDate = args.end_date;
      if (args.description) body.Description = args.description;
      return tdRequest<TdProject>("/projects", {
        method: "POST",
        data: body,
        params: { notifyNewManager: args.notify_new_manager },
      });
    },
    render: (project) => `# Project Created\n\n${renderProject(project)}`,
  }),

  defineTool({
    name: "teamdynamix_edit_project",
    title: "Edit TeamDynamix Project",
    description: "Edits a project's core fields, changing only the ones you supply.\nAt least one editable field is required.",
    input: UpdateInput,
    annotations: EDIT,
    invalidates: PROJECTS,
    handler: async (args) => {
      const operations: Array<{ op: "replace"; path: string; value: unknown }> = [];
      const add = (path: string, value: unknown) => {
        if (value !== undefined) operations.push({ op: "replace", path, value });
      };
      add("/Name", args.name);
      add("/StatusID", args.status_id);
      add(
        "/ProjectManagerUid",
        args.project_manager_uid ? await resolvePersonUid(args.project_manager_uid) : undefined
      );
      add("/StartDate", args.start_date);
      add("/EndDate", args.end_date);
      add("/Description", args.description);
      if (operations.length === 0) {
        throw new ToolInputError(
          "At least one field to update must be provided (name, status_id, project_manager_uid, start_date, end_date, or description)."
        );
      }
      return tdRequest<TdProject>(`/projects/${args.project_id}`, { method: "PATCH", data: operations });
    },
    render: (project) => `# Project Edited\n\n${renderProject(project)}`,
  }),

  defineTool({
    name: "teamdynamix_get_project_feed",
    title: "Get TeamDynamix Project Feed",
    description: "Gets a project's feed entries (comments and updates), newest first.\nPage with limit/offset.",
    input: FeedInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/projects/${args.project_id}/feed`;
      const feed = await tdRequest<TdFeedEntry[]>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(feed ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "No feed entries found for this project.",
    render: (page, args) => {
      const body = renderFeed(`Feed for Project #${args.project_id} (${page.count} of ${page.total})`, page.items);
      return page.has_more ? `${body}\n_More entries available. Use offset=${page.next_offset}._` : body;
    },
  }),

  defineTool({
    name: "teamdynamix_add_project_comment",
    title: "Add TeamDynamix Project Comment",
    description: "Adds a comment (feed entry) to a project, optionally notifying people.",
    input: CommentInput,
    annotations: CREATE,
    invalidates: PROJECTS,
    handler: async (args) => {
      const body: Record<string, unknown> = { Comments: args.comment };
      const notify = await resolvePersonUids(args.notify_uids);
      if (notify?.length) body.Notify = notify;
      return tdRequest<TdFeedEntry>(`/projects/${args.project_id}/feed`, { method: "POST", data: body });
    },
    render: (_entry, args) => `Comment added to project #${args.project_id}.`,
  }),
];

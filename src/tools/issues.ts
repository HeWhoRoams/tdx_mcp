import { z } from "zod";
import { getConfig } from "../config.js";
import { CREATE, EDIT, READ } from "../framework/annotations.js";
import { defineTool, ToolInputError, type AnyToolDefinition } from "../framework/defineTool.js";
import { AppIdSchema, PagingShape, PersonRefSchema, ResponseFormatSchema, sortBySchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolveAppId, resolvePersonUid } from "../services/context.js";
import { nameWithId } from "../services/format.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";
import type { TdIssue } from "../types.js";

const ProjectIdSchema = z.number().int().positive().describe("The project ID the issue belongs to.");
const IssueIdSchema = z.number().int().positive().describe("The issue ID.");

const SORT_FIELDS = { title: "Title", status: "StatusID", id: "ID" };

const SearchInput = z
  .object({
    app_id: AppIdSchema,
    project_ids: z.array(z.number().int()).optional().describe("Restrict to these project IDs."),
    search_text: z.string().max(200).optional().describe("Free-text search against issue title."),
    status_ids: z.array(z.number().int()).optional().describe("Filter by IssueStatus IDs."),
    sort_by: sortBySchema(["title", "status", "id"]),
    ...PagingShape,
  })
  .strict();

const GetInput = z
  .object({ app_id: AppIdSchema, project_id: ProjectIdSchema, issue_id: IssueIdSchema, response_format: ResponseFormatSchema })
  .strict();

const CreateInput = z
  .object({
    app_id: AppIdSchema,
    project_id: z.number().int().positive().describe("The project ID to create the issue under."),
    title: z.string().min(1).max(500).describe("The issue title."),
    description: z.string().max(50000).optional().describe("The issue description."),
    status_id: z.number().int().positive().optional().describe("The IssueStatus ID."),
    priority_name: z.string().optional().describe("The issue priority name, e.g. 'High'."),
    responsible_uid: PersonRefSchema("The person responsible for the issue").optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

const UpdateInput = z
  .object({
    app_id: AppIdSchema,
    project_id: ProjectIdSchema,
    issue_id: IssueIdSchema,
    title: z.string().min(1).max(500).optional().describe("New issue title."),
    description: z.string().max(50000).optional().describe("New issue description."),
    status_id: z.number().int().positive().optional().describe("New IssueStatus ID."),
    responsible_uid: PersonRefSchema("The new responsible person").optional(),
    response_format: ResponseFormatSchema,
  })
  .strict();

function renderIssue(issue: TdIssue): string {
  return [
    `## ${issue.Title} (#${issue.ID})`,
    `- **Project**: #${issue.ProjectID}`,
    `- **Status**: ${nameWithId(issue.StatusName, issue.StatusID)}`,
    `- **Priority**: ${issue.PriorityName ?? "N/A"}`,
  ].join("\n");
}

const ISSUES = { domain: "projects", appIdFrom: (args: { app_id?: number }) => resolveAppId(args.app_id) };

export const issueTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_search_issues",
    title: "Search TeamDynamix Issues",
    description:
      "Searches project issues (project-level issue tracking, not tickets) by project, text, or status.\n" +
      "Returns partial records — use teamdynamix_get_issue for full detail.",
    input: SearchInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.project_ids) body.ProjectIDs = args.project_ids;
      if (args.search_text) body.SearchText = args.search_text;
      if (args.status_ids) body.StatusIDs = args.status_ids;
      return searchPage<TdIssue>(`/${resolveAppId(args.app_id)}/projects/issues/search`, body, args, {
        sortFields: SORT_FIELDS,
      });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No issues found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "issue");
      const lines = resultsHeading("Issue Search Results", page, "issue");
      for (const issue of page.items) lines.push(renderIssue(issue), "");
      lines.push(...pagingFooter(page));
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_get_issue",
    title: "Get TeamDynamix Issue",
    description: "Gets one project issue in full.",
    input: GetInput,
    annotations: READ,
    handler: (args) => {
      const path = `/${resolveAppId(args.app_id)}/projects/${args.project_id}/issues/${args.issue_id}`;
      return tdRequest<TdIssue>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
    },
    render: (issue) => renderIssue(issue),
  }),

  defineTool({
    name: "teamdynamix_create_issue",
    title: "Create TeamDynamix Issue",
    description: "Creates an issue under a project. Requires project_id and title.",
    input: CreateInput,
    annotations: CREATE,
    invalidates: ISSUES,
    handler: async (args) => {
      const body: Record<string, unknown> = { ProjectID: args.project_id, Title: args.title };
      if (args.description) body.Description = args.description;
      if (args.status_id) body.StatusID = args.status_id;
      if (args.priority_name) body.PriorityName = args.priority_name;
      if (args.responsible_uid) body.ResponsibleUid = await resolvePersonUid(args.responsible_uid);
      return tdRequest<TdIssue>(`/${resolveAppId(args.app_id)}/projects/issues`, { method: "POST", data: body });
    },
    render: (issue) => `# Issue Created\n\n${renderIssue(issue)}`,
  }),

  defineTool({
    name: "teamdynamix_edit_issue",
    title: "Edit TeamDynamix Issue",
    description:
      "Edits a project issue's core fields, changing only the ones you supply.\n" +
      "Uses read-modify-write because TeamDynamix has no PATCH here, so concurrent edits can overwrite each other.",
    input: UpdateInput,
    annotations: EDIT,
    readModifyWrite: true,
    invalidates: ISSUES,
    handler: async (args) => {
      const changes: Record<string, unknown> = {};
      if (args.title !== undefined) changes.Title = args.title;
      if (args.description !== undefined) changes.Description = args.description;
      if (args.status_id !== undefined) changes.StatusID = args.status_id;
      if (args.responsible_uid !== undefined) changes.ResponsibleUid = await resolvePersonUid(args.responsible_uid);
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError(
          "At least one field to update must be provided (title, description, status_id, or responsible_uid)."
        );
      }
      const path = `/${resolveAppId(args.app_id)}/projects/${args.project_id}/issues/${args.issue_id}`;
      const existing = await tdRequest<TdIssue>(path);
      return tdRequest<TdIssue>(path, { method: "POST", data: { ...existing, ...changes } });
    },
    render: (issue) => `# Issue Edited\n\n${renderIssue(issue)}`,
  }),
];

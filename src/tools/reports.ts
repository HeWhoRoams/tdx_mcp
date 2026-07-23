import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown } from "../services/format.js";
import { AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const ListReportsInputSchema = z
  .object({
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetReportInputSchema = z
  .object({
    report_id: z.number().int().positive().describe("The Report Builder report ID."),
    with_data: z.boolean().default(true).describe("If true (default), returns both the report definition and its data rows."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const ListSavedSearchesInputSchema = z
  .object({
    app_id: AppIdSchema,
    domain: z.enum(["tickets", "assets", "cmdb"]).describe("Which domain's saved searches to list: 'tickets', 'assets', or 'cmdb' (configuration items)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const RunSavedSearchInputSchema = z
  .object({
    app_id: AppIdSchema,
    domain: z.enum(["tickets", "assets", "cmdb"]).describe("Which domain the saved search belongs to: 'tickets', 'assets', or 'cmdb'."),
    search_id: z.number().int().positive().describe("The saved search ID (from teamdynamix_list_saved_searches)."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_list_reports",
    {
      title: "List TeamDynamix Reports",
      description: `Lists all Report Builder reports visible to the current user. Reports are pre-built queries that can return complex cross-entity data. Use teamdynamix_get_report to execute one and retrieve its data.

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of reports with their IDs, names, and descriptions.`,
      inputSchema: ListReportsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      try {
        const reports = await tdRequest<Array<Record<string, unknown>>>(`/reports`);
        if (!reports || reports.length === 0) {
          return { content: [{ type: "text" as const, text: "No reports found." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Available Reports (${reports.length})`, ""];
          for (const r of reports) {
            lines.push(`- **${r.Name}** (ID: ${r.ID})${r.Description ? ` — ${r.Description}` : ""}`);
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(reports);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: reports } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_report",
    {
      title: "Get TeamDynamix Report Data",
      description: `Executes a Report Builder report and returns its data rows. This is the most powerful way to query TeamDynamix for complex or cross-entity data that the individual search tools can't express.

Use teamdynamix_list_reports first to discover report IDs.

Args:
  - report_id (number): The report ID
  - with_data (boolean, default true): Whether to include data rows. Set false to only get report metadata.
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Report definition and (if with_data=true) all result rows.

Error Handling:
  - Returns "Error: Resource not found" if report_id is invalid
  - Returns "Error: Permission denied" if the account lacks access to this report`,
      inputSchema: GetReportInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ report_id, with_data, response_format }) => {
      try {
        const report = await tdRequest<Record<string, unknown>>(`/reports/${report_id}`, "GET", undefined, {
          withData: with_data,
        });
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Report: ${report.Name ?? report_id}`, ""];
          if (report.Description) lines.push(String(report.Description), "");
          const rows = report.DataRows as Array<Record<string, unknown>> | undefined;
          if (rows && rows.length > 0) {
            lines.push(`**${rows.length} row(s) returned.**`, "");
            // Render as a simple key-value list for the first few rows to stay readable
            const preview = rows.slice(0, 50);
            for (const row of preview) {
              lines.push(
                Object.entries(row)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" | ")
              );
            }
            if (rows.length > 50) lines.push(`\n_...and ${rows.length - 50} more rows. Use response_format='json' for full data._`);
          } else if (with_data) {
            lines.push("_No data rows returned._");
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(report);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: report };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_list_saved_searches",
    {
      title: "List TeamDynamix Saved Searches",
      description: `Lists saved searches visible to the current user for a given domain (tickets, assets, or CIs). Saved searches are pre-configured filters that technicians have saved in TDX. Use teamdynamix_run_saved_search to execute one.

Args:
  - app_id (number): The application ID
  - domain ('tickets' | 'assets' | 'cmdb'): Which domain's saved searches to list
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of saved searches with ID and Name.

Error Handling:
  - Returns "Error: Resource not found" if app_id is invalid`,
      inputSchema: ListSavedSearchesInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, domain, response_format }) => {
      try {
        const domainPath = domain === "cmdb" ? "cmdb" : domain === "assets" ? "assets" : "tickets";
        const searches = await tdRequest<Array<Record<string, unknown>>>(`/${app_id}/${domainPath}/searches`);
        if (!searches || searches.length === 0) {
          return { content: [{ type: "text" as const, text: `No saved searches found for ${domain} in app ${app_id}.` }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Saved ${domain} Searches (${searches.length})`, ""];
          for (const s of searches) {
            lines.push(`- **${s.Name}** (ID: ${s.ID})`);
          }
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(searches);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: searches } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_run_saved_search",
    {
      title: "Run TeamDynamix Saved Search",
      description: `Executes a saved search and returns paginated results. Use teamdynamix_list_saved_searches to discover search IDs.

Args:
  - app_id (number): The application ID
  - domain ('tickets' | 'assets' | 'cmdb'): Which domain the saved search belongs to
  - search_id (number): The saved search ID
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated results matching the saved search criteria.

Error Handling:
  - Returns "Error: Resource not found" if search_id or app_id is invalid`,
      inputSchema: RunSavedSearchInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const domainPath = params.domain === "cmdb" ? "cmdb" : params.domain === "assets" ? "assets" : "tickets";
        const body = { MaxResults: params.offset + params.limit };
        const result = await tdRequest<Record<string, unknown>>(
          `/${params.app_id}/${domainPath}/searches/${params.search_id}/results`,
          "POST",
          body
        );
        // The results endpoint returns { ResultCount, Results[] } or similar
        const items = (result.Results ?? result.Items ?? result) as Array<Record<string, unknown>>;
        const arr = Array.isArray(items) ? items : [];
        const page = arr.slice(params.offset, params.offset + params.limit);
        const has_more = arr.length > params.offset + page.length;

        if (page.length === 0) {
          return { content: [{ type: "text" as const, text: "No results found for this saved search." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Saved Search Results`, "", `Showing ${page.length} of ${arr.length} result(s)`, ""];
          for (const item of page) {
            const id = item.ID ?? item.Id ?? "?";
            const name = item.Title ?? item.Name ?? "(no name)";
            lines.push(`- **${name}** (#${id})`);
          }
          if (has_more) lines.push("", `_More results available. Use offset=${params.offset + page.length} to continue._`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText({ items: page, has_more, next_offset: has_more ? params.offset + page.length : undefined });
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: page, has_more } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

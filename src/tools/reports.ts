import { z } from "zod";
import { getConfig } from "../config.js";
import { READ } from "../framework/annotations.js";
import { defineTool, items, type AnyToolDefinition } from "../framework/defineTool.js";
import { AppIdSchema, PagingShape, ResponseFormatSchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolveAppId } from "../services/context.js";
import { truncate } from "../services/format.js";
import { pagingFooter, renderCount, resultsHeading, searchPage } from "../services/search.js";

const DomainSchema = z
  .enum(["tickets", "assets", "cmdb"])
  .describe("Which domain the saved search belongs to: tickets, assets, or cmdb (configuration items).");

const ListReportsInput = z.object({ response_format: ResponseFormatSchema }).strict();

const GetReportInput = z
  .object({
    report_id: z.number().int().positive().describe("The Report Builder report ID."),
    with_data: z.boolean().default(true).describe("Include data rows; set false for metadata only."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const ListSavedSearchesInput = z
  .object({ app_id: AppIdSchema, domain: DomainSchema, response_format: ResponseFormatSchema })
  .strict();

const RunSavedSearchInput = z
  .object({
    app_id: AppIdSchema,
    domain: DomainSchema,
    search_id: z.number().int().positive().describe("The saved search ID (from teamdynamix_list_saved_searches)."),
    ...PagingShape,
  })
  .strict();

const MAX_PREVIEW_ROWS = 50;

export const reportTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_list_reports",
    title: "List TeamDynamix Reports",
    description:
      "Lists Report Builder reports visible to the authenticated account.\nPair with teamdynamix_get_report to execute one.",
    input: ListReportsInput,
    annotations: READ,
    handler: async () =>
      items(
        await tdRequest<Array<Record<string, unknown>>>("/reports", {
          cacheKey: "/reports",
          cacheTtlMs: getConfig().cache.referenceTtlMs,
        })
      ),
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No reports found.",
    render: (data) => {
      const lines = [`# Available Reports (${data.items.length})`, ""];
      for (const report of data.items) {
        lines.push(`- **${report.Name}** (ID: ${report.ID})${report.Description ? ` — ${report.Description}` : ""}`);
      }
      return truncate(lines.join("\n"));
    },
  }),

  defineTool({
    name: "teamdynamix_get_report",
    title: "Get TeamDynamix Report Data",
    description:
      "Runs a Report Builder report and returns its rows — the most capable way to answer complex or cross-entity questions.\n" +
      "Prefer this over chaining many searches. Discover report_id with teamdynamix_list_reports.",
    input: GetReportInput,
    annotations: READ,
    handler: (args) =>
      tdRequest<Record<string, unknown>>(`/reports/${args.report_id}`, { params: { withData: args.with_data } }),
    render: (report, args) => {
      const lines = [`# Report: ${report.Name ?? args.report_id}`, ""];
      if (report.Description) lines.push(String(report.Description), "");
      const rows = report.DataRows as Array<Record<string, unknown>> | undefined;
      if (rows && rows.length > 0) {
        lines.push(`**${rows.length} row(s) returned.**`, "");
        for (const row of rows.slice(0, MAX_PREVIEW_ROWS)) {
          lines.push(
            Object.entries(row)
              .map(([key, value]) => `${key}: ${value}`)
              .join(" | ")
          );
        }
        if (rows.length > MAX_PREVIEW_ROWS) {
          lines.push(`\n_...and ${rows.length - MAX_PREVIEW_ROWS} more rows. Use response_format='json' for full data._`);
        }
      } else if (args.with_data) {
        lines.push("_No data rows returned._");
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "teamdynamix_list_saved_searches",
    title: "List TeamDynamix Saved Searches",
    description:
      "Lists saved searches for a domain (tickets, assets, or cmdb) in an application.\nExecute one with teamdynamix_run_saved_search.",
    input: ListSavedSearchesInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/${resolveAppId(args.app_id)}/${args.domain}/searches`;
      return items(
        await tdRequest<Array<Record<string, unknown>>>(path, {
          cacheKey: path,
          cacheTtlMs: getConfig().cache.referenceTtlMs,
        })
      );
    },
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No saved searches found for that domain and application.",
    render: (data, args) => {
      const lines = [`# Saved ${args.domain} Searches (${data.items.length})`, ""];
      for (const search of data.items) lines.push(`- **${search.Name}** (ID: ${search.ID})`);
      return truncate(lines.join("\n"));
    },
  }),

  defineTool({
    name: "teamdynamix_run_saved_search",
    title: "Run TeamDynamix Saved Search",
    description:
      "Executes a saved search and returns paginated results.\n" +
      "Strong choice for large or complex result sets that the individual search tools cannot express.",
    input: RunSavedSearchInput,
    annotations: READ,
    handler: (args) =>
      searchPage(`/${resolveAppId(args.app_id)}/${args.domain}/searches/${args.search_id}/results`, {}, args),
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No results found for this saved search.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "result");
      const lines = resultsHeading("Saved Search Results", page, "result");
      for (const item of page.items) {
        const record = item as Record<string, unknown>;
        lines.push(`- **${record.Title ?? record.Name ?? "(no name)"}** (#${record.ID ?? record.Id ?? "?"})`);
      }
      lines.push("", ...pagingFooter(page));
      return lines.join("\n");
    },
  }),
];

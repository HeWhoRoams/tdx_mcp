import { toolName } from "../constants.js";
import { z } from "zod";
import { getConfig } from "../config.js";
import { READ } from "../framework/annotations.js";
import { defineTool, items, type AnyToolDefinition } from "../framework/defineTool.js";
import { AppIdSchema, PagingShape, ResponseFormatSchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolveAppId } from "../services/context.js";
import { truncate } from "../services/format.js";
import { tableCell } from "../services/fields.js";
import { ToolInputError } from "../services/errors.js";
import { pagedSearch } from "../services/paged-search.js";
import { moreLine, pageBlocks, renderCount, signature } from "../services/search.js";
import { decodeCursor, paginate, type PaginatedResult, type TdAsset, type TdCi, type TdTicket } from "../types.js";
import { renderAssetCompact } from "./assets.js";
import { renderCiCompact } from "./cmdb.js";
import { renderTicketCompact } from "./tickets.js";

const DomainSchema = z
  .enum(["tickets", "assets", "cmdb"])
  .describe("Which domain the saved search belongs to: tickets, assets, or cmdb (configuration items).");

const ListReportsInput = z.object({ response_format: ResponseFormatSchema }).strict();

const GetReportInput = z
  .object({
    report_id: z.number().int().positive().describe("The Report Builder report ID."),
    with_data: z.boolean().default(true).describe("Include data rows; set false for metadata only."),
    columns: z
      .array(z.string().min(1))
      .max(40)
      .optional()
      .describe("Only these columns, by name. Omit for all columns."),
    limit: PagingShape.limit,
    offset: PagingShape.offset,
    cursor: PagingShape.cursor,
    count_only: PagingShape.count_only,
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
    search_id: z.number().int().positive().describe("The saved search ID (from tdx_list_saved_searches)."),
    search_text: z.string().max(200).optional().describe("Only results matching this text, within the saved search."),
    only_mine: z.boolean().optional().describe("Only results that involve the signed-in user."),
    // The saved search defines its own order, so unlike the other search tools there is no sort_order.
    limit: PagingShape.limit,
    offset: PagingShape.offset,
    cursor: PagingShape.cursor,
    count_only: PagingShape.count_only,
    fields: PagingShape.fields,
    response_format: PagingShape.response_format,
  })
  .strict();

type Row = Record<string, unknown>;

interface ReportPage extends PaginatedResult<Row> {
  report: { id: number; name?: unknown; description?: unknown };
  columns: string[];
  /** Columns the caller asked for that the report does not have. */
  unknown_columns?: string[];
}

/** Column names from the report's metadata when it has any, else from the first row. */
function reportColumns(report: Row, rows: Row[]): string[] {
  const meta = Array.isArray(report.Columns) ? (report.Columns as Row[]) : [];
  const named = meta
    .map((column) => (column.DataColumnName ?? column.HeaderText ?? column.Name) as unknown)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (named.length > 0) return named;
  return Object.keys(rows[0] ?? {});
}

function pickColumns(available: string[], wanted: string[] | undefined): { columns: string[]; unknown: string[] } {
  if (!wanted?.length) return { columns: available, unknown: [] };
  const columns: string[] = [];
  const unknown: string[] = [];
  for (const name of wanted) {
    const match = available.find((column) => column.toLowerCase() === name.toLowerCase());
    if (match) columns.push(match);
    else unknown.push(name);
  }
  return { columns, unknown };
}

/** One line per result, in the same compact form as the matching search tool. */
function renderSavedSearchRow(domain: "tickets" | "assets" | "cmdb", appId: number, record: Record<string, unknown>): string {
  if (domain === "tickets") return renderTicketCompact(record as unknown as TdTicket, appId);
  if (domain === "assets") return renderAssetCompact(record as unknown as TdAsset);
  return renderCiCompact(record as unknown as TdCi);
}

export const reportTools: AnyToolDefinition[] = [
  defineTool({
    name: toolName("list_reports"),
    title: "List TeamDynamix Reports",
    description:
      "Lists Report Builder reports visible to the authenticated account.\nPair with tdx_get_report to execute one.",
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
    name: toolName("get_report"),
    title: "Get TeamDynamix Report Data",
    description:
      "Runs a Report Builder report and returns its rows — the most capable way to answer complex or cross-entity questions.\n" +
      "Prefer this over chaining many searches. Discover report_id with tdx_list_reports.",
    input: GetReportInput,
    annotations: READ,
    handler: async (args): Promise<ReportPage> => {
      const ttlMs = getConfig().cache.searchTtlMs;
      // The run is cached whole so paging through a report does not execute it again each page.
      const report = await tdRequest<Row>(`/reports/${args.report_id}`, {
        params: { withData: args.with_data },
        cacheKey: `/reports/${args.report_id}?data=${args.with_data}`,
        cacheTier: "record",
        cacheTtlMs: ttlMs,
        dedupe: true,
      });
      const rows = Array.isArray(report?.DataRows) ? (report.DataRows as Row[]) : [];
      const available = reportColumns(report ?? {}, rows);
      const { columns, unknown } = pickColumns(available, args.columns);
      const projected = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
      const sig = signature(`/reports/${args.report_id}`, columns.join(","));
      let offset = args.offset;
      if (args.cursor) {
        const decoded = decodeCursor(args.cursor);
        if (!decoded || decoded.signature !== sig) {
          throw new ToolInputError("Invalid cursor for this report. Omit 'cursor' to start from the beginning.");
        }
        offset = decoded.offset;
      }
      const page = paginate(projected, args.count_only ? 0 : args.limit, offset, { signature: sig });
      return {
        report: { id: args.report_id, name: report?.Name, description: report?.Description },
        columns,
        ...page,
        ...(args.count_only ? { has_more: false, offset: 0 } : {}),
        ...(unknown.length > 0 ? { unknown_columns: unknown } : {}),
      };
    },
    render: (page, args) => {
      const title = `Report: ${page.report.name ?? args.report_id}`;
      const notes: string[] = [];
      if (page.unknown_columns) {
        notes.push(`_Unknown columns: ${page.unknown_columns.join(", ")}. Available: ${page.columns.join(", ")}._`);
      }
      if (args.count_only) return `${title}\n\n${page.total} row(s).${notes.length ? `\n${notes.join("\n")}` : ""}`;
      const header = [`# ${title}`, ""];
      if (page.report.description) header.push(String(page.report.description), "");
      if (!args.with_data) {
        return [...header, `Columns: ${page.columns.join(", ") || "(none reported)"}`, ...notes].join("\n");
      }
      if (page.items.length === 0) {
        return [...header, page.total === 0 ? "_No data rows returned._" : "_No rows on this page._", ...notes].join("\n");
      }
      header.push(`${page.total} row(s), showing ${page.count}`, "");
      header.push(`| ${page.columns.join(" | ")} |`, `| ${page.columns.map(() => "---").join(" | ")} |`);
      return {
        header,
        blocks: page.items.map((row) => `| ${page.columns.map((column) => tableCell(row[column])).join(" | ")} |`),
        separator: "\n",
        footer: notes,
        ...(page.has_more ? { more: moreLine(page)! } : {}),
        offset: page.offset,
      };
    },
  }),

  defineTool({
    name: toolName("list_saved_searches"),
    title: "List TeamDynamix Saved Searches",
    description:
      "Lists saved searches for a domain (tickets, assets, or cmdb) in an application.\nExecute one with tdx_run_saved_search.",
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
    name: toolName("run_saved_search"),
    title: "Run TeamDynamix Saved Search",
    description:
      "Executes a saved search and returns paginated results with an exact total.\n" +
      "Strong choice for large or complex result sets that the individual search tools cannot express.",
    input: RunSavedSearchInput,
    annotations: READ,
    handler: (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.only_mine !== undefined) body.OnlyMy = args.only_mine;
      return pagedSearch<Record<string, unknown>>(
        `/${resolveAppId(args.app_id)}/${args.domain}/searches/${args.search_id}/results`,
        body,
        args
      );
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No results found for this saved search.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "result");
      return pageBlocks(
        "Saved Search Results",
        "result",
        page,
        page.items.map((item) => renderSavedSearchRow(args.domain, resolveAppId(args.app_id), item)),
        "\n"
      );
    },
  }),
];

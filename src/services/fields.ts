import type { RenderedBlocks } from "./budget.js";
import { formatDate } from "./format.js";
import type { PaginatedResult } from "../types.js";

/**
 * Field selection for list results. A model that needs three columns from four hundred tickets
 * should not pay for every field of every record, so `fields` projects each row to the named keys
 * (plus ID) and renders a table. Names match case-insensitively, and an unknown name is reported with
 * valid examples instead of failing, so the next call can be right without an error round trip.
 */

const MAX_AVAILABLE_LISTED = 20;

export interface Projection {
  /** Keys actually projected, in the order requested, as spelled in the data. */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  unknown: string[];
  /** Valid keys taken from the first row, offered when a name did not match. */
  available: string[];
}

function keyOf(record: Record<string, unknown>, wanted: string): string | undefined {
  if (wanted in record) return wanted;
  const lower = wanted.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === lower);
}

export function projectItems(items: unknown[], fields: string[]): Projection {
  const records = items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  const sample = records[0] ?? {};
  const columns: string[] = [];
  const unknown: string[] = [];
  for (const wanted of fields) {
    const key = keyOf(sample, wanted);
    if (key === undefined) unknown.push(wanted);
    else if (!columns.includes(key)) columns.push(key);
  }
  const withId = "ID" in sample && !columns.includes("ID") ? ["ID", ...columns] : columns;
  const rows = records.map((record) => Object.fromEntries(withId.map((key) => [key, record[key]])));
  const available = unknown.length > 0 ? Object.keys(sample).slice(0, MAX_AVAILABLE_LISTED) : [];
  return { columns: withId, rows, unknown, available };
}

export function tableCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const text = /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatDate(value) : value;
    return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  }
  if (typeof value === "object") return JSON.stringify(value).replace(/\|/g, "\\|");
  return String(value);
}

/** The projected page as the same payload shape plus the fields it was cut to. */
export function projectPage<T>(page: PaginatedResult<T>, fields: string[]): PaginatedResult<T> & { fields: string[]; unknown_fields?: string[]; available_fields?: string[] } {
  const projection = projectItems(page.items, fields);
  return {
    ...page,
    items: projection.rows as unknown as T[],
    fields: projection.columns,
    ...(projection.unknown.length > 0 ? { unknown_fields: projection.unknown, available_fields: projection.available } : {}),
  };
}

/** Markdown table for a projected page, through the same size budget as every other list. */
export function renderProjectedPage(
  title: string,
  page: PaginatedResult<unknown> & { fields: string[]; unknown_fields?: string[]; available_fields?: string[] },
  footer: string[] = [],
  more?: string
): RenderedBlocks {
  const total = `${page.total}${page.total_is_lower_bound ? "+" : ""}`;
  const notes = [...footer];
  if (page.sorted_within_window) notes.unshift("_Sorted within the first matches only; add filters for a true ranking._");
  if (page.unknown_fields) {
    notes.push(`_Unknown fields: ${page.unknown_fields.join(", ")}. Valid fields include: ${(page.available_fields ?? []).join(", ")}._`);
  }
  const columns = page.fields;
  return {
    header: [
      `# ${title}`,
      "",
      `Found ${total} result(s), showing ${page.count}`,
      "",
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
    ],
    blocks: (page.items as Array<Record<string, unknown>>).map((row) => `| ${columns.map((column) => tableCell(row[column])).join(" | ")} |`),
    separator: "\n",
    footer: notes,
    ...(more ? { more } : {}),
    offset: page.offset,
  };
}

import { getConfig } from "../config.js";
import { CHARACTER_LIMIT } from "../constants.js";

const TRUNCATION_NOTE =
  `\n\n... [truncated: response exceeded ${CHARACTER_LIMIT} characters. ` +
  `Narrow your query with filters, or use 'limit'/'offset' to page through results.]`;

export function truncate(text: string): string {
  return text.length <= CHARACTER_LIMIT ? text : text.slice(0, CHARACTER_LIMIT) + TRUNCATION_NOTE;
}

/** Compact (not pretty-printed) JSON: same information, materially fewer characters. */
export function toCompactJson(value: unknown): string {
  return truncate(JSON.stringify(value));
}

export function formatDate(value: unknown): string {
  if (!value || typeof value !== "string") return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function nameWithId(name: string | undefined | null, id: string | number | undefined | null): string {
  if (!name && (id === undefined || id === null)) return "N/A";
  if (!name) return `(${id})`;
  if (id === undefined || id === null) return name;
  return `${name} (${id})`;
}

/** Renders the `- **Name** (ID: 3)` list shared by every reference-data tool. */
export function renderNamedList(
  title: string,
  items: Array<{ ID: number; Name: string; IsActive?: boolean }>
): string {
  const lines = [`# ${title}`, ""];
  for (const item of items) {
    lines.push(`- **${item.Name}** (ID: ${item.ID})${item.IsActive === false ? " _[inactive]_" : ""}`);
  }
  return lines.join("\n");
}

/** Renders a feed (comments and history), shared by tickets, assets, CIs, and projects. */
export function renderFeed(
  heading: string,
  entries: Array<{ CreatedByName?: string; CreatedDate?: string; Body?: string }>
): string {
  const lines = [`# ${heading}`, ""];
  for (const entry of entries) {
    lines.push(`### ${entry.CreatedByName ?? "Unknown"} — ${formatDate(entry.CreatedDate)}`);
    lines.push(entry.Body ?? "(no content)");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * TDNext deep link for a ticket. The API's own `Uri` field is a relative API
 * path (`api/671/tickets/123`), not something a person can open, so the browser
 * URL is constructed from the configured base.
 */
export function ticketUrl(appId: number, ticketId: number): string {
  return `${getConfig().webBaseUrl}/Apps/${appId}/Tickets/TicketDet.aspx?TicketID=${ticketId}`;
}

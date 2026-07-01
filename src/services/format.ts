import { CHARACTER_LIMIT } from "../constants.js";

/**
 * Serialize an object to JSON and truncate defensively if it would blow past
 * the character budget for a single tool response.
 */
export function toJsonText(output: unknown): string {
  const text = JSON.stringify(output, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n... [truncated: response exceeded ${CHARACTER_LIMIT} characters. Narrow your query with filters, or use 'limit'/'offset' to page through results.]`
  );
}

export function truncateMarkdown(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n... [truncated: response exceeded ${CHARACTER_LIMIT} characters. Narrow your query with filters, or use 'limit'/'offset' to page through results.]`
  );
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

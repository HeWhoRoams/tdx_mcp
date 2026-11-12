import { formatDate } from "./format.js";
import { htmlToText, present } from "./text.js";

/** Fields that are rendered elsewhere or are noise in a detail view. */
const ALWAYS_OMIT = new Set(["Uri", "Attributes", "Description", "Notify", "Body", "Comments"]);

const MAX_OTHER_FIELDS = 60;
const MAX_FIELD_CHARS = 300;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const ZERO_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

interface AttributeLike {
  ID?: number;
  Name?: string;
  Value?: unknown;
  ValueText?: unknown;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (!present(value) || ZERO_GUID.test(value)) return undefined;
    const text = ISO_DATE.test(value) ? formatDate(value) : htmlToText(value);
    return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
  }
  if (typeof value === "number") return value === 0 ? undefined : String(value);
  if (typeof value === "boolean") return value ? "yes" : undefined;
  return undefined;
}

/**
 * Renders a full record: the headline lines the caller built, the whole description, every custom
 * attribute, then the remaining populated fields, so nothing the API returned is invisible in
 * markdown. Search results use the short renderers instead.
 */
export function renderRecordDetail(headline: string, record: Record<string, unknown>, options: { omit?: readonly string[] } = {}): string {
  const omit = new Set([...ALWAYS_OMIT, ...(options.omit ?? [])]);
  const sections = [headline];

  if (present(record.Description)) {
    sections.push(`### Description\n${htmlToText(String(record.Description))}`);
  }

  const attributes = Array.isArray(record.Attributes) ? (record.Attributes as AttributeLike[]) : [];
  const attributeLines = attributes
    .map((attribute) => {
      const value = present(attribute.ValueText) ? attribute.ValueText : attribute.Value;
      if (!present(value)) return undefined;
      const id = attribute.ID !== undefined ? ` (ID ${attribute.ID})` : "";
      return `- ${attribute.Name ?? "Attribute"}${id}: ${htmlToText(String(value))}`;
    })
    .filter((line): line is string => line !== undefined);
  if (attributeLines.length > 0) sections.push(`### Custom attributes\n${attributeLines.join("\n")}`);

  const other = Object.keys(record)
    .filter((key) => !omit.has(key))
    .sort()
    .map((key) => [key, scalarText(record[key])] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .slice(0, MAX_OTHER_FIELDS)
    .map(([key, text]) => `- ${key}: ${text}`);
  if (other.length > 0) sections.push(`### Other fields\n${other.join("\n")}`);

  return sections.join("\n\n");
}

/**
 * Text helpers for turning TeamDynamix payloads into something a model and a person can read.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  copy: "©",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Converts the HTML TeamDynamix stores in descriptions and feed bodies to plain text: block tags
 * become line breaks, list items become "- ", links keep their address, other tags are dropped,
 * and entities are decoded. Text without markup passes through unchanged.
 */
export function htmlToText(html: string): string {
  if (!/[<&]/.test(html)) return html.trim();
  let text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const inner = label.replace(/<[^>]*>/g, "").trim();
      return inner === "" || inner === href ? href : `${inner} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True for a value worth showing: not undefined, null or an empty/whitespace string. */
export function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/** `value` as display text, or `fallback` when it is absent. Unlike `??`, an empty string counts as absent. */
export function orElse(value: unknown, fallback: string): string {
  return present(value) ? String(value) : fallback;
}

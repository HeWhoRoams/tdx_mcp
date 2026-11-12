import { CHARACTER_LIMIT } from "../constants.js";

/**
 * Size budgeting for tool responses. A response over the limit is cut at a record boundary and says
 * where to continue, instead of being sliced mid-record with a note that cannot say where.
 */

export interface RenderedBlocks {
  header: string[];
  /** One entry per record. Whole blocks are kept or dropped, never split (except one oversize record). */
  blocks: string[];
  /** Joins blocks: "\n" for one-line records, "\n\n" (the default) for multi-line records. */
  separator?: string;
  /** Always-shown trailing lines such as notes. */
  footer?: string[];
  /** The "more results" line. Replaced by a continuation note when blocks were dropped for size. */
  more?: string;
  /** Offset of the first block in the full result, so a size cut can say where to continue. */
  offset?: number;
}

/** Room kept for the continuation note. */
const NOTE_RESERVE = 400;

export function isBlocks(value: unknown): value is RenderedBlocks {
  return typeof value === "object" && value !== null && Array.isArray((value as RenderedBlocks).blocks);
}

/** Joins rendered blocks under `limit`, stopping at a block boundary. */
export function fitBlocks(rendered: RenderedBlocks, limit: number = CHARACTER_LIMIT): string {
  const separator = rendered.separator ?? "\n\n";
  const head = rendered.header.join("\n");
  const footer = rendered.footer ?? [];
  const assemble = (blocks: string[], tail: string[]): string =>
    `${head}\n${blocks.join(separator)}${tail.length > 0 ? `\n\n${tail.join("\n")}` : ""}`;

  const full = assemble(rendered.blocks, rendered.more ? [...footer, rendered.more] : footer);
  if (full.length <= limit) return full;

  const budget = Math.max(200, limit - head.length - footer.join("\n").length - NOTE_RESERVE);
  const kept: string[] = [];
  let used = 0;
  for (const block of rendered.blocks) {
    const cost = block.length + separator.length;
    if (used + cost > budget) break;
    kept.push(block);
    used += cost;
  }
  let cutNote = "";
  if (kept.length === 0 && rendered.blocks.length > 0) {
    // One record alone is over budget: keep its start and say so.
    kept.push(rendered.blocks[0]!.slice(0, budget));
    cutNote = ` The first record was cut at ${budget} characters; fetch it with the matching get tool.`;
  }
  const shown = kept.length;
  const total = rendered.blocks.length;
  const where =
    rendered.offset !== undefined && shown < total
      ? ` Continue with offset=${rendered.offset + shown}.`
      : shown < total
        ? " Narrow the request to see the rest."
        : "";
  const note = `_Showing ${shown} of ${total} on this page: response size limit reached.${where}${cutNote}_`;
  return assemble(kept, [...footer, note]);
}

export interface FittedPayload {
  /** The object to send as structuredContent, or undefined when it cannot be sent whole. */
  data: object | undefined;
  /** What goes in the text block. */
  text: string;
  truncated: boolean;
}

/**
 * Fits a JSON payload under `limit`. A list payload (`items`) loses whole items from the end and its
 * paging fields are rewritten so the next page starts at the first dropped item. Any other payload
 * over the limit is cut as text and not sent as structured content.
 */
export function fitPayload(data: object, limit: number = CHARACTER_LIMIT): FittedPayload {
  const whole = JSON.stringify(data);
  if (whole.length <= limit) return { data, text: whole, truncated: false };

  const record = data as Record<string, unknown>;
  const items = record.items;
  if (Array.isArray(items) && items.length > 0) {
    const offset = typeof record.offset === "number" ? record.offset : undefined;
    const withCount = (count: number): Record<string, unknown> => {
      const { next_cursor: _stale, ...rest } = record;
      return {
        ...rest,
        items: items.slice(0, count),
        count,
        has_more: true,
        ...(offset !== undefined ? { next_offset: offset + count } : {}),
        truncated: { shown: count, on_page: items.length, ...(offset !== undefined ? { next_offset: offset + count } : {}) },
      };
    };
    let low = 1;
    let high = items.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify(withCount(mid)).length <= limit) low = mid;
      else high = mid - 1;
    }
    const fitted = withCount(low);
    const text = JSON.stringify(fitted);
    if (text.length <= limit) return { data: fitted, text, truncated: true };
  }

  const note = `\n... [truncated: response exceeded ${limit} characters; this payload cannot be split. Request fewer fields or a narrower query.]`;
  return { data: undefined, text: whole.slice(0, limit) + note, truncated: true };
}

/** Renderer result for a child collection (feed, tasks, members, relationships). */
export function childBlocks(
  heading: string,
  blocks: string[],
  page: { has_more: boolean; next_offset?: number; offset: number },
  separator: "\n" | "\n\n" = "\n"
): RenderedBlocks {
  return {
    header: [`# ${heading}`, ""],
    blocks,
    separator,
    ...(page.has_more ? { more: `_More available. Use offset=${page.next_offset}._` } : {}),
    offset: page.offset,
  };
}

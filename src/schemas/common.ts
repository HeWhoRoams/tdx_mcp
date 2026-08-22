import { z } from "zod";
import { ResponseFormat } from "../types.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

export const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable text or 'json' for machine-readable structured data.");

export const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum number of results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`);

export const OffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for pagination (default 0). Ignored when 'cursor' is supplied.");

export const CursorSchema = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous response's next_cursor. Takes precedence over 'offset'.");

export const AppIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "The TeamDynamix application ID this request operates in (e.g. the Ticketing app or an Assets/CIs app). " +
      "Optional when the server has a default application configured; otherwise use teamdynamix_list_applications to discover IDs."
  );

export const VerbositySchema = z
  .enum(["compact", "full"])
  .default("full")
  .describe("'compact' returns one line per record, fitting far more results in a single response.");

export const CountOnlySchema = z
  .boolean()
  .default(false)
  .describe("Return only how many records matched, with no result bodies. Use this for 'how many' questions.");

export const SortOrderSchema = z
  .enum(["asc", "desc"])
  .default("desc")
  .describe("Sort direction; defaults to descending.");

/** Pagination + format arguments shared by every search tool. */
export const PagingShape = {
  limit: LimitSchema,
  offset: OffsetSchema,
  cursor: CursorSchema,
  count_only: CountOnlySchema,
  sort_order: SortOrderSchema,
  response_format: ResponseFormatSchema,
};

/** Pagination for child collections (feeds, tasks, relationships, members). */
export const ChildPagingShape = {
  limit: LimitSchema,
  offset: OffsetSchema,
  response_format: ResponseFormatSchema,
};

export function sortBySchema(values: readonly [string, ...string[]]): z.ZodOptional<z.ZodEnum<[string, ...string[]]>> {
  return z
    .enum(values as [string, ...string[]])
    .optional()
    .describe(`Sort the retrieved window (up to 251 records) by this field: ${values.join(", ")}.`);
}

export const PersonRefSchema = (role: string) =>
  z.string().describe(`${role}. Accepts a person UID or an email address, which the server resolves automatically.`);

export const AttributesSchema = z
  .array(z.object({ ID: z.number().int(), Value: z.string() }))
  .optional()
  .describe(
    "Custom attribute values as { ID, Value } pairs. Discover IDs and valid choices with " +
      "teamdynamix_list_custom_attributes (component_id=9 for tickets, 63 for assets/CIs)."
  );

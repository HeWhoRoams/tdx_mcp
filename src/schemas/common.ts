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
  .describe("Number of results to skip, for pagination (default 0).");

export const AppIdSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "The TeamDynamix application ID this request operates in (e.g. the Ticketing app or an Assets/CIs app). " +
      "Use teamdynamix_list_applications to discover valid application IDs and their names."
  );

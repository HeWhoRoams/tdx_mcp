import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfig } from "../config.js";
import { invalidateDomain } from "../services/cache.js";
import { handleApiError } from "../services/client.js";
import { truncate } from "../services/format.js";
import { increment, logger } from "../services/logger.js";
import { ResponseFormat } from "../types.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Argument problems we can detect before calling TeamDynamix. */
export class ToolInputError extends Error {}

/** Structured results must be JSON objects, so array payloads are wrapped as { items }. */
export type StructuredData = object;

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape, Data extends StructuredData = StructuredData> {
  name: string;
  title: string;
  /** Keep to three lines or fewer: argument documentation belongs in schema .describe(). */
  description: string;
  input: z.ZodObject<Shape>;
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<Data>;
  /** Human-readable rendering used for the default markdown response format. */
  render: (data: Data, args: z.infer<z.ZodObject<Shape>>) => string;
  /** When true, the tool short-circuits to `emptyMessage` instead of rendering. */
  isEmpty?: (data: Data, args: z.infer<z.ZodObject<Shape>>) => boolean;
  emptyMessage?: string;
  /** Domain whose cached searches this tool invalidates once it succeeds. */
  invalidates?: { domain: string; appIdFrom?: (args: z.infer<z.ZodObject<Shape>>) => number | undefined };
  /**
   * Extra recovery guidance appended to a rejected-request error, e.g. the valid
   * status IDs for the target application. Must read from cache only: this runs
   * on the failure path and may not add network calls.
   */
  errorHints?: (args: z.infer<z.ZodObject<Shape>>) => string | undefined;
}

// Definitions are collected into heterogeneous arrays, so registration works against an erased type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** Identity helper that preserves per-tool generic inference inside definition arrays. */
export function defineTool<Shape extends z.ZodRawShape, Data extends StructuredData>(
  definition: ToolDefinition<Shape, Data>
): AnyToolDefinition {
  return definition as AnyToolDefinition;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Response format policy, applied identically to every tool:
 *
 * - `markdown` (default): a single rendered text block.
 * - `json`: `structuredContent` plus a one-line pointer.
 *
 * The payload is never serialized twice. An `outputSchema` is deliberately not
 * declared: the SDK would then require `structuredContent` on markdown
 * responses too, reintroducing the duplication this policy exists to remove.
 */
function buildResult(definition: AnyToolDefinition, data: StructuredData, args: Record<string, unknown>) {
  if (definition.isEmpty?.(data, args)) {
    return textResult(definition.emptyMessage ?? "No results found.");
  }
  const format = (args.response_format as ResponseFormat) ?? ResponseFormat.MARKDOWN;
  if (format === ResponseFormat.JSON) {
    return {
      content: [{ type: "text" as const, text: summarize(data) }],
      structuredContent: data as Record<string, unknown>,
    };
  }
  return textResult(truncate(definition.render(data, args)));
}

function summarize(data: StructuredData): string {
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const total = typeof record.total === "number" ? record.total : record.items.length;
    return `Structured JSON result: ${record.items.length} of ${total} item(s) in structuredContent.`;
  }
  return "Structured JSON result in structuredContent.";
}

function registerTool(server: McpServer, definition: AnyToolDefinition): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.input.shape,
      annotations: definition.annotations,
    },
    async (args: Record<string, unknown>) => {
      const started = Date.now();
      increment("toolCalls");
      try {
        const data = await definition.handler(args);
        if (definition.invalidates) {
          invalidateDomain(definition.invalidates.appIdFrom?.(args), definition.invalidates.domain);
        }
        const result = buildResult(definition, data, args);
        logger.debug("tool call", { tool: definition.name, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        increment("toolErrors");
        logger.warn("tool call failed", {
          tool: definition.name,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        let message = error instanceof ToolInputError ? `Error: ${error.message}` : handleApiError(error);
        if (definition.errorHints && message.includes("(400)")) {
          const hint = definition.errorHints(args);
          if (hint) message += ` ${hint}`;
        }
        return { isError: true, ...textResult(message) };
      }
    }
  );
}

/**
 * Registers every definition, skipping write tools when the server is running
 * read-only. Filtering here means unregistered tools cannot be discovered or
 * invoked at all.
 */
export function registerTools(server: McpServer, definitions: AnyToolDefinition[]): number {
  const readOnly = getConfig().readOnly;
  let registered = 0;
  for (const definition of definitions) {
    if (readOnly && definition.annotations.readOnlyHint !== true) continue;
    registerTool(server, definition);
    registered += 1;
  }
  return registered;
}

/** Wraps list payloads for `structuredContent`, which must be a JSON object. */
export function items<T>(list: T[]): { items: T[] } {
  return { items: list };
}

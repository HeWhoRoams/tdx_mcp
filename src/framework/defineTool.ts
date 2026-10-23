import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfig } from "../config.js";
import { decideTool, type ToolDomain } from "../policy/index.js";
import { invalidateDomain } from "../services/cache.js";
import { handleApiError } from "../services/client.js";
import { truncate } from "../services/format.js";
import { increment, logger } from "../services/logger.js";
import { ResponseFormat } from "../types.js";
import { clientAnnotations, type ToolAnnotations } from "./annotations.js";

export type { Capability, ToolAnnotations } from "./annotations.js";

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
  /** Policy grouping. Applied in bulk by `withDomain` rather than per definition. */
  domain?: ToolDomain;
  /**
   * The tool GETs the record and writes the whole thing back because TeamDynamix
   * offers no PATCH here, so a concurrent change is silently lost. Deployments
   * can have the policy treat these as destructive.
   */
  readModifyWrite?: boolean;
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

/** Stamps a domain onto a whole tool file's exports so definitions stay free of boilerplate. */
export function withDomain(domain: ToolDomain, definitions: AnyToolDefinition[]): AnyToolDefinition[] {
  return definitions.map((definition) => ({ ...definition, domain }));
}

/** The facts the tool policy decides on. */
function subjectOf(definition: AnyToolDefinition) {
  return {
    name: definition.name,
    ...(definition.domain ? { domain: definition.domain } : {}),
    capability: definition.annotations.capability,
    ...(definition.readModifyWrite ? { readModifyWrite: true } : {}),
  };
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
      annotations: clientAnnotations(definition.annotations),
    },
    async (args: Record<string, unknown>) => {
      const started = Date.now();
      increment("toolCalls");
      try {
        // Re-checked here as well as at registration so a denied tool can never run.
        const decision = decideTool(getConfig().toolPolicy, subjectOf(definition));
        if (!decision.allowed) {
          throw new ToolInputError(
            `${definition.name} is disabled on this server by policy (${decision.reason}).`
          );
        }
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
 * Registers every definition the tool policy permits. Filtering here means a
 * denied tool cannot be discovered or invoked at all.
 */
export function registerTools(server: McpServer, definitions: AnyToolDefinition[]): number {
  const policy = getConfig().toolPolicy;
  const denied: string[] = [];
  let registered = 0;
  for (const definition of definitions) {
    const decision = decideTool(policy, subjectOf(definition));
    if (!decision.allowed) {
      denied.push(`${definition.name} (${decision.reason})`);
      continue;
    }
    registerTool(server, definition);
    registered += 1;
  }
  if (denied.length > 0) logger.debug("tools denied by policy", { denied });
  return registered;
}

/**
 * A misspelled name silently withholds access rather than failing loudly, so
 * report it. Only meaningful against the complete catalog.
 */
export function findUnknownPolicyNames(definitions: AnyToolDefinition[]): string[] {
  const policy = getConfig().toolPolicy;
  const known = new Set(definitions.map((definition) => definition.name));
  const named = Object.entries(policy.tools)
    .filter(([, rule]) => rule !== "inherit")
    .map(([name]) => name);
  const referenced = [...named, ...policy.denyTools, ...(policy.allowTools ?? [])];
  return [...new Set(referenced)].filter((name) => !known.has(name));
}

/** Wraps list payloads for `structuredContent`, which must be a JSON object. */
export function items<T>(list: T[]): { items: T[] } {
  return { items: list };
}

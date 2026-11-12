import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOMAIN_REQUIRED_APP, type AppKey } from "../policy/availability.js";
import { decideTool, type ToolDomain, type ToolPolicy } from "../policy/index.js";
import { invalidateDomain } from "../services/cache.js";
import { handleApiError } from "../services/client.js";
import { ToolInputError } from "../services/errors.js";
import { normalizeArgs } from "../services/names.js";
import type { ReferenceSpec } from "../services/reference-kinds.js";
import { fitBlocks, fitPayload, isBlocks, type RenderedBlocks } from "../services/budget.js";
import { truncate } from "../services/format.js";
import { getConfig } from "../config.js";
import { increment, logger } from "../services/logger.js";
import { projectPage, renderProjectedPage } from "../services/fields.js";
import { moreLine, windowHint } from "../services/search.js";
import { runWithRequestContext, type RequestContext } from "../services/request-context.js";
import { ResponseFormat, type PaginatedResult } from "../types.js";
import { clientAnnotations, type ToolAnnotations } from "./annotations.js";

export type { Capability, ToolAnnotations } from "./annotations.js";

export { ToolInputError };

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
   * The application kind this tool needs. `null` means it works without one. When omitted,
   * `withDomain` applies the domain default (tickets need a Ticketing app, assets and CMDB an Asset/CI
   * app, projects and issues a Projects app). Reference tools set it per definition.
   */
  requiresApp?: AppKey | null;
  /**
   * The sign-in setup this tool only makes sense under. Like `requiresApp` this is availability,
   * not authorization: it hides a tool that could not work here, and policy stays the boundary.
   */
  requiresAuth?: { method: "sso"; deployment: "local" | "external" };
  /**
   * Reference lookups: the domains this lookup serves, so a `TDX_TOOLSETS` that includes them keeps
   * it. Unset on a reference tool means a generic lookup that is always available.
   */
  serves?: ToolDomain[];
  /**
   * The tool GETs the record and writes the whole thing back because TeamDynamix
   * offers no PATCH here, so a concurrent change is silently lost. Deployments
   * can have the policy treat these as destructive.
   */
  readModifyWrite?: boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<Data>;
  /** Human-readable rendering used for the default markdown response format. */
  render: (data: Data, args: z.infer<z.ZodObject<Shape>>) => string | RenderedBlocks;
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
  /**
   * Arguments that accept a reference value by name as well as by ID, and the list a name is looked up
   * in. Names are replaced with IDs before the handler runs, so handlers only ever see IDs.
   */
  resolve?: { reference?: Record<string, ReferenceSpec> };
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
  return definitions.map((definition) => ({
    ...definition,
    domain,
    requiresApp: definition.requiresApp !== undefined ? definition.requiresApp : (DOMAIN_REQUIRED_APP[domain] ?? null),
  }));
}

/** The facts the tool policy decides on. */
export function policySubjectOf(definition: AnyToolDefinition) {
  return {
    name: definition.name,
    ...(definition.domain ? { domain: definition.domain } : {}),
    capability: definition.annotations.capability,
    ...(definition.readModifyWrite ? { readModifyWrite: true } : {}),
    ...(definition.serves ? { serves: definition.serves } : {}),
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Response format policy, applied identically to every tool:
 *
 * - `markdown` (default): a single rendered text block, cut at a record boundary when over the limit.
 * - `json`: the payload as compact JSON in the text block, so a client that never shows
 *   `structuredContent` to the model still delivers it, plus the same object as `structuredContent`
 *   (omit it with TDX_STRUCTURED_CONTENT=text for clients that would show both).
 *
 * Both are kept under CHARACTER_LIMIT. An `outputSchema` is deliberately not declared: the SDK would
 * then require `structuredContent` on markdown responses too.
 */
function buildResult(definition: AnyToolDefinition, data: StructuredData, args: Record<string, unknown>) {
  if (definition.isEmpty?.(data, args)) {
    return textResult(definition.emptyMessage ?? "No results found.");
  }
  const format = (args.response_format as ResponseFormat) ?? ResponseFormat.MARKDOWN;
  const fields = Array.isArray(args.fields) ? (args.fields as string[]) : undefined;
  const isList = Array.isArray((data as { items?: unknown }).items);
  if (fields && fields.length > 0 && isList && args.count_only !== true) {
    const projected = projectPage(data as unknown as PaginatedResult<unknown>, fields);
    if (format === ResponseFormat.JSON) {
      const fitted = fitPayload(projected);
      const withStructured = fitted.data !== undefined && getConfig().structuredContent === "both";
      return {
        content: [{ type: "text" as const, text: fitted.text }],
        ...(withStructured ? { structuredContent: fitted.data as Record<string, unknown> } : {}),
      };
    }
    const hint = windowHint(projected);
    return textResult(
      fitBlocks(renderProjectedPage(definition.title, projected, hint ? [`_${hint}_`] : [], moreLine(projected)))
    );
  }
  if (format === ResponseFormat.JSON) {
    const fitted = fitPayload(data);
    const withStructured = fitted.data !== undefined && getConfig().structuredContent === "both";
    return {
      content: [{ type: "text" as const, text: fitted.text }],
      ...(withStructured ? { structuredContent: fitted.data as Record<string, unknown> } : {}),
    };
  }
  const rendered = definition.render(data, args);
  return textResult(isBlocks(rendered) ? fitBlocks(rendered) : truncate(rendered));
}

/** The parts of the SDK's per-request extra that a tool call uses. */
export interface ToolExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * Cancellation and progress for one tool call. Progress is sent only when the caller supplied a
 * progress token; sending one without it would be a protocol violation.
 */
export function requestContextOf(extra: ToolExtra | undefined): RequestContext {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  let step = 0;
  return {
    ...(extra?.signal ? { signal: extra.signal } : {}),
    ...(token !== undefined && send
      ? {
          progress: (message: string) => {
            step += 1;
            void send({ method: "notifications/progress", params: { progressToken: token, progress: step, message } }).catch(
              () => undefined
            );
          },
        }
      : {}),
  };
}

/** Registers one tool with the SDK. The handler re-checks `policy`, so a denied tool can never run. */
export function registerTool(server: McpServer, definition: AnyToolDefinition, policy: ToolPolicy): RegisteredTool {
  return server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.input.shape,
      annotations: clientAnnotations(definition.annotations),
    },
    async (rawArgs: Record<string, unknown>, extra: ToolExtra) => {
      let args = rawArgs;
      const started = Date.now();
      increment("toolCalls");
      try {
        // Re-checked here as well as at registration so a denied tool can never run.
        const decision = decideTool(policy, policySubjectOf(definition));
        if (!decision.allowed) {
          throw new ToolInputError(
            `${definition.name} is disabled on this server by policy (${decision.reason}).`
          );
        }
        const context = requestContextOf(extra);
        const data = await runWithRequestContext(context, async () => {
          args = await normalizeArgs(definition, rawArgs);
          return definition.handler(args);
        });
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

/** Wraps list payloads for `structuredContent`, which must be a JSON object. */
export function items<T>(list: T[]): { items: T[] } {
  return { items: list };
}

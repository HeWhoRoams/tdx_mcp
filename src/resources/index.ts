import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../config.js";
import { appKeyOf } from "../policy/availability.js";
import { tdRequest } from "../services/client.js";
import { toCompactJson } from "../services/format.js";
import { loadReference, TICKET_KINDS } from "../tools/reference.js";
import type { TdApp } from "../types.js";

/**
 * Reference data is also exposed as resources so hosts can pin it to context
 * instead of spending a tool round trip to look up IDs.
 */
export function registerResources(server: McpServer): void {
  const ttlMs = getConfig().cache.referenceTtlMs;

  server.registerResource(
    "applications",
    "tdx://applications",
    {
      title: "TeamDynamix Applications",
      description: "All platform applications with the IDs required by app-scoped tools.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await tdRequest<TdApp[]>("/applications", { cacheKey: "/applications", cacheTtlMs: ttlMs });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: toCompactJson(data) }] };
    }
  );

  server.registerResource(
    "ticket-reference",
    new ResourceTemplate("tdx://{appId}/ticket-reference", {
      list: async () => {
        const apps = await tdRequest<TdApp[]>("/applications", { cacheKey: "/applications", cacheTtlMs: ttlMs });
        return {
          resources: apps
            .filter((app) => appKeyOf(app) === "tickets" && app.Active !== false)
            .map((app) => ({
              uri: `tdx://${app.AppID}/ticket-reference`,
              name: `${app.Name} ticket reference`,
              mimeType: "application/json",
            })),
        };
      },
    }),
    {
      title: "TeamDynamix Ticket Reference Data",
      description: "Ticket types, statuses, and priorities for one application, in a single document.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawAppId = String(variables.appId);
      if (!/^[1-9]\d*$/.test(rawAppId)) {
        throw new McpError(ErrorCode.InvalidParams, "appId must be a positive integer");
      }
      const appId = Number(rawAppId);
      const { reference, errors } = await loadReference(appId, TICKET_KINDS, ["types", "statuses", "priorities"]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: toCompactJson({
              appId,
              types: reference.types ?? [],
              statuses: reference.statuses ?? [],
              priorities: reference.priorities ?? [],
              ...(Object.keys(errors).length > 0 ? { errors } : {}),
            }),
          },
        ],
      };
    }
  );
}

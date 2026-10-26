import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { tdRequest } from "../services/client.js";
import { toCompactJson } from "../services/format.js";
import type { TdApp } from "../types.js";

interface NamedRef {
  ID: number;
  Name: string;
}

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
            .filter((app) => app.Type === "Ticketing" && app.Active !== false)
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
      const appId = Number(variables.appId);
      const [types, statuses, priorities] = await Promise.all([
        tdRequest<NamedRef[]>(`/${appId}/tickets/types`, { cacheKey: `/${appId}/tickets/types`, cacheTtlMs: ttlMs }),
        tdRequest<NamedRef[]>(`/${appId}/tickets/statuses`, { cacheKey: `/${appId}/tickets/statuses`, cacheTtlMs: ttlMs }),
        tdRequest<NamedRef[]>(`/${appId}/tickets/priorities`, { cacheKey: `/${appId}/tickets/priorities`, cacheTtlMs: ttlMs }),
      ]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: toCompactJson({ appId, types, statuses, priorities }),
          },
        ],
      };
    }
  );
}

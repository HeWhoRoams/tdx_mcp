import type { McpServer, RegisteredPrompt, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, type AnyToolDefinition } from "../framework/defineTool.js";
import type { ToolPolicy } from "../policy/index.js";
import { logger } from "../services/logger.js";
import type { Catalog } from "./catalog.js";
import type { Surface } from "./resolve.js";

/** The only part of the surface that touches the MCP SDK. */

export interface MountedSurface {
  surface: Surface;
  /**
   * Hides what `next` no longer registers, for a server that started before availability was known.
   * Only ever hides: nothing is re-enabled or added. Idempotent. Sends at most one
   * `tools/list_changed` and one `prompts/list_changed`, because the SDK would otherwise announce
   * every change separately. Returns the names it hid.
   */
  apply(next: Surface): { hiddenTools: string[]; hiddenPrompts: string[] };
}

export function mountSurface(server: McpServer, catalog: Catalog, surface: Surface, policy: ToolPolicy): MountedSurface {
  const toolHandles = new Map<string, RegisteredTool | undefined>();
  const promptHandles = new Map<string, RegisteredPrompt | undefined>();
  const toolsByName = new Map<string, AnyToolDefinition>(catalog.tools.map((definition) => [definition.name, definition]));

  for (const name of surface.registered("tool")) {
    toolHandles.set(name, registerTool(server, toolsByName.get(name)!, policy));
  }
  for (const prompt of catalog.prompts) {
    if (surface.stateOf("prompt", prompt.name) !== "registered") continue;
    const handle = server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.args },
      (args: Record<string, string>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text(args) } }],
      })
    );
    promptHandles.set(prompt.name, handle);
  }

  const denied = surface.entries.filter((entry) => entry.state === "denied");
  if (denied.length > 0) logger.debug("tools denied by policy", { denied: denied.map((entry) => `${entry.name} (${entry.reason})`) });
  const hidden = surface.entries.filter((entry) => entry.state === "hidden" && entry.kind === "tool");
  if (hidden.length > 0) logger.debug("tools hidden because their application is not available", { hidden: hidden.map((entry) => entry.name) });

  return {
    surface,
    apply(next) {
      const hiddenTools: string[] = [];
      for (const [name, handle] of toolHandles) {
        if (next.stateOf("tool", name) === "registered" || !handle || !handle.enabled) continue;
        handle.enabled = false;
        hiddenTools.push(name);
      }
      const hiddenPrompts: string[] = [];
      for (const [name, handle] of promptHandles) {
        if (next.stateOf("prompt", name) === "registered" || !handle || !handle.enabled) continue;
        handle.enabled = false;
        hiddenPrompts.push(name);
      }
      if (hiddenTools.length > 0) server.sendToolListChanged();
      if (hiddenPrompts.length > 0) server.sendPromptListChanged();
      return { hiddenTools, hiddenPrompts };
    },
  };
}

import type { AnyToolDefinition } from "../framework/defineTool.js";
import type { PromptDefinition } from "../framework/definePrompt.js";
import { allPrompts } from "../prompts/index.js";
import { allTools } from "../tools/index.js";

/** Everything the server ships, before any policy or availability is applied. */
export interface Catalog {
  tools: AnyToolDefinition[];
  prompts: PromptDefinition[];
}

export const catalog: Catalog = { tools: allTools, prompts: allPrompts };

import type { z } from "zod";

/**
 * A prompt template as data. It composes tools, so it is only offered when every tool it names in
 * `uses` is part of the tool surface; the surface module decides that, not the prompt.
 */
export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  /** Argument schema, as the SDK's `argsSchema`. */
  args: z.ZodRawShape;
  /** Tool names the prompt's instructions rely on. A prompt is hidden when any is not registered. */
  uses: string[];
  /** The user message the prompt expands to. */
  text: (args: Record<string, string>) => string;
}

export function definePrompt(definition: PromptDefinition): PromptDefinition {
  return definition;
}

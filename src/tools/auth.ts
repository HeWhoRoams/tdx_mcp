import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown } from "../services/format.js";
import { ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdPerson } from "../types.js";

const GetCurrentUserInputSchema = z.object({ response_format: ResponseFormatSchema }).strict();

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_get_current_user",
    {
      title: "Get Current TeamDynamix User",
      description: `Gets the identity of the currently authenticated TeamDynamix account (the one configured via environment variables). Useful for confirming the credentials work and seeing what permissions/applications are available.

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The current user's profile.

Error Handling:
  - Returns "Error: Not authenticated" if credentials are missing or invalid`,
      inputSchema: GetCurrentUserInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      try {
        const user = await tdRequest<TdPerson>(`/auth/getuser`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`## ${user.FullName} (${user.UID})\n- **Email**: ${user.PrimaryEmail ?? "N/A"}`)
            : toJsonText(user);
        return { content: [{ type: "text" as const, text }], structuredContent: user as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

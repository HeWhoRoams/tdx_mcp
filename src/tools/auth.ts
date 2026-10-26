import { z } from "zod";
import { READ } from "../framework/annotations.js";
import { defineTool, type AnyToolDefinition } from "../framework/defineTool.js";
import { ResponseFormatSchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import type { TdPerson } from "../types.js";

const GetCurrentUserInput = z.object({ response_format: ResponseFormatSchema }).strict();

export const authTools: AnyToolDefinition[] = [
  defineTool({
    name: "teamdynamix_get_current_user",
    title: "Get Current TeamDynamix User",
    description:
      "Returns the identity of the account this server authenticates as.\nUse it to confirm credentials and available permissions.",
    input: GetCurrentUserInput,
    annotations: READ,
    handler: () => tdRequest<TdPerson>("/auth/getuser"),
    render: (user) => `## ${user.FullName} (${user.UID})\n- **Email**: ${user.PrimaryEmail ?? "N/A"}`,
  }),
];

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tdRequest, handleApiError } from "../services/client.js";
import { toJsonText, truncateMarkdown } from "../services/format.js";
import { LimitSchema, OffsetSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ResponseFormat, TdGroup, TdPerson, paginate } from "../types.js";

const LookupPeopleInputSchema = z
  .object({
    search_text: z.string().min(1).max(200).describe("Text to search against name/email/username."),
    max_results: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50, default 10)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const SearchPeopleInputSchema = z
  .object({
    search_text: z.string().max(200).optional().describe("LIKE-based filter against name/email/username."),
    is_active: z.boolean().optional().describe("Filter to active or inactive accounts."),
    is_employee: z.boolean().optional().describe("Filter to employees only."),
    account_ids: z.array(z.number().int()).optional().describe("Filter by Account/Department ID."),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetPersonInputSchema = z
  .object({
    uid: z.string().min(1).describe("The person's UID (GUID)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const SearchGroupsInputSchema = z
  .object({
    search_text: z.string().max(200).optional().describe("Free-text search against group name."),
    is_active: z.boolean().optional(),
    limit: LimitSchema,
    offset: OffsetSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetGroupInputSchema = z
  .object({
    group_id: z.number().int().positive().describe("The group ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetGroupMembersInputSchema = z
  .object({
    group_id: z.number().int().positive().describe("The group ID."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const GetPersonUidInputSchema = z
  .object({
    username: z.string().min(1).max(200).describe("The person's username (login name, not display name)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const ManageGroupMembersInputSchema = z
  .object({
    group_id: z.number().int().positive().describe("The group ID."),
    uids: z.array(z.string().min(1)).min(1).describe("Array of person UIDs to add or remove."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function formatPersonMarkdown(p: TdPerson): string {
  return [
    `## ${p.FullName} (${p.UID})`,
    `- **Email**: ${p.PrimaryEmail ?? "N/A"}`,
    `- **Active**: ${p.IsActive === undefined ? "N/A" : p.IsActive ? "Yes" : "No"}`,
  ].join("\n");
}

export function registerPeopleTools(server: McpServer): void {
  server.registerTool(
    "teamdynamix_lookup_people",
    {
      title: "Lookup TeamDynamix People",
      description: `Performs a fast, restricted lookup of TeamDynamix people by name/email/username. Returns limited fields (no full profile) — ideal for resolving a name to a UID before other calls.

Args:
  - search_text (string): The search text
  - max_results (number, default 10, max 50)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of matching people with minimal fields (UID, name, email).

Examples:
  - Use when: "Who is Jane Smith's UID?" -> search_text="Jane Smith"
  - Don't use when: You need full profile details (use teamdynamix_get_person with the UID instead)

Error Handling:
  - Returns "No people found matching..." if search is empty`,
      inputSchema: LookupPeopleInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ search_text, max_results, response_format }) => {
      try {
        const results = await tdRequest<TdPerson[]>(`/people/lookup`, "GET", undefined, {
          searchText: search_text,
          maxResults: max_results,
        });
        if (!results || results.length === 0) {
          return { content: [{ type: "text" as const, text: `No people found matching '${search_text}'.` }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# People matching '${search_text}'`, ""];
          for (const p of results) lines.push(`- **${p.FullName}** (${p.UID})${p.PrimaryEmail ? ` — ${p.PrimaryEmail}` : ""}`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(results);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: results } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_search_people",
    {
      title: "Search TeamDynamix People",
      description: `Search for users in the TeamDynamix people database with structured filters. Returns more fields than teamdynamix_lookup_people, but still not full profile detail.

Args:
  - search_text (string, optional): LIKE-based filter
  - is_active, is_employee (boolean, optional)
  - account_ids (number[], optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching people.

Error Handling:
  - Returns "No people found matching the given criteria" if search is empty`,
      inputSchema: SearchPeopleInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const fetchCount = Math.min(params.offset + params.limit, 1000);
        const body: Record<string, unknown> = { MaxResults: fetchCount };
        if (params.search_text) body.SearchText = params.search_text;
        if (params.is_active !== undefined) body.IsActive = params.is_active;
        if (params.is_employee !== undefined) body.IsEmployee = params.is_employee;
        if (params.account_ids) body.AccountIDs = params.account_ids;

        const results = await tdRequest<TdPerson[]>(`/people/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);
        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No people found matching the given criteria." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# People Search Results`, "", `Found ${page.total}, showing ${page.items.length}`, ""];
          for (const p of page.items) lines.push(formatPersonMarkdown(p), "");
          if (page.has_more) lines.push(`_More results available. Use offset=${page.next_offset} to continue._`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(page);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: page as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_person",
    {
      title: "Get TeamDynamix Person",
      description: `Gets full profile details for a single person, including custom attributes and permissions.

Args:
  - uid (string): The person's UID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Full person details.

Error Handling:
  - Returns "Error: Resource not found" if uid is invalid`,
      inputSchema: GetPersonInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ uid, response_format }) => {
      try {
        const person = await tdRequest<TdPerson>(`/people/${uid}`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(formatPersonMarkdown(person))
            : toJsonText(person);
        return { content: [{ type: "text" as const, text }], structuredContent: person as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_search_groups",
    {
      title: "Search TeamDynamix Groups",
      description: `Search for groups in the TeamDynamix people database.

Args:
  - search_text (string, optional)
  - is_active (boolean, optional)
  - limit (default 25), offset (default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Paginated list of matching groups.

Error Handling:
  - Returns "No groups found matching the given criteria" if search is empty`,
      inputSchema: SearchGroupsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.search_text) body.NameLike = params.search_text;
        if (params.is_active !== undefined) body.IsActive = params.is_active;

        const results = await tdRequest<TdGroup[]>(`/groups/search`, "POST", body);
        const page = paginate(results ?? [], params.limit, params.offset);
        if (page.items.length === 0) {
          return { content: [{ type: "text" as const, text: "No groups found matching the given criteria." }] };
        }
        let text: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Group Search Results`, "", `Found ${page.total}, showing ${page.items.length}`, ""];
          for (const g of page.items) lines.push(`- **${g.Name}** (#${g.ID})${g.Description ? ` — ${g.Description}` : ""}`);
          if (page.has_more) lines.push("", `_More results available. Use offset=${page.next_offset} to continue._`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(page);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: page as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_group",
    {
      title: "Get TeamDynamix Group",
      description: `Gets details on a single group.

Args:
  - group_id (number): The group ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Group details.

Error Handling:
  - Returns "Error: Resource not found" if group_id is invalid`,
      inputSchema: GetGroupInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, response_format }) => {
      try {
        const group = await tdRequest<TdGroup>(`/groups/${group_id}`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? truncateMarkdown(`## ${group.Name} (#${group.ID})\n- **Description**: ${group.Description ?? "N/A"}\n- **Active**: ${group.IsActive ? "Yes" : "No"}`)
            : toJsonText(group);
        return { content: [{ type: "text" as const, text }], structuredContent: group as unknown as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_group_members",
    {
      title: "Get TeamDynamix Group Members",
      description: `Gets the users belonging to a group.

Args:
  - group_id (number): The group ID
  - response_format ('markdown' | 'json', default 'markdown')

Returns: List of group members.

Error Handling:
  - Returns "Error: Resource not found" if group_id is invalid`,
      inputSchema: GetGroupMembersInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, response_format }) => {
      try {
        const members = await tdRequest<Array<Record<string, unknown>>>(`/groups/${group_id}/members`);
        if (!members || members.length === 0) {
          return { content: [{ type: "text" as const, text: "This group has no members." }] };
        }
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Members of Group #${group_id}`, ""];
          for (const m of members) lines.push(`- ${m.FullName ?? m.UID} (${m.UID})`);
          text = truncateMarkdown(lines.join("\n"));
        } else {
          text = toJsonText(members);
        }
        return { content: [{ type: "text" as const, text }], structuredContent: { items: members } as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_get_person_uid",
    {
      title: "Get TeamDynamix Person UID by Username",
      description: `Resolves a person's username (login name) to their GUID/UID. Use this when you know the exact username and need the UID for other API calls.

Args:
  - username (string): The person's login username (not display name)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: The person's UID string.

Examples:
  - Use when: You have a username like "jsmith" and need their UID for responsible_uid
  - Don't use when: You have a display name — use teamdynamix_lookup_people instead

Error Handling:
  - Returns "Error: Resource not found" if the username does not exist`,
      inputSchema: GetPersonUidInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ username, response_format }) => {
      try {
        const uid = await tdRequest<string>(`/people/getuid/${encodeURIComponent(username)}`);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `**${username}** → UID: \`${uid}\``
            : toJsonText({ username, uid });
        return { content: [{ type: "text" as const, text }], structuredContent: { username, uid } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_add_group_members",
    {
      title: "Add Members to TeamDynamix Group",
      description: `Adds one or more people to a TeamDynamix group.

Args:
  - group_id (number): The group ID
  - uids (string[]): Array of person UIDs to add
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation message.

Error Handling:
  - Returns "Error: Resource not found" if group_id is invalid`,
      inputSchema: ManageGroupMembersInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, uids, response_format }) => {
      try {
        const result = await tdRequest<unknown>(`/groups/${group_id}/members`, "POST", uids);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Added ${uids.length} member(s) to group #${group_id}.`
            : toJsonText(result ?? { added: uids.length, group_id });
        return { content: [{ type: "text" as const, text }], structuredContent: { added: uids.length, group_id } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "teamdynamix_remove_group_members",
    {
      title: "Remove Members from TeamDynamix Group",
      description: `Removes one or more people from a TeamDynamix group.

Args:
  - group_id (number): The group ID
  - uids (string[]): Array of person UIDs to remove
  - response_format ('markdown' | 'json', default 'markdown')

Returns: Confirmation message.

Error Handling:
  - Returns "Error: Resource not found" if group_id is invalid`,
      inputSchema: ManageGroupMembersInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, uids, response_format }) => {
      try {
        const result = await tdRequest<unknown>(`/groups/${group_id}/members`, "DELETE", uids);
        const text =
          response_format === ResponseFormat.MARKDOWN
            ? `Removed ${uids.length} member(s) from group #${group_id}.`
            : toJsonText(result ?? { removed: uids.length, group_id });
        return { content: [{ type: "text" as const, text }], structuredContent: { removed: uids.length, group_id } };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
      }
    }
  );
}

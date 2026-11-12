import { toolName } from "../constants.js";
import { z } from "zod";
import { getConfig } from "../config.js";
import { DESTROY, EDIT, READ } from "../framework/annotations.js";
import { defineTool, items, type AnyToolDefinition } from "../framework/defineTool.js";
import { ChildPagingShape, PagingShape, ResponseFormatSchema, sortBySchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import { resolvePersonUids } from "../services/context.js";
import { childBlocks } from "../services/budget.js";
import { renderRecordDetail } from "../services/record.js";
import { truncate } from "../services/format.js";
import { pageBlocks, renderCount, searchPage } from "../services/search.js";
import { paginate, type TdGroup, type TdPerson } from "../types.js";

const GroupIdSchema = z.number().int().positive().describe("The group ID.");

const PEOPLE_SORT = { name: "FullName", email: "PrimaryEmail" };
const GROUP_SORT = { name: "Name", id: "ID" };

const LookupInput = z
  .object({
    search_text: z.string().min(1).max(200).describe("Text to search against name/email/username."),
    max_results: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50, default 10)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const SearchPeopleInput = z
  .object({
    search_text: z.string().max(200).optional().describe("LIKE-based filter against name/email/username."),
    is_active: z.boolean().optional().describe("Filter to active or inactive accounts."),
    is_employee: z.boolean().optional().describe("Filter to employees only."),
    account_ids: z.array(z.number().int()).optional().describe("Filter by Account/Department ID."),
    sort_by: sortBySchema(["name", "email"]),
    ...PagingShape,
  })
  .strict();

const GetPersonInput = z.object({ uid: z.string().min(1).describe("The person's UID (GUID)."), response_format: ResponseFormatSchema }).strict();

const SearchGroupsInput = z
  .object({
    search_text: z.string().max(200).optional().describe("Free-text search against group name."),
    is_active: z.boolean().optional().describe("Filter to active or inactive groups."),
    sort_by: sortBySchema(["name", "id"]),
    ...PagingShape,
  })
  .strict();

const GetGroupInput = z.object({ group_id: GroupIdSchema, response_format: ResponseFormatSchema }).strict();

const GroupMembersInput = z.object({ group_id: GroupIdSchema, ...ChildPagingShape }).strict();

const GetPersonUidInput = z
  .object({
    username: z.string().min(1).max(200).describe("The person's login username, not their display name."),
    response_format: ResponseFormatSchema,
  })
  .strict();

const ManageMembersInput = z
  .object({
    group_id: GroupIdSchema,
    uids: z.array(z.string().min(1)).min(1).describe("People to add or remove. Accepts UIDs, email addresses, or 'me' (the signed-in user, SSO only)."),
    response_format: ResponseFormatSchema,
  })
  .strict();

function renderPerson(person: TdPerson): string {
  return [
    `## ${person.FullName} (${person.UID})`,
    `- **Email**: ${person.PrimaryEmail ?? "N/A"}`,
    `- **Active**: ${person.IsActive === undefined ? "N/A" : person.IsActive ? "Yes" : "No"}`,
  ].join("\n");
}

const GROUPS = { domain: "groups" };

export const peopleTools: AnyToolDefinition[] = [
  defineTool({
    name: toolName("lookup_people"),
    title: "Lookup TeamDynamix People",
    description:
      "Fast name/email/username lookup returning minimal fields.\n" +
      "Use this to resolve a person's name to the UID that other tools need.",
    input: LookupInput,
    annotations: READ,
    handler: async (args) =>
      items(
        await tdRequest<TdPerson[]>("/people/lookup", {
          params: { searchText: args.search_text, maxResults: args.max_results },
        })
      ),
    isEmpty: (data) => data.items.length === 0,
    emptyMessage: "No people found matching that search text.",
    render: (data, args) => {
      const lines = [`# People matching '${args.search_text}'`, ""];
      for (const person of data.items) {
        lines.push(`- **${person.FullName}** (${person.UID})${person.PrimaryEmail ? ` — ${person.PrimaryEmail}` : ""}`);
      }
      return truncate(lines.join("\n"));
    },
  }),

  defineTool({
    name: toolName("search_people"),
    title: "Search TeamDynamix People",
    description:
      "Searches people with structured filters (active, employee, account).\n" +
      "Returns more fields than tdx_lookup_people; use tdx_get_person for the full profile.",
    input: SearchPeopleInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.SearchText = args.search_text;
      if (args.is_active !== undefined) body.IsActive = args.is_active;
      if (args.is_employee !== undefined) body.IsEmployee = args.is_employee;
      if (args.account_ids) body.AccountIDs = args.account_ids;
      return searchPage<TdPerson>("/people/search", body, args, { sortFields: PEOPLE_SORT });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No people found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "person");
      return pageBlocks("People Search Results", "person", page, page.items.map((person) => renderPerson(person)));
    },
  }),

  defineTool({
    name: toolName("get_person"),
    title: "Get TeamDynamix Person",
    description: "Gets one person's full profile, including custom attributes and permissions.",
    input: GetPersonInput,
    annotations: READ,
    handler: (args) =>
      tdRequest<TdPerson>(`/people/${encodeURIComponent(args.uid)}`, {
        cacheKey: `/people/${encodeURIComponent(args.uid)}`,
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      }),
    render: (person) => renderRecordDetail(renderPerson(person), person, { omit: ["FullName", "UID", "PrimaryEmail", "IsActive"] }),
  }),

  defineTool({
    name: toolName("get_person_uid"),
    title: "Get TeamDynamix Person UID by Username",
    description:
      "Resolves an exact login username to the person's UID.\n" +
      "Use tdx_lookup_people instead when you only have a display name.",
    input: GetPersonUidInput,
    annotations: READ,
    handler: async (args) => {
      const uid = await tdRequest<string>(`/people/getuid/${encodeURIComponent(args.username)}`, {
        cacheKey: `/people/getuid/${args.username}`,
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      });
      return { username: args.username, uid };
    },
    render: (data) => `**${data.username}** → UID: \`${data.uid}\``,
  }),

  defineTool({
    name: toolName("search_groups"),
    title: "Search TeamDynamix Groups",
    description: "Searches groups by name and active state.",
    input: SearchGroupsInput,
    annotations: READ,
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.search_text) body.NameLike = args.search_text;
      if (args.is_active !== undefined) body.IsActive = args.is_active;
      return searchPage<TdGroup>("/groups/search", body, args, { sortFields: GROUP_SORT });
    },
    isEmpty: (page, args) => !args.count_only && page.items.length === 0,
    emptyMessage: "No groups found matching the given criteria.",
    render: (page, args) => {
      if (args.count_only) return renderCount(page, "group");
      return pageBlocks(
        "Group Search Results",
        "group",
        page,
        page.items.map((group) => `- **${group.Name}** (#${group.ID})${group.Description ? ` — ${group.Description}` : ""}`),
        "\n"
      );
    },
  }),

  defineTool({
    name: toolName("get_group"),
    title: "Get TeamDynamix Group",
    description: "Gets one group's details.",
    input: GetGroupInput,
    annotations: READ,
    handler: (args) =>
      tdRequest<TdGroup>(`/groups/${args.group_id}`, {
        cacheKey: `/groups/${args.group_id}`,
        cacheTtlMs: getConfig().cache.referenceTtlMs,
      }),
    render: (group) =>
      renderRecordDetail(
        `## ${group.Name} (#${group.ID})\n- **Active**: ${group.IsActive ? "Yes" : "No"}`,
        group,
        { omit: ["Name", "ID", "IsActive"] }
      ),
  }),

  defineTool({
    name: toolName("get_group_members"),
    title: "Get TeamDynamix Group Members",
    description: "Lists the people belonging to a group.\nPage large groups with limit/offset.",
    input: GroupMembersInput,
    annotations: READ,
    handler: async (args) => {
      const path = `/groups/${args.group_id}/members`;
      const members = await tdRequest<Array<Record<string, unknown>>>(path, {
        cacheKey: path,
        cacheTtlMs: getConfig().cache.recordTtlMs,
        cacheTier: "record",
      });
      return paginate(members ?? [], args.limit, args.offset);
    },
    isEmpty: (page) => page.items.length === 0,
    emptyMessage: "This group has no members.",
    render: (page, args) => {
      return childBlocks(
        `Members of Group #${args.group_id} (${page.count} of ${page.total})`,
        page.items.map((member) => `- ${member.FullName ?? member.UID} (${member.UID})`),
        page
      );
    },
  }),

  defineTool({
    name: toolName("add_group_members"),
    title: "Add Members to TeamDynamix Group",
    description: "Adds one or more people to a group.\nAccepts UIDs, email addresses, or 'me' (the signed-in user, SSO only).",
    input: ManageMembersInput,
    annotations: { ...EDIT, idempotentHint: true },
    invalidates: GROUPS,
    handler: async (args) => {
      const uids = await resolvePersonUids(args.uids);
      await tdRequest<unknown>(`/groups/${args.group_id}/members`, { method: "POST", data: uids });
      return { added: args.uids.length, group_id: args.group_id };
    },
    render: (data) => `Added ${data.added} member(s) to group #${data.group_id}.`,
  }),

  defineTool({
    name: toolName("remove_group_members"),
    title: "Remove Members from TeamDynamix Group",
    description: "Removes one or more people from a group.\nAccepts UIDs, email addresses, or 'me' (the signed-in user, SSO only).",
    input: ManageMembersInput,
    annotations: { ...DESTROY, idempotentHint: true },
    invalidates: GROUPS,
    handler: async (args) => {
      const uids = await resolvePersonUids(args.uids);
      await tdRequest<unknown>(`/groups/${args.group_id}/members`, { method: "DELETE", data: uids });
      return { removed: args.uids.length, group_id: args.group_id };
    },
    render: (data) => `Removed ${data.removed} member(s) from group #${data.group_id}.`,
  }),
];

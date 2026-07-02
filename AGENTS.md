# TeamDynamix MCP Server — Agent Instructions

An MCP server exposing the [TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) as 64 LLM-callable tools across nine areas: auth, tickets, assets, CMDB, projects, issues, people/groups, reference data, and reports.

> **Maintenance:** Update tool counts and area lists in the same PR that adds or removes a tool.

## Build & Run

```bash
npm run build        # tsc → dist/
npm run dev          # tsx watch (no build needed)
npm start            # stdio transport (default)
TRANSPORT=http npm start   # Streamable HTTP on PORT (default 3000)
npx @modelcontextprotocol/inspector node dist/index.js  # interactive testing
```

`npm run build` must pass before testing with a real MCP client. There are no automated tests — validate interactively via the inspector or a connected LLM client.

## Project Structure

```
src/
├── index.ts          # Entry point: transport selection + tool registration
├── types.ts          # Shared TS types (TdTicket, TdAsset, TdCi, etc.) + paginate()
├── constants.ts      # CHARACTER_LIMIT, pagination defaults, getApiBaseUrl()
├── schemas/
│   └── common.ts     # Reusable Zod schemas: AppIdSchema, LimitSchema, OffsetSchema, ResponseFormatSchema
├── services/
│   ├── client.ts     # TeamDynamixClient: JWT auth/refresh, tdRequest(), handleApiError(), 429/503 retry
│   └── format.ts     # toJsonText(), truncateMarkdown(), formatDate(), nameWithId()
└── tools/            # One file per domain — each exports a register*Tools(server) function
    ├── auth.ts
    ├── tickets.ts    # search, get, create, update, feed, tasks (get/create/update)
    ├── assets.ts     # search, get, create, update, feed
    ├── cmdb.ts       # search, get, create, update, feed, relationships (get/add/remove), link to ticket
    ├── projects.ts
    ├── issues.ts
    ├── people.ts     # lookup, search, get, get UID by username, groups (search/get/members/add/remove)
    ├── reference.ts  # applications, ticket types/statuses/priorities/sources/forms/impacts/urgencies,
    │                 # asset statuses, product models, vendors, locations, accounts,
    │                 # CI types, CI relationship types, custom attributes
    └── reports.ts    # list reports, get report data, list/run saved searches
```

## Adding a New Tool

1. Add the Zod input schema in the relevant `src/tools/*.ts` file (use `.strict()` and reuse `AppIdSchema`, `LimitSchema`, `OffsetSchema`, `ResponseFormatSchema` from `schemas/common.ts`).
2. Call `tdRequest()` (from `services/client.ts`) — never use `axios` directly.
3. Format output with `toJsonText()` or `truncateMarkdown()` from `services/format.ts`.
4. Return `{ content: [{ type: "text", text: ... }] }` from the tool handler.
5. Register the tool inside the existing `register*Tools(server)` function.
6. No change to `index.ts` needed unless adding a new domain file.

## Key Conventions

- **`app_id` is required on most tools.** It scopes the request to a specific TDX application (e.g., a particular ticketing or assets app). Always call `teamdynamix_list_applications` first to discover valid IDs.
- **Assets vs CIs**: Assets live at `/{appId}/assets/...`; Configuration Items live at `/{appId}/cmdb/...`. These are separate TDX namespaces with separate type/relationship systems. Use `teamdynamix_search_assets` for the Assets namespace and `teamdynamix_search_cis` for CMDB.
- **Reference data before create/update.** Valid `type_id`, `status_id`, `priority_id` values vary per org and per application. Use `teamdynamix_list_ticket_types`, `teamdynamix_list_ticket_statuses`, etc. before creating records.
- **`*_search` returns partial records; `*_get_*` returns full records.** TD's own API omits descriptions and custom attributes from search results. Use the get tool for full details.
- **Custom attributes**: Pass `custom_attributes: [{ ID: number, Value: string }]` to create/update tools for tickets, assets, and CIs. Call `teamdynamix_list_custom_attributes` (component_id=9 for tickets, 63 for assets/CIs) to discover attribute IDs and valid choice values.
- **`response_format`**: `markdown` (default, human-readable) or `json` (full raw API payload). Agents requesting structured data should pass `response_format: "json"`.
- **Pagination**: all list/search tools accept `limit` (max 100, default 25) and `offset`. Responses include `has_more` and `next_offset`.
- **Responses are capped at 25,000 characters** and truncated with a message instructing the agent to narrow the query or paginate.
- **Rate limits**: TD commonly enforces 30–60 calls/60 s per IP. The client auto-retries 429 and 503 responses with 2 s / 4 s backoff before surfacing the error.
- **Reports**: `teamdynamix_get_report` (with `with_data=true`) and `teamdynamix_run_saved_search` are the most powerful read operations for complex queries — prefer these over chaining many search calls.

## Authentication

Set `TEAMDYNAMIX_BASE_URL` plus one of:
- `TEAMDYNAMIX_USERNAME` + `TEAMDYNAMIX_PASSWORD` (user login)
- `TEAMDYNAMIX_BEID` + `TEAMDYNAMIX_WS_KEY` (admin service account — preferred for automation)

Override selection with `TEAMDYNAMIX_AUTH_METHOD=user|admin`. The server caches the JWT and auto-refreshes ~1 min before expiry (TD tokens last 24 h).

## Out of Scope

File/attachment uploads, bulk imports, time & expense, knowledge base, service catalog, and admin/config endpoints (creating ticket types, etc.) are not implemented. `src/services/client.ts` (`tdRequest`) is reusable if you need to add tools for these.

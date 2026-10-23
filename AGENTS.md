# TeamDynamix MCP Server — Agent Instructions

An MCP server exposing the [TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) as 64 LLM-callable tools across nine areas: auth, tickets, assets, CMDB, projects, issues, people/groups, reference data, and reports.

> **Maintenance:** Update tool counts and area lists in the same PR that adds or removes a tool.

## Build & Run

```bash
npm run build        # tsc → dist/
npm test             # vitest unit suite (no network)
npm run test:mcp     # protocol handshakes over stdio + authenticated HTTP
npm run test:all     # unit + script type-check + protocol test
npm run bench       # latency benchmark; accepts -- --app-id <ID>
npm run policy:sync # rewrite config/tool-policy.json from the current tool catalog
npm run dev         # tsx watch (no build needed)
npm start            # stdio transport (default)
npm run start:http   # Streamable HTTP on 127.0.0.1:3000
npx @modelcontextprotocol/inspector node dist/index.js  # interactive testing
```

`npm run build`, `npm test`, and `npm run test:mcp` must pass before testing with a real MCP client. The unit suite and protocol test never call TeamDynamix; validate live API behavior with `npm run smoke-test` or the inspector.

## Project Structure

```
src/
├── index.ts          # Transport selection, registration, /healthz, graceful shutdown
├── config.ts         # Single zod-validated env parse; nothing else reads process.env
├── types.ts          # Shared TS types + paginate() + cursor codec
├── constants.ts      # CHARACTER_LIMIT, pagination defaults, MAX_SEARCH_FETCH
├── framework/
│   ├── defineTool.ts # Tool contract: format policy, error mapping, truncation, invalidation, timing
│   └── annotations.ts# READ / CREATE / EDIT / DESTROY capability presets
├── policy/
│   ├── index.ts      # Policy resolution: which tools may register and run
│   └── schema.ts     # Zod schema for config/tool-policy.json
├── schemas/
│   └── common.ts     # AppIdSchema, PagingShape, AttributesSchema, ResponseFormatSchema
├── auth/             # SSO token validation, browser adapter, and renewal lifecycle
├── cli/              # Human-initiated login, identity, and sign-out commands
├── services/
│   ├── client.ts     # Auth/refresh, keep-alive, rate limiting, single-flight, retry
│   ├── rate-limiter.ts
│   ├── token-store.ts
│   ├── cache.ts      # Bounded TTL-LRU, search keys, domain invalidation
│   ├── search.ts     # searchPage(): cached search + client-side paging
│   ├── format.ts     # truncate(), renderers, formatDate(), nameWithId()
│   └── logger.ts     # Structured stderr logs + counters
├── resources/        # tdx://applications, tdx://{appId}/ticket-reference
├── prompts/          # triage_ticket, weekly_ticket_report
└── tools/            # One file per domain, each exporting an array of tool definitions
    ├── auth.ts
    ├── tickets.ts    # search, get, create, edit, feed, tasks (get/create/edit)
    ├── assets.ts     # search, get, create, edit, feed
    ├── cmdb.ts       # search, get, create, edit, feed, relationships, link to ticket
    ├── projects.ts
    ├── issues.ts
    ├── people.ts     # lookup, search, get, UID by username, groups
    ├── reference.ts  # all list_* lookup tools (cached)
    └── reports.ts    # list reports, get report data, list/run saved searches
test/                # vitest unit suite
config/              # tool-policy.json + tool-policy.schema.json
archive/             # pre-2.0 implementation, kept for reference only (not compiled)
```

## Adding a New Tool

1. Add a `defineTool({...})` entry to the relevant `src/tools/*.ts` array.
2. Build the input schema with `.strict()`, reusing `AppIdSchema`, `PagingShape`, `AttributesSchema`, and `ResponseFormatSchema` from `schemas/common.ts`.
3. Keep `description` to three lines or fewer — argument docs belong in schema `.describe()`.
4. Pick annotations from `framework/annotations.ts` (`READ`, `CREATE`, `EDIT`, `DESTROY`) — the tier decides whether a deployment may run the tool at all.
5. `handler` returns a plain object (wrap arrays with `items()`); `render` turns it into markdown. Never build `content`/`structuredContent` yourself — the framework owns response shape, truncation, and error mapping.
6. For searches call `searchPage()` so caching, cursors, and the fetch cap apply.
7. Write tools that change records should set `invalidates: { domain, appIdFrom }` so cached searches are purged.
8. Throw `ToolInputError` for argument problems detectable before calling TeamDynamix.
9. Add the tool to the exported array; `index.ts` needs no change unless you add a new domain file (which also needs a `withDomain` entry and a `TOOL_DOMAINS` member).
10. Run `npm run policy:sync` so `config/tool-policy.json` lists the new tool. A unit test fails if it drifts.

## Key Conventions

- **Capability tiers gate every tool.** `read` changes nothing, `create` adds new data, `edit` overwrites fields on an existing record, `destroy` deletes or unlinks. `edit` and `destroy` are denied by default. The split follows TeamDynamix's own vocabulary: posting to a feed is an *update* (`create` tier, `teamdynamix_add_ticket_comment`), while writing a record's fields is an *edit* (`teamdynamix_edit_ticket`). Never name a field-writing tool `update_*`.
- **Policy precedence**: `TDX_DENY_TOOLS` > `TDX_ALLOW_TOOLS` > `tools` > `domains` > `defaults`, with `TEAMDYNAMIX_READ_ONLY=true` overriding all of it. A rule of `"inherit"` falls through. `registerTools` filters on this, and the handler re-checks before running, so a denied tool is neither discoverable nor invocable. An invalid policy file is a startup failure — never a permissive fallback.
- **Mark read-modify-write tools.** Where TeamDynamix has no PATCH, the tool GETs the record and writes it back, so a concurrent change is lost. Set `readModifyWrite: true` on those definitions; deployments can have the policy treat them as `destroy`.
- **`app_id` is optional when a default is configured.** `TEAMDYNAMIX_DEFAULT_APP_ID` supplies it; tools call `resolveAppId(args.app_id)` from `services/context.ts` rather than reading `args.app_id` directly. Without an explicit value or a default, the tool throws a `ToolInputError` pointing at `teamdynamix_list_applications`.
- **`/applications` is shaped differently from other reference data**: it returns `AppID`/`Type`/`Active`, not `ID`/`IsActive`. Use the `TdApp` type; do not route it through `renderNamedList`.
- **Person arguments accept emails.** Use `resolvePersonUid` / `resolvePersonUids` from `services/context.ts` for any UID argument so agents can pass the identifiers humans actually use.
- **Assets vs CIs**: Assets live at `/{appId}/assets/...`; Configuration Items live at `/{appId}/cmdb/...`. These are separate TDX namespaces with separate type/relationship systems. Use `teamdynamix_search_assets` for the Assets namespace and `teamdynamix_search_cis` for CMDB.
- **Reference data before create/update.** Valid `type_id`, `status_id`, `priority_id` values vary per org and per application. Use `teamdynamix_list_ticket_types`, `teamdynamix_list_ticket_statuses`, etc. before creating records.
- **`*_search` returns partial records; `*_get_*` returns full records.** TD's own API omits descriptions and custom attributes from search results. Use the get tool for full details.
- **Custom attributes**: Pass `custom_attributes: [{ ID: number, Value: string }]` to create/update tools for tickets, assets, and CIs. Call `teamdynamix_list_custom_attributes` (component_id=9 for tickets, 63 for assets/CIs) to discover attribute IDs and valid choice values.
- **Record links**: the API's `Uri` field is a relative API path, not a browser URL. Use `ticketUrl()` from `services/format.ts`, which builds a TDNext link from the configured base.
- **`response_format`**: `markdown` (default) returns one rendered text block; `json` returns `structuredContent` plus a one-line pointer. The payload is never serialized twice, and no `outputSchema` is declared — doing so would force `structuredContent` onto markdown responses too.
- **Pagination**: all list/search tools accept `limit` (max 100, default 25), `offset`, and an opaque `cursor` signed against the search + sort it came from. Responses include `has_more`, `next_offset`, `next_cursor`, and `total_is_lower_bound` when the 251-row window was filled — renderers must show such totals as `N+`, never as an exact count.
- **Search extras**: `count_only` skips rendering and returns just the total; `sort_by`/`sort_order` sort within the retrieved window (TeamDynamix offers no server-side sort) and force a full 251-row fetch so the ranking is not just the first page; `verbosity="compact"` gives one line per record on ticket/asset/CI searches.
- **De-duplication is opt-in for writes**: `tdRequest` coalesces identical concurrent GETs by default. `searchPage` passes `dedupe: true` because TD searches are POSTs. Never set `dedupe` on a create/update/comment — coalescing them would perform one write for two callers.
- **Child collections** (feeds, tasks, relationships, group members) take `limit`/`offset` and are sliced with `paginate()` after a record-tier cached fetch.
- **Responses are capped at 25,000 characters** and truncated with a message instructing the agent to narrow the query or paginate.
- **Caching tiers** (`services/cache.ts`): `reference` (TEAMDYNAMIX_CACHE_TTL_MS, stale-while-revalidate, never purged by writes), `search` (TEAMDYNAMIX_SEARCH_CACHE_TTL_MS), and `record` (TEAMDYNAMIX_RECORD_CACHE_TTL_MS). Pass `cacheTier` to `tdRequest`; `invalidates` purges the search and record tiers for a domain prefix.
- **Error hints**: write tools may define `errorHints` to append valid IDs to a 400. These read cache only — never add a network call to the failure path.
- **Search window**: TeamDynamix search has no offset parameter, so paging is client-side and fetches are capped at `MAX_SEARCH_FETCH` (251). Past that, steer agents to saved searches or reports.
- **Rate limits**: a sliding-window limiter (`TEAMDYNAMIX_RATE_LIMIT`/`TEAMDYNAMIX_RATE_WINDOW_MS`, default 30/60 s) queues outgoing calls to stay under TD's per-IP quota. That quota is shared across processes, so a 429 gets its own retry budget (`TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS`) and honors `Retry-After` up to `TEAMDYNAMIX_MAX_RETRY_DELAY_MS`; 503s use `TEAMDYNAMIX_MAX_RETRIES`.
- **Entry point**: `src/server.ts` builds the `McpServer`; `src/index.ts` only selects a transport and starts it. Import `createServer` from `server.js` (importing `index.js` starts the server). Tool arrays are aggregated and domain-tagged in `src/tools/index.ts`.
- **Config**: every environment variable is parsed and validated once in `src/config.ts`. Do not read `process.env` anywhere else. `src/policy/index.ts` stays pure — it receives already-parsed values so it can be unit-tested without the environment.
- **Logging**: use `logger` from `services/logger.ts`. stdout is reserved for the stdio transport, so never `console.log` in server code.
- **Reports**: `teamdynamix_get_report` (with `with_data=true`) and `teamdynamix_run_saved_search` are the most powerful read operations for complex queries — prefer these over chaining many search calls.

## Authentication

Set `TEAMDYNAMIX_BASE_URL` plus one of:
- `TEAMDYNAMIX_USERNAME` + `TEAMDYNAMIX_PASSWORD` (user login)
- `TEAMDYNAMIX_BEID` + `TEAMDYNAMIX_WS_KEY` (admin service account — preferred for automation)
- `TEAMDYNAMIX_AUTH_METHOD=sso` (local or external SSO; run `npm run login` to establish the realm-specific browser session)

Override selection with `TEAMDYNAMIX_AUTH_METHOD=user|admin|sso`. SSO uses a validated, expected-user-bound token store and silently renews about one hour before expiry while its dedicated browser session remains valid; an MFA or policy challenge surfaces as `SSO_ACTION_REQUIRED`.

For Hermes, set `TEAMDYNAMIX_MCP_DEPLOYMENT=external`. It is SSO-only, requires loopback HTTP, `MCP_AUTH_TOKEN`, `TEAMDYNAMIX_SSO_EXPECTED_USER`, and a loopback `TEAMDYNAMIX_SSO_CDP_ENDPOINT`. The CDP adapter owns only its renewal tab; retain the separate MCP secret and never forward/log the TeamDynamix JWT.

## Out of Scope

File/attachment uploads, bulk imports, time & expense, knowledge base, service catalog, and admin/config endpoints (creating ticket types, etc.) are not implemented. `src/services/client.ts` (`tdRequest`) is reusable if you need to add tools for these.

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
npm run login        # sign in as yourself via SSO (also: whoami, logout [-- --all])
npm run test:hermes-sso -- --realm sandbox  # Hermes browser compatibility gate
npm run start:http   # Streamable HTTP on 127.0.0.1:3000
npx @modelcontextprotocol/inspector node dist/index.js  # interactive testing
```

`npm run build`, `npm test`, and `npm run test:mcp` must pass before testing with a real MCP client. The unit suite and protocol test never call TeamDynamix; validate live API behavior with `npm run smoke-test` or the inspector.

## Project Structure

```
src/
├── index.ts          # Loads config, picks a transport
├── lifecycle.ts      # Availability resolution, server building, late pruning (both transports)
├── server.ts         # One server instance: instructions, mounting, resources
├── transports/       # stdio.ts and http.ts adapters (HTTP middleware, /healthz)
├── surface/          # catalog.ts (everything shipped), resolve.ts (pure: registered/denied/hidden + why), mount.ts (SDK registration, late prune)
├── config.ts         # Single zod-validated env parse; nothing else reads process.env
├── types.ts          # Shared TS types + paginate() + cursor codec
├── constants.ts      # CHARACTER_LIMIT, pagination defaults, MAX_SEARCH_FETCH
├── framework/
│   ├── defineTool.ts # Tool contract: format policy, error mapping, truncation, invalidation, timing
│   ├── definePrompt.ts# Prompts as data; `uses` lists the tools they need
│   └── annotations.ts# READ / CREATE / EDIT / DESTROY capability presets
├── policy/
│   ├── index.ts      # Policy resolution: which tools may register and run
│   ├── load.ts       # loadToolPolicy(): policy file + env overrides, legacy tool-name aliases
│   ├── availability.ts# Which application kinds the account has (fails open)
│   └── schema.ts     # Zod schema for config/tool-policy.json
├── schemas/
│   └── common.ts     # AppIdSchema, PagingShape, AttributesSchema, ResponseFormatSchema
├── auth/             # Authorization interface + adapters (service-account.ts, SSO), token-store.ts, SSO lifecycle, composition root
├── cli/              # Human-initiated login, identity, and sign-out commands
├── services/
│   ├── client.ts     # Keep-alive, rate limiting, caching, single-flight, retry; asks an Authorization for credentials
│   ├── errors.ts     # TeamDynamix auth/permission/policy error classes
│   ├── rate-limiter.ts   # RateLimiterRegistry: one limiter per route, learns from response headers
│   ├── request-context.ts# AsyncLocalStorage: abort signal and progress for the running call
│   ├── names.ts          # normalizeArgs: names -> IDs before a handler runs
│   ├── reference-kinds.ts# Reference list tables shared by the reference tools and name resolution
│   ├── budget.ts         # fitBlocks / fitPayload: size limit at record boundaries
│   ├── fields.ts         # `fields` projection and table rendering
│   ├── paged-search.ts   # Server-side paging for saved searches
│   ├── status-class.ts   # Open/closed as TeamDynamix status classes
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
    ├── reference.ts  # get_ticket_reference / get_asset_reference (table-driven, cached) + generic list_* lookups
    └── reports.ts    # list reports, get report data, list/run saved searches
test/                # vitest unit suite
config/              # tool-policy.json + tool-policy.schema.json
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

- **Capability tiers gate every tool.** `read` changes nothing, `create` adds new data, `edit` overwrites fields on an existing record, `destroy` deletes or unlinks. `edit` and `destroy` are denied by default. The split follows TeamDynamix's own vocabulary: posting to a feed is an *update* (`create` tier, `tdx_add_ticket_comment`), while writing a record's fields is an *edit* (`tdx_edit_ticket`). Never name a field-writing tool `update_*`.
- **Policy precedence** (resolved by `loadToolPolicy` in `policy/load.ts`): `TDX_DENY_TOOLS` > `TDX_ALLOW_TOOLS` > `TDX_TOOLSETS` > `tools` > `domains` > `defaults`, with `TEAMDYNAMIX_READ_ONLY=true` overriding all of it. A rule of `"inherit"` falls through. `resolveSurface` filters on this, and the handler re-checks the same policy before running, so a denied tool is neither discoverable nor invocable. An invalid policy file is a startup failure — never a permissive fallback.
- **App-aware gating is availability, not authorization, and fails open.** A tool's `requiresApp` (defaulted from its domain, set explicitly on reference lookups) hides it only when `/applications` is known and lacks that kind (matched on `AppClass`, falling back to `Type`; asset apps are `Asset/CI`). Unknown or unrecognized lists keep everything registered. Use `npm run tools:explain` to see decisions.
- **Sensitive content never goes in the repo.** Run `npm run check:sensitive` before committing (or `npm run hooks:install`). Use only `example.*`, `yourorg` and `test-` placeholders; never paste tenant URLs, application names, emails, keys or ticket data into code, tests, docs, issues or logs. Add organization terms with `npm run sensitive:add-term`, never as literals.
- **Prompts are data and follow their tools.** Define them with `definePrompt` in `prompts/index.ts` and list the tools they rely on in `uses`; `resolveSurface` hides a prompt when any of them is not registered. Nothing else decides which tools, prompts or areas a server offers: change `surface/resolve.ts`, not a caller.
- **Scripts sign in through `scripts/auth.ts`,** which wraps `createAuthorization(getConfig())`, so they follow the server's configuration rules. Do not re-implement login in a script.
- **Credentials sit behind `Authorization`.** The client only calls `authorize()` and `reportUnauthorized()`; service-account login lives in `auth/service-account.ts` and SSO in the lifecycle adapter in `auth/sso-composition.ts`. Do not read `config.auth` from the client.
- **Renamed tools get an alias.** When a tool is renamed or merged, add the old name to `LEGACY_TOOL_ALIASES` in `policy/load.ts` so existing policies keep their meaning (deny wins), and bump the major version. `test/tool-names.test.ts` fails when a tool lacks its alias or a description names a tool that does not exist.
- **Tool names come from `toolName()`** (`constants.ts`, prefix `tdx_`). The 64-character limit some model APIs apply includes the client's own prefix, so keep names short; a test checks the longest name with a 30-character client prefix.
- **Mark read-modify-write tools.** Where TeamDynamix has no PATCH, the tool GETs the record and writes it back, so a concurrent change is lost. Set `readModifyWrite: true` on those definitions; deployments can have the policy treat them as `destroy`.
- **Arguments accept names; handlers only see IDs.** `registerTool` runs `normalizeArgs` (`services/names.ts`) before the handler: an `app_id` string becomes an application ID, and arguments declared in a definition's `resolve.reference` (`{ table: "ticket", kind: "statuses" }`, kinds from `services/reference-kinds.ts`) become reference IDs, read from the cached lists. Widen a new reference argument with `refId()`/`refIds()` from `schemas/common.ts` and declare it in `resolve`; never resolve names inside a handler. Matching is exact (case-insensitive), then a single partial match, and otherwise a `ToolInputError` listing the valid values.
- **`app_id` is optional when a default is configured.** `TEAMDYNAMIX_DEFAULT_APP_ID` supplies it; tools call `resolveAppId(args.app_id)` from `services/context.ts` rather than reading `args.app_id` directly. Without an explicit value or a default, the tool throws a `ToolInputError` pointing at `tdx_list_applications`.
- **`/applications` is shaped differently from other reference data**: it returns `AppID`/`Type`/`Active`, not `ID`/`IsActive`. Use the `TdApp` type; do not route it through `renderNamedList`.
- **Person arguments accept emails and `me`.** Use `resolvePersonUid` / `resolvePersonUids` from `services/context.ts` for any UID argument so agents can pass the identifiers humans actually use. `me` is the signed-in user and is refused for a service account, which has no "me".
- **Assets vs CIs**: Assets live at `/{appId}/assets/...`; Configuration Items live at `/{appId}/cmdb/...`. These are separate TDX namespaces with separate type/relationship systems. Use `tdx_search_assets` for the Assets namespace and `tdx_search_cis` for CMDB.
- **Reference data before create/update.** Valid `type_id`, `status_id`, `priority_id` values vary per org and per application. Use `tdx_get_ticket_reference` / `tdx_get_asset_reference` (with `kinds`) before creating records. To add a list, add a row to the `TICKET_KINDS` / `ASSET_KINDS` table in `tools/reference.ts`, not a new tool; the endpoint path is also the cache key that write-tool error hints read.
- **`*_search` returns partial records; `*_get_*` returns full records.** TD's own API omits descriptions and custom attributes from search results. Use the get tool for full details.
- **Custom attributes**: Pass `custom_attributes: [{ ID: number, Value: string }]` to create/update tools for tickets, assets, and CIs. Call `tdx_list_custom_attributes` (component_id=9 for tickets, 63 for assets/CIs) to discover attribute IDs and valid choice values.
- **Record links**: the API's `Uri` field is a relative API path, not a browser URL. Use `ticketUrl()` from `services/format.ts`, which builds a TDNext link from the configured base.
- **`response_format`**: `markdown` (default) returns one rendered text block; `json` returns the compact JSON in the text block plus the same object as `structuredContent` (omitted with `TDX_STRUCTURED_CONTENT=text`). Both are fitted under `CHARACTER_LIMIT` by `services/budget.ts`: a renderer returns `RenderedBlocks` (one block per record) so a cut falls on a record boundary and says which `offset` continues; never slice a string. No `outputSchema` is declared — doing so would force `structuredContent` onto markdown responses too.
- **Pagination**: all list/search tools accept `limit` (max 100, default 25), `offset`, and an opaque `cursor` signed against the search + sort it came from. Responses include `has_more`, `next_offset`, `next_cursor`, and `total_is_lower_bound` when the 251-row window was filled — renderers must show such totals as `N+`, never as an exact count.
- **Field selection** (`fields`, in `PagingShape`) is applied once in `buildResult`, which projects any list result and renders a table through `services/fields.ts`; individual tools do nothing. A tool whose results are not a `PaginatedResult` must not spread `PagingShape`.
- **Rate limiting is per route** (`services/rate-limiter.ts`, `RateLimiterRegistry`): never add a global wait. Cancellation and progress reach `tdRequest` through `services/request-context.ts` (set up in `registerTool`), not handler arguments. Writes ignore the abort signal once sent.
- **Sign-in from the chat.** `tdx_sign_in` declares `requiresAuth` so it is registered only for local SSO (state `unsupported` otherwise, not `hidden`). It calls `runInteractiveLogin` (`auth/interactive-login.ts`), which the CLI also uses; sign-in messages come from `signInAction()`.
- **Search extras**: `count_only` skips rendering and returns just the total; `sort_by`/`sort_order` sort within the retrieved window (TeamDynamix offers no server-side sort) and force a full 251-row fetch so the ranking is not just the first page; `verbosity="compact"` gives one line per record on ticket/asset/CI searches.
- **De-duplication is opt-in for writes**: `tdRequest` coalesces identical concurrent GETs by default. `searchPage` passes `dedupe: true` because TD searches are POSTs. Never set `dedupe` on a create/update/comment — coalescing them would perform one write for two callers.
- **Child collections** (feeds, tasks, relationships, group members) take `limit`/`offset` and are sliced with `paginate()` after a record-tier cached fetch.
- **Responses are capped at 25,000 characters** and truncated with a message instructing the agent to narrow the query or paginate.
- **Caching tiers** (`services/cache.ts`): `reference` (TEAMDYNAMIX_CACHE_TTL_MS, stale-while-revalidate, never purged by writes), `search` (TEAMDYNAMIX_SEARCH_CACHE_TTL_MS), and `record` (TEAMDYNAMIX_RECORD_CACHE_TTL_MS). Pass `cacheTier` to `tdRequest`; `invalidates` purges the search and record tiers for a domain prefix.
- **Error hints**: write tools may define `errorHints` to append valid IDs to a 400. These read cache only — never add a network call to the failure path.
- **Search window**: TeamDynamix search has no offset parameter, so paging is client-side and fetches are capped at `MAX_SEARCH_FETCH` (251). Past that, steer agents to saved searches or reports.
- **Rate limits**: a sliding-window limiter (`TEAMDYNAMIX_RATE_LIMIT`/`TEAMDYNAMIX_RATE_WINDOW_MS`, default 30/60 s) queues outgoing calls to stay under TD's per-IP quota. That quota is shared across processes, so a 429 gets its own retry budget (`TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS`) and honors `Retry-After` up to `TEAMDYNAMIX_MAX_RETRY_DELAY_MS`; 503s use `TEAMDYNAMIX_MAX_RETRIES`.
- **Entry point**: `src/server.ts` builds the `McpServer`; `src/index.ts` selects a transport and starts it, or hands `login`/`logout`/`whoami` to `src/cli`. Import `createServer` from `server.js` (importing `index.js` starts the server). Tool arrays are aggregated and domain-tagged in `src/tools/index.ts`.
- **Config**: every environment variable is parsed and validated once in `src/config.ts`. Do not read `process.env` anywhere else. `src/policy/index.ts` stays pure — it receives already-parsed values so it can be unit-tested without the environment.
- **SSO state transitions go through `CredentialState`** (`src/auth/credential-state.ts`). Never call `SsoTokenStore.write/clear` directly: login, renewal commit, block, revoke and sign-out are epoch-checked and run under the realm lock. Only an interactive login lifts a renewal block; a blocked renewal still serves a valid token until it expires.
- **SSO reaches the HTTP client only as `SsoAuthorization`** (a header plus fingerprint), built by `src/auth/sso-composition.ts`. The client never sees the token or the store. `method === "sso"` belongs in `config.ts` and the composition root only; elsewhere use `isSsoConfig()` / `isServiceAuth()` from `config.ts`, which narrow the type without casts.
- **Logging**: use `logger` from `services/logger.ts`. stdout is reserved for the stdio transport, so never `console.log` in server code.
- **Reports**: `tdx_get_report` (with `with_data=true`) and `tdx_run_saved_search` are the most powerful read operations for complex queries — prefer these over chaining many search calls.

## Authentication

Set `TEAMDYNAMIX_BASE_URL` plus one of:
- `TEAMDYNAMIX_USERNAME` + `TEAMDYNAMIX_PASSWORD` (user login)
- `TEAMDYNAMIX_BEID` + `TEAMDYNAMIX_WS_KEY` (admin service account — preferred for automation)
- `TEAMDYNAMIX_AUTH_METHOD=sso` (local or external SSO; run `npm run login` to establish the realm-specific browser session)

Override selection with `TEAMDYNAMIX_AUTH_METHOD=user|admin|sso`. SSO uses a validated, expected-user-bound token store and silently renews about one hour before expiry while its dedicated browser session remains valid; an MFA or policy challenge surfaces as `SSO_ACTION_REQUIRED`.

For Hermes, set `TEAMDYNAMIX_MCP_DEPLOYMENT=external`. It is SSO-only, requires loopback HTTP, `MCP_AUTH_TOKEN`, `TEAMDYNAMIX_SSO_EXPECTED_USER`, and a loopback `TEAMDYNAMIX_SSO_CDP_ENDPOINT`. The CDP adapter owns only its renewal tab; retain the separate MCP secret and never forward/log the TeamDynamix JWT.

## Out of Scope

File/attachment uploads, bulk imports, time & expense, knowledge base, service catalog, and admin/config endpoints (creating ticket types, etc.) are not implemented. `src/services/client.ts` (`tdRequest`) is reusable if you need to add tools for these.

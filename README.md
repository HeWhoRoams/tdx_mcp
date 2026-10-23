# TeamDynamix MCP Server

An MCP (Model Context Protocol) server that lets LLM agents interact with the
[TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) — tickets,
assets, configuration items (CMDB), projects, issues, people, groups, and reports.

## Authenticate as yourself (SSO)

For local use, the server can act as **you** instead of a shared admin key. TeamDynamix then enforces your own roles and application access, and records you as the author of anything created.

```powershell
npm install
npm run build
npm run login      # opens Edge, you finish CMU SSO + MFA, the window closes
npm run whoami     # who you are, when the token expires, and whether renewal is healthy (~24h)
npm run logout     # forget the token (add -- --all to also remove the login browser profile)
```

MCP client config (set auth in the client's `env` block, not `.env`, because clients often start the server from another folder):

```json
{
  "mcpServers": {
    "teamdynamix": {
      "command": "node",
      "args": ["C:\\Github\\tdx_mcp\\dist\\index.js"],
      "env": {
        "TEAMDYNAMIX_BASE_URL": "https://yourorg.teamdynamix.com/SBTDWebApi",
        "TEAMDYNAMIX_AUTH_METHOD": "sso",
        "TEAMDYNAMIX_SSO_EXPECTED_USER": "you@yourorg.edu"
      }
    }
  }
}
```

Notes: TeamDynamix tokens last 24 hours and have no refresh token. After the first login, the server silently mints and validates a replacement about one hour before expiry. If CMU SSO requires interaction or MFA, tools return `SSO_ACTION_REQUIRED`; run `npm run login` to recover. Sandbox and production keep separate state. See `docs/plans/sso-user-auth.md`.

**States** (`npm run whoami`): *usable* (renews automatically); *renewal blocked* (renewal hit MFA or another policy, a different user, or a rejected token; the current token keeps working until it expires, then run `npm run login`); *needs renewal* (expired, renews on next use if it can); *sign-in required* (nothing usable, run `npm run login`). A timeout or 5xx from TeamDynamix never discards your token. `npm run logout` always wins over a renewal already in progress.

**Several clients at once** (for example Claude Desktop and Claude Code on the same realm): they share one token file and take a lock around renewal, so only one browser window opens and the others pick up its result.

**Upgrading from the first SSO release:** if `TEAMDYNAMIX_SSO_EXPECTED_USER` is set, an existing saved sign-in is carried over after TeamDynamix confirms it is yours. Otherwise it is left untouched and you simply run `npm run login`. With `TEAMDYNAMIX_MCP_DEPLOYMENT=external`, `logout --all` cannot end the Hermes browser's SSO session; ask the Hermes operator.

### External Hermes SSO

Set `TEAMDYNAMIX_MCP_DEPLOYMENT=external` for one persistent Hermes workspace and one assigned user. This requires `TRANSPORT=http`, loopback `HOST`, a separate `MCP_AUTH_TOKEN`, `TEAMDYNAMIX_SSO_EXPECTED_USER`, and `TEAMDYNAMIX_SSO_CDP_ENDPOINT=http://127.0.0.1:9222`. The server attaches only to that configured CDP endpoint and creates an owned renewal tab; it never forwards a TeamDynamix token through MCP. Validate the sandbox with `npm run test:hermes-sso -- --realm sandbox`. See [Hermes rollout](docs/operations/hermes-sso-rollout.md).

## Features

64 tools across nine areas:

| Area | Tools |
|---|---|
| **Auth** | `teamdynamix_get_current_user` |
| **Tickets** | search, get, create, update, feed (get/add comment), tasks (get/create/update) |
| **Assets** | search, get, create, update, feed (get/add comment) |
| **CMDB / Config Items** | search, get, create, update, feed, relationships (get/add/remove), link to ticket |
| **Projects** | search, get, create, update, feed (get/add comment) |
| **Issues** | search, get, create, update |
| **People / Groups** | lookup, search, get, get UID by username, search groups, get group, get/add/remove members |
| **Reference data** | applications, ticket types/statuses/priorities/sources/forms/impacts/urgencies, asset statuses, locations, product models, accounts, CI types, CI relationship types, custom attributes |
| **Reports** | list reports, get report data, list saved searches, run saved searches |

> **Maintenance:** Update this table in the same PR that adds or removes a tool.

All list/search tools support pagination (`limit`/`offset`, plus an opaque
`next_cursor`) and a `response_format` of `markdown` (human-readable, default)
or `json` (structured data in `structuredContent`). Responses are capped at
25,000 characters with a message telling the agent how to narrow the query or
paginate.

The server also exposes MCP **resources** (`tdx://applications`,
`tdx://{appId}/ticket-reference`) so hosts can pin reference data to context
without a tool round trip, and **prompts** (`triage_ticket`,
`weekly_ticket_report`) that demonstrate the intended tool composition.

### Working conversationally

These behaviors exist to keep an agent from burning turns on bookkeeping:

- **Default application** — set `TEAMDYNAMIX_DEFAULT_APP_ID` and `app_id`
  becomes optional everywhere. In an organization with dozens of ticketing
  applications this removes the "which app?" question from most conversations.
- **Emails instead of UIDs** — every person argument (`responsible_uid`,
  `requestor_uid`, `owning_customer_uid`, `project_manager_uid`, `notify_uids`,
  and the `*_uids` search filters) accepts an email address and resolves it
  server-side against a cached lookup. Ambiguous addresses come back as an error
  listing the candidate UIDs, so the agent can retry in one turn.
- **Self-correcting errors** — when TeamDynamix rejects a create or update with
  a 400, the response appends the valid `status_id`/`type_id`/`priority_id`
  values for that application, read from cache only (never an extra API call).
- **Clickable records** — rendered tickets include a TDNext link derived from
  the configured base URL, so answers can be handed straight to a person.
- **Honest counts** — TeamDynamix search has no total-count endpoint, so a total
  rendered as `251+` means "at least", not "exactly". Use `count_only=true` for
  "how many" questions and `verbosity="compact"` to scan many records cheaply.

### Response format and payload size

A tool response never serializes its payload twice:

- `markdown` (default) returns a single rendered text block.
- `json` returns `structuredContent` plus a one-line pointer.

An `outputSchema` is deliberately not declared. The MCP SDK requires
`structuredContent` on every result once a tool declares one, which would force
markdown responses to carry the full JSON payload as well — exactly the
duplication this policy removes.

## Setup

```bash
npm install
npm run build
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `TEAMDYNAMIX_BASE_URL` | TeamDynamix organization root, Web API root, or complete API root. Examples: `https://yourorg.teamdynamix.com`, `https://yourorg.teamdynamix.com/TDWebApi`, or `https://yourorg.teamdynamix.com/SBTDWebApi/api` |
| `TEAMDYNAMIX_BEID` | Admin service account BEID (found in TDAdmin → Organization) |
| `TEAMDYNAMIX_WS_KEY` | Admin service account Web Services Key |
| `TEAMDYNAMIX_USERNAME` | Standard user/service-account login (alternative to BEID) |
| `TEAMDYNAMIX_PASSWORD` | Password for user login |
| `TEAMDYNAMIX_AUTH_METHOD` | Optional. Explicitly select `user`, `admin`, or `sso` |
| `TEAMDYNAMIX_SSO_EXPECTED_USER` | Local SSO identity binding; required for external Hermes |
| `TEAMDYNAMIX_SSO_BROWSER` | Local SSO browser channel: `msedge` (default), `chrome`, or `chromium` |
| `TEAMDYNAMIX_MCP_DEPLOYMENT` | `local` (default) or `external` Hermes |
| `TEAMDYNAMIX_SSO_CDP_ENDPOINT` | Required loopback Chrome CDP endpoint for external Hermes |
| `TEAMDYNAMIX_SSO_RENEW_LEAD_MS` | Milliseconds before expiry to attempt silent SSO renewal; default `3600000` |
| `TEAMDYNAMIX_SSO_RENEW_RETRIES` | Transient silent-renewal retries; default `3` |
| `TEAMDYNAMIX_DEFAULT_APP_ID` | Optional. Default application for app-scoped tools, so `app_id` can be omitted |
| `TEAMDYNAMIX_READ_ONLY` | Optional. Set exactly to `true` to omit every tool that changes TeamDynamix |
| `TDX_TOOL_POLICY_FILE` | Optional. Path to a tool policy JSON file; defaults to `config/tool-policy.json` |
| `TDX_ALLOW_CAPABILITIES` | Optional. Comma-separated tiers to allow, e.g. `read,create`. Replaces the file's `defaults` |
| `TDX_ALLOW_TOOLS` | Optional. Comma-separated allowlist. When set, only these tools register |
| `TDX_DENY_TOOLS` | Optional. Comma-separated tool names to deny, overriding every other rule |
| `TEAMDYNAMIX_TOKEN_CACHE` | `memory` (default) or `file` to persist the JWT across short-lived processes |
| `TEAMDYNAMIX_TIMEOUT_MS` | Per-request timeout; default `15000` |
| `TEAMDYNAMIX_MAX_SOCKETS` | Keep-alive connection pool size; default `8` |
| `TEAMDYNAMIX_MAX_RETRIES` | Retries for 503 responses; default `2` |
| `TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS` | Separate budget for 429 waits; default `3` |
| `TEAMDYNAMIX_MAX_RETRY_DELAY_MS` | Ceiling on any single retry wait; default `60000` |
| `TEAMDYNAMIX_RATE_LIMIT` | Outgoing requests allowed per window; default `30` |
| `TEAMDYNAMIX_RATE_WINDOW_MS` | Rate limit window; default `60000` |
| `TEAMDYNAMIX_CACHE_TTL_MS` | Reference-data cache TTL; default `600000`, `0` disables |
| `TEAMDYNAMIX_SEARCH_CACHE_TTL_MS` | Search page cache TTL; default `60000`, `0` disables |
| `TEAMDYNAMIX_RECORD_CACHE_TTL_MS` | Single-record and child-collection cache TTL; default `30000`, `0` disables |
| `TEAMDYNAMIX_CACHE_MAX_ENTRIES` | Bound on each cache; default `500` |
| `TDX_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`, or `silent`. Structured JSON logs go to stderr |
| `TRANSPORT` | `stdio` (default) or `http` |
| `HOST` | HTTP bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |
| `MCP_AUTH_TOKEN` | Bearer token for HTTP clients; required when `HOST` is not loopback |
| `MCP_ALLOWED_HOSTS` | Optional comma-separated HTTP Host allowlist, recommended for remote deployments |
| `MCP_ALLOWED_ORIGINS` | Optional comma-separated browser Origin allowlist |

All configuration is validated once at startup; invalid or missing values fail
fast with a single message listing every problem.

If no method is selected, admin key-based auth is preferred when both admin and user credentials are configured. SSO must be selected explicitly; its token lifecycle is separate from password/key authentication.

`TEAMDYNAMIX_BASE_URL` is normalized to the API root used by the server. For a
standard organization URL, the server calls
`https://yourorg.teamdynamix.com/TDWebApi/api`. For a sandbox or organization
with a custom Web API path, provide that path explicitly, for example:

```dotenv
TEAMDYNAMIX_BASE_URL=https://yourorg.teamdynamix.com/SBTDWebApi
```

This produces `https://yourorg.teamdynamix.com/SBTDWebApi/api/auth/loginadmin`
for admin authentication. Do not use the TDNext browser URL
(`/SBTDNext/Login.aspx`) as the API base URL.

### Verify your setup

Run this after filling in `.env` to confirm authentication works and list your application IDs:

```bash
npm run verify
```

## Running

### stdio (default)

Recommended for Claude Desktop, VS Code Copilot, and other local clients:

```bash
npm start
```

### Streamable HTTP

Local HTTP uses `127.0.0.1:3000` by default:

```bash
npm run start:http
# MCP endpoint: http://127.0.0.1:3000/mcp
```

For a hosted deployment, set `HOST=0.0.0.0`, a strong `MCP_AUTH_TOKEN`, and
`MCP_ALLOWED_HOSTS` to the public hostname. Terminate TLS at a reverse proxy or
hosting platform; major remote MCP clients require HTTPS. The HTTP transport is
stateless and supports JSON responses, so `GET /mcp` and `DELETE /mcp` return
`405 Method Not Allowed` with `Allow: POST` as permitted by the MCP specification.
Browser CORS preflights advertise only `POST`; GET and DELETE are not enabled as
cross-origin methods. Browser clients must use an origin listed in
`MCP_ALLOWED_ORIGINS`, while server-to-server MCP clients normally send no
`Origin` header.

## Read and write capabilities

Every tool is classified into one of four capability tiers, which the tool policy
uses to decide what a given deployment may do:

| Tier | Meaning | Examples | Default |
|---|---|---|---|
| `read` | Changes nothing | `teamdynamix_search_tickets`, `teamdynamix_get_report` | allow |
| `create` | Adds new data; nothing existing is overwritten | `teamdynamix_create_ticket`, `teamdynamix_add_ticket_comment` | allow |
| `edit` | Overwrites fields on an existing record | `teamdynamix_edit_ticket`, `teamdynamix_edit_asset`, `teamdynamix_edit_ci`, `teamdynamix_edit_ticket_task` | **deny** |
| `destroy` | Deletes or unlinks existing data | `teamdynamix_remove_group_members` | **deny** |

The `create`/`edit` split follows TeamDynamix's own vocabulary. Posting to a
ticket's feed is an **update** — the normal technician workflow, additive, and
allowed by default. Writing a ticket's Title, Status, or Responsible fields is an
**edit**, and is denied unless a deployment opts in.

Read tools declare `readOnlyHint: true`. Everything else declares
`readOnlyHint: false`, and the `edit` and `destroy` tiers additionally declare
`destructiveHint: true`.

Client approval remains controlled by the MCP host. VS Code, Claude, ChatGPT,
and OpenAI API applications can require confirmation before write calls. The
TeamDynamix account configured on the server must itself have permission for the
requested read or write operation.

### Tool policy

`config/tool-policy.json` decides which tools are registered. Denied tools are
never advertised and cannot be invoked, so this is an enforcement boundary inside
the server rather than a client approval hint.

The checked-in policy allows `read` and `create` tools by default, while `edit`
and `destroy` tools are denied unless explicitly enabled through a domain rule,
tool rule, or environment override. The individual tool entries in the file
default to `inherit`, so the tier and domain rules remain the source of truth.

```jsonc
{
  "$schema": "./tool-policy.schema.json",
  "defaults": { "read": "allow", "create": "allow", "edit": "deny", "destroy": "deny" },
  "domains": {
    "tickets": { "edit": "allow" },   // technicians may edit tickets...
    "cmdb": { "edit": "deny" }        // ...but never the CMDB
  },
  "tools": {
    "teamdynamix_edit_ticket_task": "allow",
    "teamdynamix_remove_group_members": "deny"
  },
  "treatReadModifyWriteAsDestroy": false
}
```

Rules are applied most specific first: `TDX_DENY_TOOLS`, then `TDX_ALLOW_TOOLS`,
then `tools`, then `domains`, then `defaults`. A rule of `"inherit"` expresses no
opinion and falls through to the next layer. `TEAMDYNAMIX_READ_ONLY=true`
overrides everything and leaves only the `read` tier.

A few TeamDynamix endpoints have no PATCH, so those tools read the record and
write the whole thing back — a concurrent change is silently lost. Set
`treatReadModifyWriteAsDestroy` to `true` to judge them under the `destroy` tier.

An invalid or unreadable policy file is a startup failure; the server never falls
back to a more permissive configuration. If the file is absent entirely, the
built-in defaults above apply.

Run `npm run policy:sync` after adding or removing a tool to keep the `tools` map
in step with the catalog; a unit test fails if it drifts.

### Read-only server mode

For a server instance that must not expose write operations, set:

```dotenv
TEAMDYNAMIX_READ_ONLY=true
```

In this mode, the server does not register any tool whose annotation is
`readOnlyHint: false`, so clients cannot discover or invoke those write tools.
It is still best practice to use a dedicated TeamDynamix account with only the
required read permissions, because API credentials are an independent defense
layer.

## Using with VS Code (GitHub Copilot)

Add the server to your VS Code MCP configuration using one of the two methods below.

### Option A — Workspace config (shared with your team)

Create or edit `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "teamdynamix": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "TEAMDYNAMIX_BASE_URL": "${input:tdxBaseUrl}",
        "TEAMDYNAMIX_BEID": "${input:tdxBeid}",
        "TEAMDYNAMIX_WS_KEY": "${input:tdxWsKey}"
      }
    }
  },
  "inputs": [
    {
      "id": "tdxBaseUrl",
      "type": "promptString",
      "description": "TeamDynamix org or API URL (e.g. https://yourorg.teamdynamix.com or https://yourorg.teamdynamix.com/SBTDWebApi)"
    },
    {
      "id": "tdxBeid",
      "type": "promptString",
      "description": "TeamDynamix admin BEID",
      "password": false
    },
    {
      "id": "tdxWsKey",
      "type": "promptString",
      "description": "TeamDynamix Web Services Key",
      "password": true
    }
  ]
}
```

VS Code will prompt you for credentials on first use and store them securely — no secrets in source control.

### Option B — User profile config (personal, all workspaces)

Open the Command Palette (`Ctrl+Shift+P`) → **MCP: Open User Configuration**, then add:

```json
{
  "servers": {
    "teamdynamix": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/teamdynamix-mcp-server/dist/index.js"],
      "env": {
        "TEAMDYNAMIX_BASE_URL": "https://yourorg.teamdynamix.com",
        "TEAMDYNAMIX_BEID": "your-beid",
        "TEAMDYNAMIX_WS_KEY": "your-ws-key"
      }
    }
  }
}
```

> **Tip:** Use `${input:...}` variables (as shown in Option A) instead of hardcoding credentials even in your user profile config.

After saving, VS Code will prompt you to trust the server. Once trusted, all TeamDynamix tools will be available in GitHub Copilot chat (`Ctrl+Alt+I`).

## Using with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "teamdynamix": {
      "command": "node",
      "args": ["/absolute/path/to/teamdynamix-mcp-server/dist/index.js"],
      "env": {
        "TEAMDYNAMIX_BASE_URL": "https://yourorg.teamdynamix.com",
        "TEAMDYNAMIX_BEID": "your-beid",
        "TEAMDYNAMIX_WS_KEY": "your-ws-key"
      }
    }
  }
}
```

## Using with ChatGPT and OpenAI

### OpenAI Responses API

OpenAI's Responses API can call remote MCP servers over Streamable HTTP. Deploy
this server behind HTTPS and pass its bearer token in `authorization`:

```javascript
const response = await openai.responses.create({
  model: "gpt-5.6",
  input: "Find my open TeamDynamix tickets and summarize them.",
  tools: [{
    type: "mcp",
    server_label: "teamdynamix",
    server_description: "Read and update TeamDynamix tickets, assets, CMDB, projects, people, and reports.",
    server_url: "https://mcp.example.com/mcp",
    authorization: process.env.MCP_AUTH_TOKEN,
    require_approval: "always"
  }]
});
```

OpenAI requires approval by default before sharing data with a remote MCP server.
Keep approval enabled for write tools; applications that trust the server can
selectively skip approval for named read tools.

### ChatGPT custom apps

ChatGPT custom apps can expose both read operations and write actions from an MCP
server. Use a publicly reachable HTTPS endpoint and configure app permissions so
changes require approval. MCP authorization is optional at the protocol level,
but this server intentionally requires `MCP_AUTH_TOKEN` when exposed remotely
because it holds TeamDynamix credentials and provides write actions.

The static bearer-token mode works directly with the OpenAI Responses API. A
published or per-user ChatGPT app may require an MCP-compliant OAuth 2.1 resource
server and authorization service instead; that user-delegated OAuth flow is not
implemented here. Do not publish an unauthenticated instance.

### OpenAI-compatible endpoints

MCP support belongs to the **agent host/API implementation**, not the model wire
format. An endpoint that only emulates OpenAI Chat Completions is not automatically
an MCP client. It works with this server when either:

- the endpoint implements the OpenAI Responses API `type: "mcp"` tool; or
- an MCP-aware host such as VS Code, Claude Desktop, Cursor, or Continue uses that
  endpoint as its model backend and calls this server separately.

For endpoints without either capability, use a client-side MCP-to-function-calling
adapter; no change to this server is required.

## Utility Scripts

| Command | Description |
|---|---|
| `npm test` | Unit suite (vitest, no network): config, client, cache, pagination, cursors, search, tool framework |
| `npm run test:mcp` | Build and verify discovery of all 64 read/write tools over stdio and authenticated HTTP, including auth, origin, method, and CORS preflight checks |
| `npm run test:all` | Unit suite + script type-check + protocol test |
| `npm run bench` | Measure cold start, warm calls, cache hits, and search paging; accepts `-- --app-id <ID>` |
| `npm run measure:window` | Sweep search `MaxResults` to see how latency scales with window size |
| `npm run check:scripts` | Type-check all utility and protocol-test scripts |
| `npm run verify` | Authenticate and list all ticketing app IDs — run this first |
| `npm run smoke-test` | Exercise every read endpoint; performs no writes |
| `npm run smoke-test:write` | Write-path checks. Requires `TDX_ALLOW_WRITE_TESTS=true` and `--app-id`, and refuses non-sandbox URLs. Tier A (default) creates nothing; `--tier b` creates one permanent ticket |
| `npm run list-apps` | List all applications grouped by type; supports `--all` and `--type <T>` |
| `npm run search-tickets -- --app-id <ID> [options]` | Search tickets from the CLI |

### search-tickets options

```
--app-id       <number>   Required. Use `npm run list-apps` to find IDs
--limit        <number>   Max results (default: 25)
--offset       <number>   Pagination offset (default: 0)
--search       <string>   Free-text search
--requestor    <email>    Filter by requestor email
--is-open                 Only open tickets
--status-ids   <n,n,…>   Comma-separated status IDs
--priority-ids <n,n,…>   Comma-separated priority IDs
--type-ids     <n,n,…>   Comma-separated type IDs
--json                    Output raw JSON
```

## Notes on the TeamDynamix API

- **`app_id` is required** on most tools. It scopes requests to a specific TDX application (ticketing app, assets app, etc.). Run `npm run verify` or call `teamdynamix_list_applications` to discover valid IDs.
- **Reference data first**: valid `type_id`, `status_id`, and `priority_id` values vary per org and per application. Use the `teamdynamix_list_*` tools before creating or updating records.
- **Assets vs. CMDB**: Assets live at `/{appId}/assets/...`; Configuration Items live at `/{appId}/cmdb/...`. These are separate TDX namespaces with separate type/relationship systems.
- **Search vs. get**: `*_search` tools return partial records (no descriptions or custom attributes). Use the corresponding `*_get_*` tool for full details.
- **Custom attributes**: Pass `custom_attributes: [{ ID: number, Value: string }]` to create/update tools. Use `teamdynamix_list_custom_attributes` (component_id=9 for tickets, 63 for assets/CIs) to discover IDs and valid choice values.
- **Reports**: `teamdynamix_get_report` (with `with_data=true`) and `teamdynamix_run_saved_search` are the most powerful read operations for complex queries — prefer these over chaining many search calls.
- **Rate limits**: TD commonly enforces 30–60 calls/60s per IP. The server auto-retries 429 and 503 responses with 2s then 4s exponential backoff before surfacing the error.

## Performance architecture

- **Connection reuse**: keep-alive HTTP(S) agents, so requests after the first
  skip the TLS handshake.
- **Proactive rate limiting**: a sliding-window limiter queues outgoing calls
  under TeamDynamix's per-IP quota instead of provoking 429s and paying the
  recovery cost. 429/503 responses honor `Retry-After` with jittered backoff.
- **Single-flight de-duplication**: identical concurrent reads collapse into one
  upstream request. Writes are never coalesced, so two identical creates always
  produce two records.
- **Caching**: three bounded TTL-LRU tiers — *reference* data (applications,
  types, statuses, priorities, locations, accounts, people) served with
  stale-while-revalidate so it is effectively instant after first use; *search*
  pages so paging and re-sorting never re-run a query; and *record* data (single
  records, feeds, tasks, relationships, members). A write purges the search and
  record tiers for its domain and deliberately leaves reference data intact.
- **Token warm-up and reuse**: the JWT and application list are fetched in the
  background at startup, and `TEAMDYNAMIX_TOKEN_CACHE=file` persists the token
  (mode `0600`, in the OS temp directory) so short-lived CLI processes skip the
  login round trip.
- **Bounded search window**: TeamDynamix search endpoints have no offset
  parameter, so results are paged client-side. The first page fetches only what
  it needs; the moment an agent pages, the server pulls the whole 251-row window
  once and serves every later page from cache. (Measured on a sandbox: ~440 ms
  fixed cost plus ~1 ms per row, so widening once beats refetching per page.)
  Beyond that window the server steers agents to saved searches and reports.
  Cursors are signed against the search and sort they came from, so a replayed
  cursor fails loudly instead of returning rows from a different query.
- **Rate limiting is per process**: the limiter protects a long-running server,
  but TeamDynamix enforces its quota per IP, so other processes or integrations
  can consume it. A 429 is therefore treated as a wait instruction rather than a
  failure: it honors `Retry-After` up to `TEAMDYNAMIX_MAX_RETRY_DELAY_MS` and
  draws on its own budget (`TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS`), so a shared-quota
  stall does not consume the retries reserved for genuine errors.
- **Observability**: structured JSON logs on stderr with per-request timing,
  cache hit/miss, and retry counts, plus `GET /healthz` on the HTTP transport.

Run `npm run bench` before and after configuration changes to measure the impact.

## Development

```bash
npm run dev      # tsx watch — no build step needed
npm run build    # tsc → dist/
npm test         # vitest unit suite
npx @modelcontextprotocol/inspector node dist/index.js   # interactive tool testing
```

## Project Structure

```
src/
├── index.ts            # Transport selection, registration, health, shutdown
├── config.ts           # Single zod-validated environment parse
├── constants.ts        # CHARACTER_LIMIT, pagination + search-window bounds
├── types.ts            # Shared TS interfaces, paginate(), cursor codec
├── framework/
│   ├── defineTool.ts   # Declarative tool contract: format policy, errors, caching, timing
│   └── annotations.ts  # READ / CREATE / EDIT / DESTROY capability presets
├── policy/
│   ├── index.ts        # Tool policy resolution and enforcement decisions
│   └── schema.ts       # Zod schema for config/tool-policy.json
├── schemas/
│   └── common.ts       # Reusable Zod schemas (AppIdSchema, PagingShape, etc.)
├── services/
│   ├── client.ts       # Auth, keep-alive, rate limiting, dedup, retry
│   ├── rate-limiter.ts # Sliding-window limiter
│   ├── token-store.ts  # In-memory or file-backed JWT store
│   ├── cache.ts        # Bounded TTL-LRU + search keys + invalidation
│   ├── search.ts       # Cached search + client-side paging
│   ├── format.ts       # Renderers and truncation
│   └── logger.ts       # Structured stderr logging + counters
├── resources/          # tdx:// reference-data resources
├── prompts/            # triage_ticket, weekly_ticket_report
└── tools/              # One definition array per domain
    ├── auth.ts
    ├── tickets.ts
    ├── assets.ts
    ├── cmdb.ts
    ├── projects.ts
    ├── issues.ts
    ├── people.ts
    ├── reference.ts
    └── reports.ts
test/                  # vitest unit suite
scripts/               # verify, list-apps, search-tickets, smoke-test, bench, protocol test
config/                # tool-policy.json and its JSON schema
```

## License

MIT — see [LICENSE](LICENSE).


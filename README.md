# TeamDynamix MCP Server

**Version:** 3.1.0 · **Last updated:** 2026-10-28

An MCP (Model Context Protocol) server that lets LLM agents interact with the
[TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) — tickets,
assets, configuration items (CMDB), projects, issues, people, groups, and reports.

## Changelog

- **4.0.0** — **Breaking: tool names.** Every tool is renamed from `teamdynamix_*` to `tdx_*` (the prefix a client adds in front of a tool name left little room under the 64-character limit some model APIs enforce). Policy rules, `TDX_ALLOW_TOOLS` and `TDX_DENY_TOOLS` that name a 3.x tool keep working through aliases; client-side allowlists do not. See [Migrating to 4.0](#migrating-to-40). **Answers that were wrong or cut short:** "open tickets" now filters by status class (TeamDynamix ignores `IsOpen`), saved searches page on the server instead of returning one truncated window, replies are cut at record boundaries with a note saying where to continue, JSON mode puts the data in the text block as well as `structuredContent`, and `get_*` tools show the whole record. **Fewer round trips:** `app_id`, statuses, priorities and types accept names, person arguments accept `me`, `fields` returns only the columns you need, reports page and can be cut to chosen columns, and `count_only` can use a wider window (`TEAMDYNAMIX_COUNT_WINDOW`). **Rate limits:** one limiter per route that learns from `X-RateLimit-*` headers, waits for a stated reset plus a 5 s margin, reports progress, and honours cancellation (a sent write is never aborted). **Sign-in from the chat:** `tdx_sign_in` opens the sign-in window on a local server. **Install:** `npx teamdynamix-mcp-server init`, a per-user `TDX_HOME/.env`, and a desktop extension bundle built for releases. New ticket filters: `is_on_hold`, `closed_date_from/to`, `location_ids`. A custom attribute filter was tried and dropped: TeamDynamix ignores that property.
- **3.1.0** — Audit fixes, no tool changes. **Security:** the service-account token cache (`TEAMDYNAMIX_TOKEN_CACHE=file`) moved from the shared temp folder to the per-user state folder (`TDX_HOME/tokens`, private folder, file replaced by rename), so the first run after upgrading logs in once more (you can delete the old `tdx-mcp` folder in your temp directory); a network-reachable HTTP server (`HOST` not loopback) now refuses to start unless `MCP_AUTH_TOKEN` is at least 24 characters. **Reliability:** scripts no longer exit while requests are queued behind the rate limit, expired search and record cache entries are dropped as new ones are stored, and concurrent stale reads of reference data share one background refresh. **Scripts** now sign in through the server's own login code, so `npm run verify` fails exactly as the server would for mismatched credentials. **Smaller fixes:** `get_person` encodes the UID, the ticket-reference resource rejects a non-numeric app ID, and HTTP logs "tools registered" once at start-up instead of on every request. The unused `archive/` folder was removed.
- **3.0.0** — **Breaking: tool names.** The 11 ticket and asset reference lookups are replaced by `teamdynamix_get_ticket_reference` and `teamdynamix_get_asset_reference`, each taking a `kinds` list (default surface 55 → 46 tools; 64 → 55 unrestricted). Policy rules, `TDX_ALLOW_TOOLS` and `TDX_DENY_TOOLS` that name an old tool keep working: the name is translated to its replacement (a deny on any old name denies the new tool) and a warning names the replacement. Internals: one tool-surface module decides what is registered, prompts are only offered when the tools they use are registered, a server-lifecycle module owns start-up and late pruning for both transports, policy loading moved out of `config.ts`, and service-account login moved behind the same `Authorization` interface SSO uses. See [Migrating to 3.0](#migrating-to-30).
- **2.2.0** — Smaller tool surface: `TDX_TOOLSETS` domain allowlist, application-aware gating (tools for Ticketing, Asset/CI and Projects are not registered when the account has no such application; fails open), `tools:explain`. Repository hygiene: a hash-based sensitive-content scanner, a package allowlist and CI checks (see Contributing).
- **2.1.0** — SSO user authentication: per-user token lifecycle, silent renewal via persistent browser session, Hermes CDP compatibility gate, `login`/`whoami`/`logout` CLI commands, realm-locked credential state.
- **2.0.0** — Full rewrite: policy-gated tool registration, capability tiers (read/create/edit/destroy), structured caching with domain invalidation, rate limiting, cursor-based pagination, `defineTool` framework.

## Authenticate as yourself (SSO)

For local use, the server can act as **you** instead of a shared admin key. TeamDynamix then enforces your own roles and application access, and records you as the author of anything created.

```powershell
npm install
npm run build
npm run login      # opens Edge, you finish SSO + MFA, the window closes
npm run whoami     # who you are, when the token expires, and whether renewal is healthy (~24h)
npm run logout     # forget the token (add -- --all to also remove the login browser profile)
```

MCP client config (credentials live in the gitignored `.env` at the project root — the server loads it from there even when the client starts it from another folder, so keep the client config free of identifying values):

```json
{
  "mcpServers": {
    "teamdynamix": {
      "command": "node",
      "args": ["C:\\Github\\tdx_mcp\\dist\\index.js"]
    }
  }
}
```

The `.env` file supplies `TEAMDYNAMIX_BASE_URL`, `TEAMDYNAMIX_AUTH_METHOD=sso`, and `TEAMDYNAMIX_SSO_EXPECTED_USER`. Set `TDX_ENV_FILE` to point at a different `.env` location, or add variables to the client's `env` block to override individual values (client-set variables always win).

Notes: TeamDynamix tokens last 24 hours and have no refresh token. After the first login, the server silently mints and validates a replacement about one hour before expiry. If SSO requires interaction or MFA, tools return `SSO_ACTION_REQUIRED`; run `npm run login` to recover. Sandbox and production keep separate state. See `planning/plans/sso-user-auth.md`.

**States** (`npm run whoami`): *usable* (renews automatically); *renewal blocked* (renewal hit MFA or another policy, a different user, or a rejected token; the current token keeps working until it expires, then run `npm run login`); *needs renewal* (expired, renews on next use if it can); *sign-in required* (nothing usable, run `npm run login`). A timeout or 5xx from TeamDynamix never discards your token. `npm run logout` always wins over a renewal already in progress.

**Several clients at once** (for example Claude Desktop and Claude Code on the same realm): they share one token file and take a lock around renewal, so only one browser window opens and the others pick up its result.

**Upgrading from the first SSO release:** if `TEAMDYNAMIX_SSO_EXPECTED_USER` is set, an existing saved sign-in is carried over after TeamDynamix confirms it is yours. Otherwise it is left untouched and you simply run `npm run login`. With `TEAMDYNAMIX_MCP_DEPLOYMENT=external`, `logout --all` cannot end the Hermes browser's SSO session; ask the Hermes operator.

### External Hermes SSO (Still a work in progress)

Set `TEAMDYNAMIX_MCP_DEPLOYMENT=external` for one persistent Hermes workspace and one assigned user. This requires `TRANSPORT=http`, loopback `HOST`, a separate `MCP_AUTH_TOKEN`, `TEAMDYNAMIX_SSO_EXPECTED_USER`, and `TEAMDYNAMIX_SSO_CDP_ENDPOINT=http://127.0.0.1:9222`. The server attaches only to that configured CDP endpoint and creates an owned renewal tab; it never forwards a TeamDynamix token through MCP. Validate the sandbox with `npm run test:hermes-sso -- --realm sandbox`. See [Hermes rollout](planning/operations/hermes-sso-rollout.md).

## Features

56 tools across nine areas (55 on a server that does not sign users in locally):

| Area | Tools |
|---|---|
| **Auth** | `tdx_get_current_user`, `tdx_sign_in` (local SSO servers only: opens the sign-in window from the chat) |
| **Tickets** | search, get, create, update, feed (get/add comment), tasks (get/create/update) |
| **Assets** | search, get, create, update, feed (get/add comment) |
| **CMDB / Config Items** | search, get, create, update, feed, relationships (get/add/remove), link to ticket |
| **Projects** | search, get, create, update, feed (get/add comment) |
| **Issues** | search, get, create, update |
| **People / Groups** | lookup, search, get, get UID by username, search groups, get group, get/add/remove members |
| **Reference data** | applications, accounts, locations, custom attributes, and two lookups with a `kinds` argument: ticket reference (types, statuses, priorities, sources, forms, impacts, urgencies) and asset reference (asset statuses, product models, CI types, CI relationship types) |
| **Reports** | list reports, get report data, list saved searches, run saved searches |

> **Maintenance:** Update this table in the same PR that adds or removes a tool.

All list/search tools support pagination (`limit`/`offset`, plus an opaque
`next_cursor`) and a `response_format` of `markdown` (human-readable, default)
or `json` (structured data in `structuredContent`). Responses are capped at
25,000 characters with a message telling the agent how to narrow the query or
paginate.

The server also exposes MCP **resources** (`tdx://applications`,
`tdx://{appId}/ticket-reference`; the app ID must be a positive integer) so hosts
can pin reference data to context without a tool round trip, and **prompts** (`triage_ticket`,
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
- **Names instead of IDs** — `app_id` takes an application name (`"Help Desk"`)
  as well as a number, and `status_ids`, `priority_ids`, `type_ids` and the
  create/edit equivalents take names (`"On Hold"`). A name matches exactly
  (ignoring case) or by a single partial match; anything else returns the valid
  choices, so the agent can correct itself in one turn.
- **`me`** — person arguments accept `"me"` for the signed-in user. It is only
  available when users sign in as themselves (SSO); a shared service account has
  no "me" and gets an error that says so.
- **Open and closed** — `is_open` and `status_classes` (for example
  `["on_hold"]`) filter on TeamDynamix status classes, because the API ignores
  `IsOpen` on ticket search.
- **Only the columns you need** — every search accepts `fields`
  (`["Title","StatusName"]`) and returns a table of just those plus the ID.
  Unknown names are reported with valid examples. `tdx_get_report` takes
  `columns`, `limit`, `offset` and `count_only`, and caches the run so paging
  does not execute the report again.
- **Large results stay whole** — a reply over the size limit is cut between
  records and says which `offset` to continue from. Saved searches page on the
  server, so a saved search of any size can be read in full.
- **Self-correcting errors** — when TeamDynamix rejects a create or update with
  a 400, the response appends the valid `status_id`/`type_id`/`priority_id`
  values for that application, read from cache only (never an extra API call).
- **Clickable records** — rendered tickets include a TDNext link derived from
  the configured base URL, so answers can be handed straight to a person.
- **Honest counts** — TeamDynamix search has no total-count endpoint, so a total
  rendered as `251+` means "at least", not "exactly". Use `count_only=true` for
  "how many" questions and `verbosity="compact"` to scan many records cheaply.

### Response format and payload size

A tool response is cut to fit the size limit at a record boundary, never mid-record:

- `markdown` (default) returns a single rendered text block.
- `json` returns the compact JSON as the text block (so a client that never shows `structuredContent` to the model still delivers it) plus the same object as `structuredContent`. Set `TDX_STRUCTURED_CONTENT=text` for a client that would show both.

An `outputSchema` is deliberately not declared. The MCP SDK requires
`structuredContent` on every result once a tool declares one, which would force
markdown responses to carry the full JSON payload as well.

## Install

The quickest route, with no clone:

```bash
npx -y teamdynamix-mcp-server init     # asks for your URL, signs you in, offers a default app, prints client config
```

`init` writes one per-user config file, `TDX_HOME/.env`, next to your tokens. The server looks for its `.env` in this order and uses the first that exists: `TDX_ENV_FILE`, `TDX_HOME/.env`, then the project folder (a clone). Real environment variables, such as a client's `env` block, always win.

Prefer a double-click install? Each release has a desktop extension bundle (`.mcpb`) that asks for your URL, signs in with SSO and needs no Node setup of its own. Build one with `npm run build && npm run pack:mcpb`.

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
| `TDX_TOOLSETS` | Optional. Comma-separated domains to keep (see Controlling the tool surface) |
| `TDX_APP_GATING` | Optional. `auto` (default) hides tools for applications the account lacks; `off` disables it |
| `TDX_APP_GATING_TIMEOUT_MS` | Optional. Start-up wait for the application list, 0–30000 (default 2500) |
| `TDX_DENY_TOOLS` | Optional. Comma-separated tool names to deny, overriding every other rule |
| `TEAMDYNAMIX_TOKEN_CACHE` | `memory` (default) or `file` to persist the JWT across short-lived processes (stored under `TDX_HOME/tokens`, mode `0600`) |
| `TEAMDYNAMIX_TIMEOUT_MS` | Per-request timeout; default `15000` |
| `TEAMDYNAMIX_MAX_SOCKETS` | Keep-alive connection pool size; default `8` |
| `TEAMDYNAMIX_MAX_RETRIES` | Retries for 503 responses; default `2` |
| `TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS` | Separate budget for 429 waits; default `3` |
| `TEAMDYNAMIX_MAX_RETRY_DELAY_MS` | Ceiling on any single retry wait; default `60000` |
| `TEAMDYNAMIX_RATE_LIMIT` | Outgoing requests allowed per window, per route; default `30` |
| `TEAMDYNAMIX_RATE_WINDOW_MS` | Rate limit window; default `60000` |
| `TEAMDYNAMIX_GLOBAL_RATE_LIMIT` | Optional ceiling across all routes, for servers that share an IP with other integrations; default `0` (off) |
| `TEAMDYNAMIX_MAX_QUEUE_WAIT_MS` | A call that would wait longer than this for a rate-limit slot fails at once instead of outliving the client's timeout; default `50000` |
| `TEAMDYNAMIX_COUNT_WINDOW` | Rows fetched for `count_only` searches, 251–1000; default `251`. Raise it only after confirming your tenant accepts the larger value (`npm run test:contract`) |
| `TDX_STRUCTURED_CONTENT` | `both` (default) or `text`; see Response format |
| `TDX_TIMEZONE` | IANA time zone for rendered dates; defaults to the server's |
| `TEAMDYNAMIX_CACHE_TTL_MS` | Reference-data cache TTL; default `600000`, `0` disables |
| `TEAMDYNAMIX_SEARCH_CACHE_TTL_MS` | Search page cache TTL; default `60000`, `0` disables |
| `TEAMDYNAMIX_RECORD_CACHE_TTL_MS` | Single-record and child-collection cache TTL; default `30000`, `0` disables |
| `TEAMDYNAMIX_CACHE_MAX_ENTRIES` | Bound on each cache; default `500` |
| `TDX_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`, or `silent`. Structured JSON logs go to stderr |
| `TRANSPORT` | `stdio` (default) or `http` |
| `HOST` | HTTP bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |
| `MCP_AUTH_TOKEN` | Bearer token for HTTP clients; required when `HOST` is not loopback, where it must be at least 24 characters |
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

The scripts sign in through the same code and configuration rules as the server, so if `npm run verify` succeeds the server will authenticate too, and a credentials mismatch (for example `TEAMDYNAMIX_AUTH_METHOD=admin` without `TEAMDYNAMIX_BEID` and `TEAMDYNAMIX_WS_KEY`) fails with the same message.

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

For a hosted deployment, set `HOST=0.0.0.0`, an `MCP_AUTH_TOKEN` of at least 24
characters (the server refuses to start with a shorter one on a non-loopback host;
generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`), and
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
| `read` | Changes nothing | `tdx_search_tickets`, `tdx_get_report` | allow |
| `create` | Adds new data; nothing existing is overwritten | `tdx_create_ticket`, `tdx_add_ticket_comment` | allow |
| `edit` | Overwrites fields on an existing record | `tdx_edit_ticket`, `tdx_edit_asset`, `tdx_edit_ci`, `tdx_edit_ticket_task` | **deny** |
| `destroy` | Deletes or unlinks existing data | `tdx_remove_group_members` | **deny** |

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
    "tdx_edit_ticket_task": "allow",
    "tdx_remove_group_members": "deny"
  },
  "treatReadModifyWriteAsDestroy": false
}
```

Rules are applied most specific first: `TDX_DENY_TOOLS`, then `TDX_ALLOW_TOOLS`,
then `TDX_TOOLSETS`, then `tools`, then `domains`, then `defaults`. A rule of `"inherit"` expresses no
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

### Controlling the tool surface

Some clients cap the number of tools they accept (GitHub Copilot in VS Code stops at 128 across all servers). Three layers keep this server's surface small; each only ever removes tools, none grants access.

1. **Policy** (above) — capability tiers, domains, allow and deny lists.
2. **`TDX_TOOLSETS`** — a coarse allowlist of domains, for example `TDX_TOOLSETS=tickets,people,reports`. Valid names: `tickets`, `assets`, `cmdb`, `projects`, `issues`, `people`, `reports`, `auth`. Authentication tools always stay. Reference lookups stay when they serve a listed domain; generic ones (accounts, locations, applications, custom attributes) always stay. It is evaluated after `TDX_DENY_TOOLS` and `TDX_ALLOW_TOOLS` and before `tools`, `domains` and `defaults`.
3. **Application gating** (`TDX_APP_GATING=auto`, the default) — at start-up the server reads `/applications` and does not register tools for an application kind the account lacks (Ticketing, Asset/CI, Projects). Set `TDX_APP_GATING=off` to disable it. `TDX_APP_GATING_TIMEOUT_MS` (default 2500) bounds how long start-up waits.

Prompts follow their tools: a prompt is offered only when every tool it uses is registered, so denying a tool or hiding its application also removes the prompts that depend on it.

Gating is a convenience, not a security boundary. It **fails open**: if the application list is unavailable, empty, or contains no recognized kind, every policy-allowed tool stays registered. A stdio server that could not resolve the list in time keeps retrying in the background and, once it succeeds, hides the unusable tools and sends a single `tools/list_changed`. Clients that ignore that notification keep their original list, and the server's instructions text stays as computed at start-up.

To see exactly what is registered and why, run `npm run tools:explain` (add `-- --offline` to skip the application lookup, or `-- --hidden` to list only unregistered tools). It prints application kinds, never application names.

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
| `npm run verify` | Authenticate (using the server's own login rules) and list all ticketing app IDs — run this first |
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

- **`app_id` is required** on most tools. It scopes requests to a specific TDX application (ticketing app, assets app, etc.). Run `npm run verify` or call `tdx_list_applications` to discover valid IDs.
- **Reference data first**: valid `type_id`, `status_id`, and `priority_id` values vary per org and per application. Use `tdx_get_ticket_reference` and `tdx_get_asset_reference` before creating or updating records.
- **Assets vs. CMDB**: Assets live at `/{appId}/assets/...`; Configuration Items live at `/{appId}/cmdb/...`. These are separate TDX namespaces with separate type/relationship systems.
- **Search vs. get**: `*_search` tools return partial records (no descriptions or custom attributes). Use the corresponding `*_get_*` tool for full details.
- **Custom attributes**: Pass `custom_attributes: [{ ID: number, Value: string }]` to create/update tools. Use `tdx_list_custom_attributes` (component_id=9 for tickets, 63 for assets/CIs) to discover IDs and valid choice values.
- **Reports**: `tdx_get_report` (with `with_data=true`) and `tdx_run_saved_search` are the most powerful read operations for complex queries — prefer these over chaining many search calls.
- **Rate limits**: TD commonly enforces 30–60 calls/60s per IP. The server auto-retries 429 and 503 responses with 2s then 4s exponential backoff before surfacing the error.

## Performance architecture

- **Connection reuse**: keep-alive HTTP(S) agents, so requests after the first
  skip the TLS handshake.
- **Proactive, per-route rate limiting**: TeamDynamix limits individual
  methods, so each route (`POST /{id}/tickets/search`) has its own sliding-window
  limiter that learns its real limit from `X-RateLimit-*` headers and holds until
  the stated reset plus a 5 s margin. A 429 waits for that reset, else
  `Retry-After`, else jittered backoff. A queued call reports progress when the
  client asked for it, and stops waiting when the client cancels; a write that
  was already sent is never aborted. A call that would wait longer than
  `TEAMDYNAMIX_MAX_QUEUE_WAIT_MS` fails at once with the time to retry.
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
  (mode `0600`, in the per-user state folder) so short-lived CLI processes skip the
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

## Migrating to 4.0

Every tool name changed prefix: `teamdynamix_search_tickets` is now `tdx_search_tickets`, and so on for all 55 existing tools. The part after the prefix is unchanged.

- Policy files, `TDX_ALLOW_TOOLS` and `TDX_DENY_TOOLS` that name a 3.x tool still work: each name is translated to its `tdx_` successor (a deny stays a deny) and a warning names the new name. Update them to silence it; `npm run policy:sync` rewrites `config/tool-policy.json`.
- Client-side allowlists (a VS Code or Claude Desktop tool filter, an agent's tool list) are not translated. Rename those by hand.
- Prompts and saved instructions that mention a tool by name need the new name.
- `run_saved_search` no longer takes `sort_order` (a saved search defines its own order) and `tdx_get_report` pages instead of printing 50 rows.
- Behaviour you may notice: `is_open` now returns what you expect, JSON responses carry the data in the text block, and dates render as ISO 8601 with a time zone.

## Upgrading to 3.1

- **File token cache:** if you use `TEAMDYNAMIX_TOKEN_CACHE=file`, the token file now lives under `TDX_HOME/tokens`. The first run signs in again; delete the old `tdx-mcp` folder in your temp directory.
- **HTTP on a network address:** `MCP_AUTH_TOKEN` must be at least 24 characters. Loopback servers are unchanged.
- **Scripts:** they now fail on a credentials mismatch the same way the server does.

## Migrating to 3.0

| Old tool | Replacement |
|---|---|
| `teamdynamix_list_ticket_types`, `_statuses`, `_priorities`, `_sources`, `_forms`, `_impacts`, `_urgencies` | `tdx_get_ticket_reference` with `kinds: ["types", "statuses", …]` (default `types`, `statuses`, `priorities`) |
| `teamdynamix_list_asset_statuses`, `_product_models`, `_ci_types`, `_ci_relationship_types` | `tdx_get_asset_reference` with `kinds: ["asset_statuses", "product_models", "ci_types", "ci_relationship_types"]` (default `asset_statuses`, `ci_types`) |

- Policy files, `TDX_ALLOW_TOOLS` and `TDX_DENY_TOOLS` that name an old tool still work: each old name is translated, a deny on any of them denies the replacement, and a warning on stderr names it. Update them to the new names to silence the warning.
- Client-side allowlists (for example a VS Code or Claude Desktop tool filter) are not translated; update them by hand.
- If one list in a request cannot be loaded, the others are still returned and that one shows an error line. If every list fails, the call fails.

## Contributing: sensitive-content check

This repository is public. A zero-dependency scanner (`scripts/check-sensitive.mjs`) blocks credentials, TeamDynamix key GUIDs, tenant URLs, JWTs, institutional email addresses, forbidden files and organization-specific terms. Organization terms are stored only as SHA-256 hashes in `config/sensitive-terms.sha256`, so the list itself reveals nothing.

```bash
npm run check:sensitive        # scan the whole tree
npm run check:package          # verify what `npm publish` would ship
npm run hooks:install          # run the scan on every commit
npm run sensitive:add-term     # add a term (masked prompt; never pass it as an argument)
```

Use `example`, `yourorg` or `test-` placeholders in code, tests, docs and issues. A finding prints a location and a masked excerpt, never the matched term. Credential-style and URL findings can be suppressed on the line with `sensitive-scan: allow <rule> — <reason>`; organization-term, metadata and forbidden-file findings cannot. CI runs the same scanner over the tree and the pushed range, plus gitleaks.

## Project Structure

```
src/
├── index.ts            # Loads config, picks a transport
├── lifecycle.ts        # When availability is resolved, servers are built, late pruning runs
├── server.ts           # One server instance: instructions, mounting, resources
├── shutdown.ts         # Signal handling
├── transports/         # stdio and Streamable HTTP adapters over the lifecycle
├── surface/
│   ├── catalog.ts      # Every tool and prompt the server ships
│   ├── resolve.ts      # Pure: which are registered, denied or hidden, and why
│   └── mount.ts        # The only code that registers them with the MCP SDK
├── config.ts           # Single zod-validated environment parse
├── constants.ts        # CHARACTER_LIMIT, pagination + search-window bounds
├── types.ts            # Shared TS interfaces, paginate(), cursor codec
├── framework/
│   ├── defineTool.ts   # Declarative tool contract: format policy, errors, caching, timing
│   ├── definePrompt.ts # Prompts as data, with the tools they use
│   └── annotations.ts  # READ / CREATE / EDIT / DESTROY capability presets
├── policy/
│   ├── index.ts        # Tool policy resolution and enforcement decisions
│   ├── load.ts         # Reads and validates the policy file and env overrides; legacy tool names
│   ├── availability.ts # Which application kinds the account has
│   └── schema.ts       # Zod schema for config/tool-policy.json
├── schemas/
│   └── common.ts       # Reusable Zod schemas (AppIdSchema, PagingShape, etc.)
├── services/
│   ├── client.ts       # Keep-alive, rate limiting, caching, dedup, retry
│   ├── errors.ts       # Auth, permission and policy error classes
│   ├── rate-limiter.ts # Per-route sliding-window limiters that learn from X-RateLimit-* headers
│   ├── request-context.ts # Cancellation and progress for the running tool call
│   ├── names.ts        # Application, reference and `me` names resolved to IDs before a handler runs
│   ├── budget.ts       # Size budget: responses are cut at record boundaries
│   ├── fields.ts       # `fields` projection and table rendering
│   ├── paged-search.ts # Server-side paging for saved searches
│   ├── cache.ts        # Bounded TTL-LRU (expired entries swept on write) + search keys + invalidation
│   ├── search.ts       # Cached search + client-side paging
│   ├── format.ts       # Renderers and truncation
│   └── logger.ts       # Structured stderr logging + counters
├── auth/               # Authorization adapters (service account, SSO), token stores, SSO lifecycle
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
scripts/               # verify, list-apps, search-tickets, smoke-test, bench, protocol test; auth.ts wraps the server login
config/                # tool-policy.json and its JSON schema
```

## License

MIT — see [LICENSE](LICENSE).


# TeamDynamix MCP Server

An MCP (Model Context Protocol) server that lets LLM agents interact with the
[TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) — tickets,
assets, configuration items (CMDB), projects, issues, people, groups, and reports.

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

All list/search tools support pagination (`limit`/`offset`) and a
`response_format` of `markdown` (human-readable, default) or `json`
(full structured data). Responses are capped at 25,000 characters with a
message telling the agent how to narrow the query or paginate.

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
| `TEAMDYNAMIX_AUTH_METHOD` | Optional. Force `user` or `admin` if both are set |
| `TEAMDYNAMIX_READ_ONLY` | Optional. Set exactly to `true` to omit all tools annotated as write-capable |
| `TRANSPORT` | `stdio` (default) or `http` |
| `HOST` | HTTP bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |
| `MCP_AUTH_TOKEN` | Bearer token for HTTP clients; required when `HOST` is not loopback |
| `MCP_ALLOWED_HOSTS` | Optional comma-separated HTTP Host allowlist, recommended for remote deployments |
| `MCP_ALLOWED_ORIGINS` | Optional comma-separated browser Origin allowlist |

If both auth methods are configured, admin key-based auth is preferred. The server
caches the JWT and auto-refreshes it ~1 minute before expiry (TD tokens last 24 hours).

`TEAMDYNAMIX_BASE_URL` is normalized to the API root used by the server. For a
standard organization URL, the server calls
`https://yourorg.teamdynamix.com/TDWebApi/api`. For a sandbox or organization
with a custom Web API path, provide that path explicitly, for example:

```dotenv
TEAMDYNAMIX_BASE_URL=https://cmich.teamdynamix.com/SBTDWebApi
```

This produces `https://cmich.teamdynamix.com/SBTDWebApi/api/auth/loginadmin`
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

The server exposes both data retrieval and environment-changing tools:

- **43 read tools** search, list, and retrieve TeamDynamix records. They declare
  `readOnlyHint: true`.
- **21 write tools** create, update, comment on, link, add, or remove records.
  They declare `readOnlyHint: false`; destructive updates/removals also declare
  `destructiveHint: true`.

Client approval remains controlled by the MCP host. VS Code, Claude, ChatGPT,
and OpenAI API applications can require confirmation before write calls. The
TeamDynamix account configured on the server must itself have permission for the
requested read or write operation.

### Read-only server mode

For a server instance that must not expose write operations, set:

```dotenv
TEAMDYNAMIX_READ_ONLY=true
```

In this mode, the server does not register any tool whose annotation is
`readOnlyHint: false`, so clients cannot discover or invoke those write tools.
This is an enforcement boundary inside the MCP server, not merely a client
approval hint. It is still best practice to use a dedicated TeamDynamix account
with only the required read permissions, because API credentials are an
independent defense layer. The default remains the full read/write tool set when
the variable is unset or has any value other than the exact string `true`.

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
| `npm run test:mcp` | Build and verify discovery of all 64 read/write tools over stdio and authenticated HTTP, including auth, origin, method, and CORS preflight checks |
| `npm run check:scripts` | Type-check all utility and protocol-test scripts |
| `npm run verify` | Authenticate and list all ticketing app IDs — run this first |
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

## Development

```bash
npm run dev      # tsx watch — no build step needed
npm run build    # tsc → dist/
npx @modelcontextprotocol/inspector node dist/index.js   # interactive tool testing
```

## Project Structure

```
src/
├── index.ts            # Entry point: transport selection + tool registration
├── types.ts            # Shared TS interfaces + paginate() helper
├── constants.ts        # CHARACTER_LIMIT, pagination defaults, getApiBaseUrl()
├── schemas/
│   └── common.ts       # Reusable Zod schemas (AppIdSchema, LimitSchema, etc.)
├── services/
│   ├── client.ts       # JWT auth/refresh, tdRequest(), 429/503 retry
│   └── format.ts       # toJsonText(), truncateMarkdown(), formatDate()
└── tools/
    ├── auth.ts
    ├── tickets.ts      # search, get, create, update, feed, tasks
    ├── assets.ts       # search, get, create, update, feed
    ├── cmdb.ts         # search, get, create, update, feed, relationships, link to ticket
    ├── projects.ts
    ├── issues.ts
    ├── people.ts       # lookup, search, groups
    ├── reference.ts    # all list_* lookup tools
    └── reports.ts      # list/get reports, list/run saved searches
scripts/
├── verify-connection.ts   # npm run verify
├── list-apps.ts           # npm run list-apps
└── search-tickets.ts      # npm run search-tickets
└── smoke-test.ts          # npm run smoke-test
```

## License

MIT — see [LICENSE](LICENSE).


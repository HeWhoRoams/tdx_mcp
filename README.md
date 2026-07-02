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
| `TEAMDYNAMIX_BASE_URL` | Your org's root URL, e.g. `https://yourorg.teamdynamix.com` |
| `TEAMDYNAMIX_BEID` | Admin service account BEID (found in TDAdmin → Organization) |
| `TEAMDYNAMIX_WS_KEY` | Admin service account Web Services Key |
| `TEAMDYNAMIX_USERNAME` | Standard user/service-account login (alternative to BEID) |
| `TEAMDYNAMIX_PASSWORD` | Password for user login |
| `TEAMDYNAMIX_AUTH_METHOD` | Optional. Force `user` or `admin` if both are set |

If both auth methods are configured, admin key-based auth is preferred. The server
caches the JWT and auto-refreshes it ~1 minute before expiry (TD tokens last 24 hours).

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

For hosted/remote deployments:

```bash
TRANSPORT=http PORT=3000 npm start
# Accepts POST requests at http://localhost:3000/mcp
```

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
      "description": "TeamDynamix base URL (e.g. https://yourorg.teamdynamix.com)"
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

## Utility Scripts

| Command | Description |
|---|---|
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


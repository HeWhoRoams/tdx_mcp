# TeamDynamix MCP Server

An MCP (Model Context Protocol) server that lets LLM agents interact with the
[TeamDynamix Web API](https://solutions.teamdynamix.com/TDWebApi/) — tickets,
assets/configuration items, projects, issues, people, and groups.

## Features

39 tools across six areas:

| Area | Tools |
|---|---|
| **Auth** | `teamdynamix_get_current_user` |
| **Tickets** | search, get, create, update, feed (get/add comment), tasks (get/create) |
| **Assets/CIs** | search, get, create, update, feed (get/add comment) |
| **Projects** | search, get, create, update, feed (get/add comment) |
| **Issues** | search, get, create, update |
| **People/Groups** | lookup, search people, get person, search groups, get group, get group members |
| **Reference data** | applications, ticket types/statuses/priorities/sources/forms, asset statuses, accounts |

All list/search tools support pagination (`limit`/`offset`) and a
`response_format` of `markdown` (human-readable, default) or `json`
(full structured data). Large responses are truncated defensively with a
message telling the agent how to narrow the query.

## Setup

```bash
npm install
npm run build
```

### Configuration

Copy `.env.example` to `.env` (or set these as real environment variables) and fill in:

- `TEAMDYNAMIX_BASE_URL` — your org's root URL, e.g. `https://yourorg.teamdynamix.com`
  (sandbox instances typically end in `teamdynamixpreview.com`).
- **Authentication** (pick one):
  - `TEAMDYNAMIX_USERNAME` + `TEAMDYNAMIX_PASSWORD` — acts as that user/service account.
  - `TEAMDYNAMIX_BEID` + `TEAMDYNAMIX_WS_KEY` — admin service account (key-based),
    found on TDAdmin's organization detail page.
  - If both are set, the server prefers admin auth; override with `TEAMDYNAMIX_AUTH_METHOD=user|admin`.

The server logs into TeamDynamix on first use, caches the returned JWT, and
automatically re-authenticates ~1 minute before it expires (TD tokens last 24
hours) or on a 401 response.

### Running

**stdio** (default — for Claude Desktop, Claude Code, etc.):

```bash
npm start
```

Example Claude Desktop config:

```json
{
  "mcpServers": {
    "teamdynamix": {
      "command": "node",
      "args": ["/absolute/path/to/teamdynamix-mcp-server/dist/index.js"],
      "env": {
        "TEAMDYNAMIX_BASE_URL": "https://yourorg.teamdynamix.com",
        "TEAMDYNAMIX_USERNAME": "your-service-account",
        "TEAMDYNAMIX_PASSWORD": "your-password"
      }
    }
  }
}
```

**Streamable HTTP** (remote/hosted):

```bash
TRANSPORT=http PORT=3000 npm start
# POST to http://localhost:3000/mcp
```

## Notes on the TeamDynamix API

- **`app_id`**: Most ticket and asset endpoints are scoped to a specific
  TeamDynamix "application" (e.g. a particular ticketing app or Assets/CI
  app). Call `teamdynamix_list_applications` first to discover valid IDs.
- **Reference data first**: creating tickets/assets/projects requires valid
  `type_id`/`status_id`/`priority_id` values, which vary per organization and
  per application. Use the `teamdynamix_list_*` tools before creating or
  updating records.
- **Search vs. get**: `*_search` tools return partial records (no
  descriptions/custom attributes) for performance, matching TD's own API
  behavior. Use the corresponding `*_get_*` tool for full details.
- **Rate limits**: TeamDynamix rate-limits most endpoints per IP (commonly
  30–60 calls/60s). The server surfaces `429` responses with a clear
  "rate limit exceeded" message rather than retrying silently.
- **Not covered**: file/attachment uploads (multipart), bulk import
  endpoints, time & expense tracking, knowledge base, service catalog, and
  admin/config endpoints (e.g. creating ticket types) are out of scope for
  this initial tool set. The API client (`src/services/client.ts`) is
  reusable if you want to add more tools for these.

## Development

```bash
npm run dev      # tsx watch mode
npm run build    # tsc build to dist/
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing
```

## Project Structure

```
src/
├── index.ts          # Entry point, transport selection, tool registration
├── types.ts           # Shared TS types + pagination helper
├── constants.ts        # CHARACTER_LIMIT, pagination defaults, base URL resolution
├── services/
│   ├── client.ts       # Auth (login/loginadmin), JWT caching, HTTP + error handling
│   └── format.ts        # Markdown/JSON formatting, truncation, date/name helpers
├── schemas/
│   └── common.ts        # Shared Zod fragments (response_format, limit, offset, app_id)
└── tools/
    ├── auth.ts
    ├── tickets.ts
    ├── assets.ts
    ├── projects.ts
    ├── issues.ts
    ├── people.ts
    └── reference.ts
```

# Review: TeamDynamix MCP Server

## Verdict

Solid foundation. The tool descriptions, annotations, and error handling are well above the bar for community MCP servers. There are a handful of real bugs to fix before production, and a few things worth hardening for remote deployments. Everything else is noise.

---

## Bugs to fix now

### 1. Pagination lies about `has_more`

**Files:** `src/tools/tickets.ts`, `assets.ts`, `cmdb.ts`, `projects.ts`, `issues.ts`, `people.ts`

Every search tool fetches `MaxResults: Math.min(offset + limit, 1000)` then calls `paginate()`. When `offset=0, limit=25`, it fetches 25 items. If 500 tickets exist, `has_more` is `false` because `paginate()` sees only 25 items. The agent stops paging and misses 475 results.

`paginate()` itself is fine — `has_more = all.length > offset + page.length` works correctly when it has the data. The bug is that we don't fetch enough to detect "more exists."

**Fix:** Fetch one extra item beyond the requested page. If the extra item is there, `has_more` is true.

```typescript
// In every search tool, change:
const fetchCount = Math.min(params.offset + params.limit, 1000);
// to:
const fetchCount = Math.min(params.offset + params.limit + 1, 1001);
```

That's it. Six one-line changes. Don't touch `paginate()`.

**Also fix `run_saved_search`** (`src/tools/reports.ts`): it has the same bug plus an uncapped `MaxResults: params.offset + params.limit` (no 1000 ceiling). Rewrite it to use `paginate()` and the same `fetchCount` pattern as the other search tools.

### 2. `search_cis` and `search_groups` don't send `MaxResults`

**Files:** `src/tools/cmdb.ts`, `src/tools/people.ts`

These two search tools build their request body without `MaxResults`, so TDX uses its own default (often 25). If an agent requests `limit=50`, it gets 25 results and `has_more: false`. Add `MaxResults: fetchCount` to both, same as every other search tool. This is fixed in the same pass as bug #1.

### 3. `list_custom_attributes` is the only tool missing `structuredContent`

**File:** `src/tools/reference.ts` (line 323)

Every other tool returns `structuredContent` alongside the text. This one doesn't. One-line fix:

```typescript
return { content: [{ type: "text" as const, text }], structuredContent: { items: attrs } as Record<string, unknown> };
```

### 4. Issue tool descriptions don't mention `app_id`

**File:** `src/tools/issues.ts`

All four issue tools require `app_id` in their schema, but none of their descriptions list it in the `Args:` section. An LLM reading the description won't know to provide it. Add `app_id (number): The application ID` to the Args section of `search_issues`, `get_issue`, `create_issue`, and `update_issue`.

### 5. CI doesn't run tests

**File:** `.github/workflows/ci.yml`

CI only runs `npm run build`. The protocol test (`test:mcp`) that validates tool count, annotations, and HTTP behavior isn't run. A PR can break any of those and still pass CI.

```yaml
      - run: npm run build
      - run: npm run check:scripts
      - run: npm run test:mcp
```

### 6. `express` and `@types/express` are wrong

**File:** `package.json`

The SDK installs Express 5, but `@types/express` is pinned to v4. The build passes only because `skipLibCheck` hides the mismatch. Add `express` as a direct dependency (it's currently transitive) and bump the types to v5:

```json
"dependencies": {
  "express": "^5.2.1"
},
"devDependencies": {
  "@types/express": "^5.0.0",
  "@types/express-serve-static-core": "^5.1.0"
}
```

---

## Harden for remote deployments

These aren't bugs — the server works fine on stdio and loopback HTTP. But if anyone exposes it remotely, do these first.

### 7. Add rate limiting

The SDK already bundles `express-rate-limit`. For non-loopback deployments, add a 60 req/min limiter on `/mcp` to match TDX's own rate limit and prevent proxy flooding.

### 8. Add a `/health` endpoint

Load balancers probe health endpoints. Without one, they hit `/mcp` and get a 405. One line:

```typescript
app.get("/health", (_req, res) => res.json({ status: "ok" }));
```

### 9. Use constant-time token comparison

The bearer token check uses `!==`, which is technically timing-attackable. For a loopback MCP server this doesn't matter. For a remote deployment with a bearer token, use `crypto.timingSafeEqual()`. Takes 5 minutes.

---

## Known limitations (document, don't fix)

- **Read-modify-write on CI/issue/task updates:** `update_ci`, `update_issue`, and `update_ticket_task` do GET → merge → PUT/POST. If the record changes between read and write, concurrent edits get clobbered. Ticket and asset updates use PATCH (JSON Patch operations), which is atomic. If TDX supports PATCH for CIs/issues/tasks, switch to that. If not, document the risk in the tool description.
- **Client-side pagination:** The TDX search API doesn't support server-side offset, so we fetch `offset + limit` items and slice. Deep paging (offset=500) is wasteful, and the 1000-item cap means you can't page beyond ~1000 results. This is a TDX API limitation, not a server bug.
- **`total` in PaginatedResult is the fetched count, not the true total.** TDX search doesn't return a total count. `has_more`/`next_offset` are the reliable pagination signals. Consider renaming `total` to `fetched_count` in a future breaking change.
- **No OAuth 2.1:** The README correctly documents this. Static bearer tokens are fine for single-tenant deployments; per-user delegation needs OAuth.

---

## Cut from the plan

These were in the previous version of this review. They're not worth the churn:

- **`outputSchema` on tools** — Nice to have, not a bug. Most MCP servers don't declare it. Add it later if clients ask for it.
- **`search_text` empty string validation** — TDX ignores empty search strings. Not worth touching 6 files.
- **`formatDate` in asset feed** — Cosmetic. One-line fix if you're already in the file, not worth a dedicated change.
- **Server instructions workflow guidance** — Tool descriptions already mention prerequisites. Adding workflow orchestration to server instructions is gilding the lily.
- **README tree formatting** — Trivial. Fix it next time you're editing the README.
- **Dependency version alignment** (`zod`, `@types/cors`) — Harmless. Fix next time you run `npm update`.
- **Structured logger** — `console.error` to stderr is correct for a stdio MCP server. Don't add a dependency for nothing.
- **`structuredContent` type casts** — The `as unknown as Record<string, unknown>` pattern is ugly but safe. A helper function would be cleaner but touches 9 files for zero behavioral change.
- **`get_ticket_task` single-task tool** — `get_ticket_tasks` + filter covers it. Don't add a 65th tool.
- **Asset/CI delete tools** — Intentionally omitted. Add a line to AGENTS.md "Out of Scope" if it isn't already there.

---

## Execution

This is a half-day of work, not a multi-phase project:

1. Fix the six `fetchCount` lines + `run_saved_search` rewrite (bugs #1, #2) — 30 min
2. Add `structuredContent` to `list_custom_attributes` (bug #3) — 2 min
3. Add `app_id` to four issue tool descriptions (bug #4) — 10 min
4. Update CI workflow (bug #5) — 5 min
5. Fix `package.json` dependencies (bug #6) — 5 min
6. Add rate limiting, health endpoint, constant-time comparison (#7-9) — 20 min
7. `npm install && npm run build && npm run test:mcp` — verify

Do bugs #1-6 in one PR. Do #7-9 in a second PR if you're not deploying remotely yet.
# Centrally Managed Hermes Per-User SSO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one loopback TDX MCP service per Hermes workspace, acting only as that workspace's assigned user through SSO and renewing TeamDynamix tokens without routine daily interaction.

**Architecture:** This is centrally managed but deliberately not a shared multi-user HTTP service. Each persistent Hermes workspace owns one expected user, one loopback MCP endpoint protected by a separate MCP access secret, one realm-specific TDX token store, and one existing CDP Chrome session. It reuses the local plan's SSO lifecycle through a Hermes CDP browser adapter; the server holds the TDX token and callers never forward it.

**Tech Stack:** TypeScript, Node.js, Express Streamable HTTP transport, Axios, Vitest, `playwright-core` CDP connection, Hermes Chrome DevTools Protocol.

**Spec:** [ADR 0001](../adr/0001-per-user-hermes-sso-boundary.md), [authentication glossary](../../GLOSSARY.md), and [local SSO plan](sso-user-auth.md).

## Global Constraints

- This deployment is one Hermes workspace, one assigned user, one loopback MCP service; do not implement shared multi-user JWT forwarding.
- The repository supports `admin`, `user`, and `sso`, but this deployment is implemented, tested, and approved for explicit `TEAMDYNAMIX_AUTH_METHOD=sso` only.
- Bind to `127.0.0.1` or `::1`, require a distinct `MCP_AUTH_TOKEN`, and use the existing stateless Streamable HTTP POST transport—never SSE.
- Store the TDX JWT only in owner-readable realm state; it must never appear in MCP request headers, chat, logs, browser output, or configuration.
- Require `TEAMDYNAMIX_SSO_EXPECTED_USER`; reject a token that `/auth/getuser` does not identify as that user.
- Use `hermes-cdp` only when explicitly configured; never discover or attach to an arbitrary browser endpoint.
- Use a renewal tab owned by the flow. Do not close, navigate, inspect, or modify unrelated Hermes browser tabs, cookies, downloads, or profile state.
- Use separate token state, browser namespace, cache namespace, and MCP access secret for sandbox and production.
- Production writes are never automatic test traffic; they require an explicit authorized acceptance step.

## Review Focus

- A sandbox token must never be accepted against production, even when the user and issuer look similar.
- A CDP timeout or detached browser must preserve the existing valid token and report only a credential-free diagnostic.
- Concurrent Hermes tasks must share a single renewal attempt rather than open duplicate SSO tabs.
- A caller without the MCP access secret must be rejected before it reaches the MCP transport.
- A renewal tab must be cleaned up without affecting pre-existing Hermes tabs.

---

## File Structure

- Modify: `src/config.ts` — Hermes CDP adapter settings and strict loopback/SSO/secret validation.
- Modify: `src/auth/paths.ts` — realm-isolated workspace state namespaces.
- Create: `src/auth/hermes-cdp-browser.ts` — CDP-backed implementation of the shared browser-session interface.
- Modify: `src/auth/sso-browser.ts` — browser adapter factory and explicit `local`/`hermes-cdp` selection.
- Modify: `src/auth/sso-renewal.ts` — adapter-neutral single-flight lifecycle, timer, retry classification, and audit hooks.
- Modify: `src/services/client.ts` and `src/services/cache.ts` — realm/identity cache reset integration.
- Modify: `src/index.ts` — start the lifecycle for HTTP SSO and enforce the separate MCP access secret on loopback Hermes deployments.
- Create: `scripts/hermes-sso-compat.ts` — sandbox-only, non-secret live compatibility gate.
- Test: new CDP adapter, lifecycle, config, HTTP auth, and compatibility-script tests.
- Modify: `README.md`, `.env.example`, `AGENTS.md`, and Hermes deployment documentation.

### Task 1: Define the Hermes deployment configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Adds SSO browser settings `browserAdapter: "hermes-cdp"` and `cdpEndpoint`.
- Requires SSO expected user, loopback host, and MCP access secret when the Hermes adapter is selected.

- [ ] Write failing config tests for a valid Hermes SSO deployment and for each rejected condition: non-loopback host, missing MCP secret, missing expected user, missing/invalid CDP endpoint, or any auth method other than SSO.
- [ ] Add explicit configuration fields for `hermes-cdp`, its endpoint, renewal lead time, and retry bounds; preserve `admin` and `user` parsing without declaring them Hermes-supported.
- [ ] Make the generated config keep normalized API base URL as the realm key and never serialize any secret in diagnostics.
- [ ] Run `npm test -- test/config.test.ts` and confirm it passes.

### Task 2: Implement the Hermes CDP browser adapter

**Files:**
- Create: `src/auth/hermes-cdp-browser.ts`
- Modify: `src/auth/sso-browser.ts`
- Test: `test/hermes-cdp-browser.test.ts`

**Interfaces:**
- Implements the shared `SsoBrowserSession` contract from the local plan.
- Connects only to the configured CDP endpoint and exposes `mintToken(): Promise<string>`.

- [ ] Write failing mock-CDP tests proving the adapter creates one renewal tab, observes only the configured realm's `/auth/loginsso` response/body, and closes only that tab.
- [ ] Connect with `playwright-core.chromium.connectOverCDP(cdpEndpoint)`; do not launch a browser or enumerate/inspect unrelated pages.
- [ ] Navigate the renewal tab to `loginSsoUrl(apiBaseUrl)`, capture a token with `extractJwt()`, and return no page text, response body, cookie, or token in thrown errors.
- [ ] Classify detached-CDP and timeout errors as transient; classify an SSO/MFA login page requiring interaction as a policy failure.
- [ ] Run `npm test -- test/hermes-cdp-browser.test.ts` and confirm it passes with no live CDP connection.

### Task 3: Apply realm and identity isolation to the shared lifecycle

**Files:**
- Modify: `src/auth/paths.ts`
- Modify: `src/auth/sso-renewal.ts`
- Modify: `src/services/token-store.ts`
- Modify: `src/services/cache.ts`
- Test: `test/sso-renewal.test.ts`, `test/sso-store-and-client.test.ts`

**Interfaces:**
- Uses normalized API base URL plus expected user as an identity-binding/cache namespace.
- Emits credential-free authentication audit events.

- [ ] Write failing tests for sandbox/production state separation, mismatched expected user rejection, token replacement preserving the old token on failure, and cache removal before an intentional identity binding change.
- [ ] Scope all stored state and cache invalidation to the active realm and expected user; do not derive identity from unverified JWT claims.
- [ ] Log renewal start/success/failure with timestamp, realm, expected/effective UID, method, and redacted reason only.
- [ ] Run `npm test -- test/sso-renewal.test.ts test/sso-store-and-client.test.ts` and confirm it passes.

### Task 4: Enforce the loopback MCP boundary and start renewal

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/client.ts`
- Test: `test/http-auth.test.ts`, `test/sso-store-and-client.test.ts`

**Interfaces:**
- HTTP calls require `Authorization: Bearer <MCP_AUTH_TOKEN>` before MCP dispatch.
- `TeamDynamixClient` obtains its SSO credential only from the lifecycle/token store.

- [ ] Write failing HTTP tests proving a missing or incorrect MCP secret is rejected and that its value is not a TeamDynamix JWT.
- [ ] Start the SSO renewal lifecycle once during Hermes HTTP startup; reuse its single-flight token resolution for all simultaneous tool calls.
- [ ] Keep Streamable HTTP JSON POST behavior unchanged and do not add SSE, CORS browser UI, or per-request TeamDynamix bearer forwarding.
- [ ] Run `npm test -- test/http-auth.test.ts test/sso-store-and-client.test.ts` and `npm run test:mcp`.

### Task 5: Build and run the Hermes CDP compatibility gate

**Files:**
- Create: `scripts/hermes-sso-compat.ts`
- Modify: `package.json`
- Test: `test/hermes-sso-compat.test.ts`

**Interfaces:**
- Adds `npm run test:hermes-sso -- --realm sandbox`.
- Returns concise pass/fail statuses and never prints credentials or browser content.

- [ ] Write tests for command validation, sandbox-only default behavior, redaction, and rejection of production unless an explicit operator flag is supplied.
- [ ] Implement the live sequence: attach to configured CDP, capture the initial unrelated tab set, create one renewal tab, mint and validate a sandbox token through `/auth/getuser`, mint a second token without additional interaction, close the renewal tab, and compare the unrelated tab set.
- [ ] Record only audit-safe evidence: effective UID, realm, token expiry timestamp, and tab non-interference result.
- [ ] Run the script manually in the assigned Hermes sandbox workspace before enabling automatic renewal.

### Task 6: Roll out with controlled evidence

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Create: `docs/operations/hermes-sso-rollout.md`

- [ ] Document the owner-readable configuration and secret-file contract without showing real values: SSO mode, expected user, loopback host, MCP access secret, CDP endpoint, and realm-specific state locations.
- [ ] Document `SSO_ACTION_REQUIRED`, ordinary logout, full sign-out, transient retry behavior, and the audit event fields.
- [ ] Run sandbox compatibility and read-only MCP acceptance tests first.
- [ ] Run production identity validation with read-only tools, then perform one separately authorized production write; verify in TDNext that the expected user is recorded as the actor.
- [ ] Run `npm run build`, `npm test`, and `npm run test:mcp`; archive only credential-free rollout evidence.

## Completion Evidence

- The Hermes endpoint is loopback-only, rejects callers lacking its independent MCP access secret, and remains stateless at the MCP transport layer.
- The TeamDynamix token remains server-held, realm-bound, expected-user-bound, and absent from logs/MCP request data.
- Sandbox CDP compatibility proves non-interference and silent second minting; production promotion proves the expected user identity and audit attribution.
- `admin` and `user` configuration continues to parse and work in their existing supported contexts, while Hermes documentation clearly labels SSO as the only approved path.

# Local User SSO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local MCP server act as its signed-in TeamDynamix user, retain that identity safely, and renew it without routine daily interaction when the user's IdP session permits.

**Architecture:** The repository retains three explicit authentication methods—`admin`, `user`, and `sso`—but this plan delivers the `sso` path. A shared SSO lifecycle validates and atomically stores realm-bound tokens; the local browser adapter uses a dedicated persistent local browser profile. The lifecycle owns proactive and lazy renewal, while the client only consumes the current validated token.

**Tech Stack:** TypeScript, Node.js, Axios, Vitest, optional `playwright-core`, TeamDynamix Web API.

**Spec:** [ADR 0001](../adr/0001-per-user-hermes-sso-boundary.md) and [authentication glossary](../../GLOSSARY.md).

## Global Constraints

- Keep `admin` (BEID/key), `user` (username/password), and `sso` as explicit configuration methods; never silently fall back between them.
- Local SSO stays on stdio or loopback HTTP; it does not become a shared hosted service.
- A fresh SSO token is accepted only after `/auth/getuser` validates it and it matches `TEAMDYNAMIX_SSO_EXPECTED_USER` when configured.
- Sandbox and production tokens, browser state, and caches remain isolated by normalized API base URL.
- Never log or return a JWT, browser cookie, password, or `MCP_AUTH_TOKEN`.
- Retain the old token until its validated replacement is atomically stored; only one renewal runs per realm at a time.
- MFA, Conditional Access, or other interactive policy requirements produce `SSO_ACTION_REQUIRED`; they never trigger a password/token prompt through MCP.

## Review Focus

- A valid token from `SBTDWebApi` must never be stored or used for `TDWebApi`.
- A 401 from an authorized API call can be a permissions denial; it must not discard an otherwise valid SSO token.
- A token for another TeamDynamix user must be rejected before it overwrites the expected user's state.
- A failed or interrupted renewal must leave a still-valid prior token usable.
- A full sign-out must remove both the current token and the dedicated local browser profile, while ordinary logout removes only the token.

---

## File Structure

- Modify: `src/config.ts` — explicit auth-mode and local SSO lifecycle configuration.
- Modify: `src/auth/paths.ts` — realm-scoped state paths for token and local browser profile storage.
- Modify: `src/auth/sso-login.ts` — JWT extraction, TeamDynamix validation, identity binding, and stable errors.
- Create: `src/auth/sso-browser.ts` — narrow browser-adapter contract and local Playwright implementation.
- Create: `src/auth/sso-renewal.ts` — token replacement, single-flight renewal, schedule, retry classification, and action-required state.
- Modify: `src/services/token-store.ts` — atomic SSO writes, cross-process reload, and cache reset on a deliberate identity change.
- Modify: `src/services/client.ts` — obtain SSO tokens from the lifecycle and distinguish expiry/revocation from permissions errors.
- Modify: `src/cli/auth-cli.ts`, `src/index.ts`, `package.json` — local login, logout, full sign-out, and identity status commands.
- Test: `test/sso-login.test.ts`, `test/sso-store-and-client.test.ts`, `test/config.test.ts`, plus new browser/lifecycle tests.
- Modify: `README.md`, `.env.example`, and `AGENTS.md` — local configuration and operational guidance.

### Task 1: Lock down the shared SSO configuration contract

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces `Config["auth"]` SSO fields: `expectedUser`, `browserAdapter: "local"`, renewal lead time, and retry bounds.
- Preserves `Config["auth"]` variants for `admin` and `user`.

- [ ] Add failing config tests covering explicit SSO selection, missing expected-user warnings for local use, ignored inactive credentials, invalid SSO adapter values, and the existing admin/user credential rules.
- [ ] Make configuration reject ambiguous or unsupported SSO combinations while preserving existing explicit `admin` and `user` behavior.
- [ ] Make `browserAdapter: "local"` the local default; reserve `hermes-cdp` for the separate Hermes plan.
- [ ] Run `npm test -- test/config.test.ts` and confirm the new contract passes.

### Task 2: Extract a local browser adapter

**Files:**
- Create: `src/auth/sso-browser.ts`
- Modify: `src/auth/sso-login.ts`
- Modify: `src/auth/paths.ts`
- Test: `test/sso-browser.test.ts`

**Interfaces:**
- Produces `SsoBrowserSession` with `mintToken(): Promise<string>` and `close(): Promise<void>`.
- Consumes `loginSsoUrl(apiBaseUrl)` and a realm-specific browser state directory.

- [ ] Write failing tests for the adapter factory: local adapter receives the dedicated profile directory, the selected installed browser channel, and interactive/headless timeouts.
- [ ] Move Playwright-specific launch and page-observation behavior out of `interactiveLogin()` into the local adapter.
- [ ] Keep `extractJwt()` as the only token parser and make the adapter close only the browser context it created.
- [ ] Run `npm test -- test/sso-login.test.ts test/sso-browser.test.ts` and confirm it passes without a real browser.

### Task 3: Implement the shared renewal lifecycle

**Files:**
- Create: `src/auth/sso-renewal.ts`
- Modify: `src/auth/sso-login.ts`
- Modify: `src/services/token-store.ts`
- Test: `test/sso-renewal.test.ts`, `test/sso-store-and-client.test.ts`

**Interfaces:**
- Produces `SsoRenewalManager.getUsableToken(): Promise<string>` and `SsoRenewalManager.start(): void`.
- Produces `SsoActionRequiredError`, surfaced verbatim to MCP callers.
- Consumes `SsoBrowserSession`, `SsoTokenStore`, `buildStoredToken()`, and the configured realm/expected user.

- [ ] Write failing tests for validated replacement, old-token preservation on a failed renewal, realm/expected-user rejection, and one shared renewal promise for concurrent callers.
- [ ] Implement renewal to mint a token, call `/auth/getuser`, enforce identity binding, then atomically write the replacement.
- [ ] Schedule renewal 60 minutes before expiry; recalculate after every accepted token and retry only bounded transient browser/network failures while the old token remains valid.
- [ ] Turn sign-in, MFA, and Conditional Access failures into `SSO_ACTION_REQUIRED` with no automatic retry.
- [ ] Run `npm test -- test/sso-renewal.test.ts test/sso-store-and-client.test.ts` and confirm it passes.

### Task 4: Integrate SSO lifecycle with the client and local commands

**Files:**
- Modify: `src/services/client.ts`
- Modify: `src/cli/auth-cli.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Test: `test/sso-store-and-client.test.ts`, `test/client.test.ts`

**Interfaces:**
- `TeamDynamixClient` consumes `SsoRenewalManager` only when `auth.method === "sso"`.
- CLI supports `login`, `whoami`, `logout`, and `logout --all`.

- [ ] Add failing tests for lazy renewal after a process restart, expired-token action-required behavior, permission-401 token retention, and revocation-401 token removal.
- [ ] Start the renewal manager during SSO server startup; preserve normal token-store behavior for `admin` and `user`.
- [ ] Keep ordinary logout token-only and make `logout --all` remove the dedicated browser profile after the token is removed.
- [ ] Run `npm test -- test/sso-store-and-client.test.ts test/client.test.ts` and `npm run build`.

### Task 5: Document and verify local SSO

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Test: existing full suite

- [ ] Document the three supported configuration methods, marking SSO as the only method delivered by this plan.
- [ ] Document local `login`, `whoami`, `logout`, `logout --all`, expected-user binding, silent renewal, and `SSO_ACTION_REQUIRED` recovery without including secrets.
- [ ] Run `npm run test:all`.
- [ ] Perform sandbox acceptance: interactive sign-in, `whoami`, read-only tool call, silent second mint from the retained browser session, expected-user mismatch rejection, and full sign-out.

## Completion Evidence

- `npm run build`, `npm test`, and `npm run test:mcp` pass.
- A sandbox SSO token is accepted only for the configured expected user and realm.
- A valid local browser session mints a replacement token without user interaction; an enforced MFA challenge safely reports `SSO_ACTION_REQUIRED`.

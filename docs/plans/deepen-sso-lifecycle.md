> **Note (2026-10-23):** Wording on policy failures is superseded by decision D1 in `sso-review-remediation.md`: a policy failure blocks automatic renewal, but a still-valid token keeps being served until it expires; SSO action required applies only when no usable token remains.

# Deepen the SSO Lifecycle Implementation Plan

## Goal

Replace distributed SSO orchestration with one deep lifecycle module. Its small interface owns Server-held token state, identity binding, browser-adapter selection, silent renewal, action-required recovery, sign-out, status, and credential-free audit events. The TeamDynamix transport receives an opaque credential capability; local and external Hermes callers share the same lifecycle.

This plan preserves the glossary and [ADR 0001](../adr/0001-per-user-hermes-sso-boundary.md): one Hermes workspace and one MCP process per Expected user, loopback-only external hosting, an independent MCP access secret, and no TeamDynamix token forwarding.

## Decisions

- `TEAMDYNAMIX_MCP_DEPLOYMENT=local|external` is the sole deployment selector. There is no compatibility alias.
- The composition root is the only place that reads resolved SSO configuration and creates lifecycle dependencies.
- The lifecycle is the interface for CLI and TeamDynamix transport: `start`, `stop`, `login`, `status`, `signOut`, and an opaque request-authorization operation. It does not broadly return a JWT string.
- Local and Hermes CDP are two real Browser adapter implementations at one seam.
- Credential state is lifecycle-owned: `usable`, `renewal-pending`, `action-required`, ordinary sign-out, and full sign-out. `SsoTokenStore` becomes a persistence adapter.
- Only interactive `login` may clear `action-required`. Scheduled/lazy renewal, status, and tool calls never clear it.
- Transient renewal uses bounded exponential backoff; it preserves and reschedules a still-valid credential. MFA, Conditional Access, identity mismatch, and invalid token transitions directly to `action-required`.
- State migration accepts a legacy realm-only token only after `/auth/getuser` verifies it against the configured Expected user. Otherwise it remains untouched and the lifecycle requires login.
- Caches use a verified identity namespace: normalized realm plus Expected user and effective UID. This supplements cache purge on deliberate identity changes.
- External Hermes `logout --all` removes lifecycle token/state only and reports browser-session revocation as operator-managed. It never modifies the workspace browser profile. Local full sign-out still removes the dedicated local browser profile.
- `login --paste` remains local-only. External recovery uses the configured Hermes renewal tab after an operator-managed browser action.
- `admin` and `user` retain their current construction path and never instantiate an SSO lifecycle.
- Extracting the HTTP transport host is a deferred enhancement, described at the end of this document.

## Target module shape

```text
composition root
  └─ resolved SSO deployment
       └─ SsoLifecycle
            ├─ CredentialState persistence adapter
            ├─ Browser adapter: local | Hermes CDP
            ├─ TeamDynamix identity-validation adapter
            ├─ identity-namespaced cache adapter
            └─ credential-free audit adapter

CLI ────────────────┐
TeamDynamix transport ─┼─> SsoLifecycle interface
compatibility gate ───┘
```

`SsoLifecycle` is deep: callers learn a few intent-level operations, while timers, atomic replacement, browser cleanup, retry classification, marker state, cache identity, and audit sequencing stay in its implementation.

## Task 1 — Define resolved deployment and lifecycle interfaces

**Files:** `src/config.ts`, new `src/auth/sso-deployment.ts`, new `src/auth/sso-lifecycle.ts`, tests in `test/config.test.ts` and `test/sso-lifecycle.test.ts`.

- [ ] Write failing tests for resolved local and external deployment objects, including rejection of any obsolete `TEAMDYNAMIX_SSO_DEPLOYMENT` value and all external Hermes requirements.
- [ ] Move SSO-specific configuration assembly out of `getConfig()` and remove `getSsoCliSettings()`.
- [ ] Create `ResolvedSsoDeployment` with normalized realm, Expected user, deployment mode, browser adapter settings, renewal policy, state namespace, and MCP deployment constraints.
- [ ] Define an opaque authorization capability consumed by TeamDynamix transport; it performs authorized requests or supplies request headers internally without exposing the JWT to arbitrary callers.
- [ ] Define lifecycle operations: `start()`, `stop()`, `login()`, `status()`, `signOut({ full })`, and authorization through the opaque capability.
- [ ] Define stable lifecycle errors, including `SsoActionRequiredError`, without browser body, cookie, JWT, or secret content.
- [ ] Run focused config and lifecycle-interface tests.

## Task 2 — Model credential state and persistence adapters

**Files:** new `src/auth/credential-state.ts`, `src/services/token-store.ts`, `src/auth/paths.ts`, `src/services/cache.ts`, tests in `test/sso-state.test.ts` and `test/sso-store-and-client.test.ts`.

- [ ] Write failing transition tests for usable credential, scheduled renewal, transient failure with a still-valid credential, policy failure, revocation, ordinary sign-out, local full sign-out, external full sign-out, and interactive recovery.
- [ ] Move `.action-required` semantics from `SsoTokenStore` behind a `CredentialState` persistence adapter.
- [ ] Make persistence atomically retain the old credential until replacement validation succeeds.
- [ ] Create an identity namespace from normalized realm plus Expected user; append verified effective UID only after `/auth/getuser` validation.
- [ ] Make cache access accept this verified namespace, then test that sandbox/production and identity changes cannot reuse cache entries.
- [ ] Add safe legacy state discovery. Validate a legacy token with `/auth/getuser`; migrate only after Expected-user match, otherwise do not alter it.
- [ ] Run state, token-store, and cache tests.

## Task 3 — Move browser and token-validation behavior behind lifecycle dependencies

**Files:** `src/auth/sso-browser.ts`, `src/auth/hermes-cdp-browser.ts`, `src/auth/sso-login.ts`, `src/auth/sso-lifecycle.ts`, tests in `test/sso-browser.test.ts`, `test/hermes-cdp-browser.test.ts`, and `test/sso-lifecycle.test.ts`.

- [ ] Write failing lifecycle tests using fake Browser adapters for local and Hermes paths; prove one shared renewal attempt, owned-tab cleanup, realm filtering, and no token-bearing diagnostics.
- [ ] Keep the two Browser adapter implementations narrow: create a session, mint a candidate token, close only owned resources.
- [ ] Move candidate-token validation and Expected-user matching behind a TeamDynamix identity-validation adapter.
- [ ] Classify timeout/detached CDP/network failures as transient; classify MFA, Conditional Access, identity mismatch, and invalid tokens as action-required.
- [ ] Implement bounded exponential backoff with injected clock/scheduler dependencies for deterministic tests.
- [ ] Preserve a valid old credential on transient failure and reschedule it. Persist action-required immediately for policy failures.
- [ ] Run browser and lifecycle tests without a real browser.

## Task 4 — Add composition root and integrate callers

**Files:** new `src/auth/sso-composition.ts`, `src/services/client.ts`, `src/cli/auth-cli.ts`, `src/index.ts`, `scripts/auth.ts`, tests in `test/sso-store-and-client.test.ts`, `test/client.test.ts`, and CLI-focused tests.

- [ ] Write failing tests proving that one lifecycle instance starts for SSO and is injected into every TeamDynamix transport client; concurrent tool calls share renewal single-flight.
- [ ] Make `TeamDynamixClient` depend on the opaque authorization capability, not `SsoRenewalManager`, `SsoTokenStore`, browser selection, or raw SSO configuration.
- [ ] Make CLI commands call lifecycle operations: `login` validates and stores; `whoami` returns credential-free lifecycle status; `logout` transitions ordinary sign-out; local `logout --all` removes only its owned profile; external `logout --all` reports the operator action.
- [ ] Reject external `login --paste`; preserve local paste behavior.
- [ ] Ensure `admin` and `user` follow their existing path and prove they do not instantiate the composition root.
- [ ] Run client and CLI regression tests.

## Task 5 — Audit stream and compatibility gate

**Files:** `src/auth/sso-lifecycle.ts`, `src/services/logger.ts`, `scripts/hermes-sso-compat.ts`, `package.json`, tests in `test/hermes-sso-compat.test.ts`.

- [ ] Write failing tests for stable credential-free events: `login`, `renewal_started`, `renewal_succeeded`, `renewal_transient_failure`, `action_required`, and `logout`.
- [ ] Keep logger formatting outside the lifecycle; inject an audit adapter and assert no token, cookie, browser body, password, or MCP access secret appears in emitted fields.
- [ ] Rewrite the Hermes compatibility gate to drive the production lifecycle interface in sandbox-only mode.
- [ ] Require `--realm sandbox`; require a separate explicit production flag; report only realm, effective UID, expiry, and owned-tab non-interference evidence.
- [ ] Run compatibility script unit tests and the sandbox gate manually in the assigned Hermes workspace.

## Task 6 — Documentation, migration, and rollout

**Files:** `README.md`, `.env.example`, `AGENTS.md`, `docs/operations/hermes-sso-rollout.md`, `docs/plans/sso-user-auth.md`, `docs/plans/multi-user-remote.md`.

- [ ] Document the lifecycle as the owner of token state and recovery, and show `TEAMDYNAMIX_MCP_DEPLOYMENT` as the sole deployment selector.
- [ ] Document migration: back up owner-readable state, first start validates/migrates only a verified legacy token, failure leaves it untouched, and `npm run login` is the recovery path.
- [ ] Document rollback: stop the MCP process, restore the prior state file/profile, and remove the new lifecycle state only after confirming the prior version is active.
- [ ] Document local versus external full sign-out behavior and the external operator-managed browser-session action.
- [ ] Run sandbox compatibility, then loopback read-only external MCP acceptance with the independent MCP access secret before enabling automatic Hermes renewal.
- [ ] Perform a separately authorized production read-only identity check before any production write.

## Verification matrix

| Area | Evidence |
| --- | --- |
| Configuration | Local/external resolution; external fail-closed; obsolete selector rejected |
| State | All transition causes, legacy migration, atomic replacement, realm/identity cache isolation |
| Browser | Local profile ownership; Hermes owned-tab non-interference; no sensitive diagnostics |
| Lifecycle | Single-flight, deterministic backoff, policy action-required, explicit recovery |
| Callers | CLI and TeamDynamix transport share the lifecycle; admin/user regression coverage |
| External | MCP access secret rejection before dispatch; sandbox compatibility and read-only acceptance |
| Quality gates | `npm test`, `npm run check:scripts`, `npm run build`, `npm run test:mcp`, then manual sandbox evidence |

## Deferred enhancement — HTTP transport host

After this plan is complete, extract HTTP startup from `src/index.ts` into a deep host module with a small `start`/`close` interface. The existing stdio and Streamable HTTP implementations are two real adapters at that seam. Acceptance criteria: CORS/origin policy, MCP access-secret checks, rate limiting, health endpoints, per-request transport lifetime, shutdown, and warm-up each have focused host tests; `index.ts` becomes deployment selection only.

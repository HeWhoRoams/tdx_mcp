# Plan: Remediate the SSO branch code review

Status: proposed · Branch: `feat/sso-user-auth` (uncommitted, base `main` 3f4e4e1) · Review date: 2026-10-23
Inputs: the two-axis review (Standards and Spec), checked against the code. Specs: [sso-user-auth](sso-user-auth.md), [deepen-sso-lifecycle](deepen-sso-lifecycle.md), [multi-user-remote](multi-user-remote.md), [ADR 0001](../adr/0001-per-user-hermes-sso-boundary.md), [GLOSSARY](../../GLOSSARY.md).

This plan **does not replace** deepen-sso-lifecycle. Many findings are that plan's unchecked tasks. Each item below names the deepen task it completes, so nothing is built twice.

---

## 0. Finding register

| ID | Axis | Finding | Severity | Phase |
|---|---|---|---|---|
| P1 | Spec | A policy failure during the renewal lead window makes a still-valid token unusable (`SsoRenewalManager.getUsableToken`) | **Critical** | R1 |
| P3 | Spec | The 401 probe treats timeouts, 429s and 5xx as "revoked", and `execute()` then deletes the token | **Critical** | R1 |
| P3b | Spec (new during verification) | The 401 path calls `tokens.clear()` unconditionally, so it can delete a token that another process or a renewal just wrote | **Critical** | R1 |
| P4 | Spec | `SsoTokenStore.write()` always lifts the action-required block, so a renewal still in flight when you log out signs you back in | **High** | R1 |
| P6 | Spec | Renewal checks the tenant but not the user, so with no expected user set, renewal can switch identity | **High** | R1 |
| P2 | Spec | Temporary failures (no response, CDP unavailable, timeout) are classed as policy failures; retries have no backoff | **High** | R1 |
| P5 | Spec | Single-flight renewal is per process only; there's no lock across processes, and the shared browser profile can't be opened twice | **High** | R2 |
| G1 | Spec | No opaque authorization handle: the client holds the raw JWT and clears the store itself | Medium | R3 |
| G2 | Spec | The cache namespace doesn't include the effective UID | Medium | R3 |
| G3 | Spec | No migration of saved state from the Phase 1 layout | Medium | R4 |
| G4 | Spec | The Hermes compat gate neither compares unrelated tabs nor forces a second mint | Medium | R4 |
| G5 | Spec | External `logout --all` doesn't report the operator action | Low | R4 |
| G6 | Spec | Planned tests missing: `sso-lifecycle`, `http-auth`, `hermes-sso-compat`, `client` additions | Medium | R1–R4 |
| S1 | Standards (hard) | `getApiBaseUrl`, `getTdxHome` and `getSsoCliSettings` read `process.env` outside the validated parse. `LOCALAPPDATA`/`XDG_STATE_HOME` aren't in the schema; `raw.TDX_HOME` is unused; `getSsoCliSettings` silently coerces invalid values | High | R3 |
| S2 | Standards (hard) | New `process.env` reads in `scripts/auth.ts` (older reads predate this change) | Low | R3 |
| S3 | Standards (hard) | `index.ts` routes CLI commands, against AGENTS.md "index.ts only selects a transport"; Build & Run is missing `login`/`logout`/`whoami`/`test:hermes-sso` | Low | R5 |
| X1 | Spec (scope) | vitest ^4 → ^5 major bump | Low | R0 |
| X2 | Spec (scope) | `scripts/find-my-latest-ticket.ts` is unrelated | Low | R0 |
| X3 | Both | Line-ending-only rewrites of six or more files hide the real diff | Medium | R0 |
| M* | Standards (smells) | See §R3.6. Each is a judgement call | Low | R3 |
| — | Dropped | "Duplicate `getApiBaseUrl`": `src/constants.ts` re-exports `config.ts`'s, so this is not duplication | — | — |

## 1. Decisions needed from Tim (defaults are in **bold**)

- **D1. Policy failure while the token is still valid.** The specs pull two ways. "A failed or interrupted renewal must leave a still-valid prior token usable" (sso-user-auth) and "MFA/Conditional Access … transitions directly to action-required" (deepen). **Default: split the state.** A policy failure blocks *automatic renewal* immediately, so no more browser launches happen, but the current token is still served until it expires. The state is `renewal-blocked`. *Action-required* means no usable token remains, or you signed out. Both specs hold under this reading. Update the deepen wording to match.
- **D2. Must `TEAMDYNAMIX_SSO_EXPECTED_USER` be set for local SSO?** **Default: still optional (it warns today), but renewal pins the UID of the stored token (P6)**, so identity can only change through an interactive `login`. Alternative: make it required and fail closed.
- **D3. CLI dispatch in `index.ts` (S3).** **Default: keep the 6-line dispatch and amend AGENTS.md** to permit it. Alternative: a second `bin` entry, `dist/cli/main.js`.
- **D4. vitest ^5 (X1).** **Default: revert to ^4** on this branch. The suite passes on ^4 (163/163). Bump it separately if wanted.
- **D5. `find-my-latest-ticket.ts` (X2).** **Default: move it to its own commit** (or branch) outside the SSO change.

## 2. Target state model (fixes P1, P4, P6; makes `CredentialState` real)

Replace the `.action-required` marker file with a per-realm **state file**, `tokens/sso-<digest>.state.json`, owned by `CredentialState`. `SsoTokenStore` becomes pure persistence: `write()` never touches renewal state.

```ts
// src/auth/credential-state.ts
export type RenewalGate = "allowed" | "blocked";
export interface CredentialStateFile {
  version: 1;
  epoch: number;            // incremented by every login and sign-out
  renewal: RenewalGate;
  blockedReason?: SsoFailureKind | "signed-out";
  blockedAtMs?: number;
}
export type CredentialStatus =
  | { kind: "usable"; token: StoredToken; renewal: RenewalGate }
  | { kind: "renewal-blocked"; token: StoredToken; reason: string }   // still valid, no automatic renewal
  | { kind: "action-required"; reason: string };                      // no usable token, or signed out
```

| Event | Lock | Token file | State file |
|---|---|---|---|
| Interactive `login` / `login --paste` succeeds | yes | write new token | `epoch+1`, `renewal:"allowed"` (the **only** writer of "allowed") |
| Renewal succeeds | yes | write only if `state.epoch === epochAtStart && renewal==="allowed"` **and** UID unchanged; otherwise discard (audit `renewal_discarded`) | unchanged |
| Renewal: temporary failure | no | unchanged | unchanged; reschedule with backoff |
| Renewal: policy, identity or invalid-token failure | yes | unchanged | if `epoch === epochAtStart`: `renewal:"blocked"`, reason |
| 401, probe says revoked | yes | delete **only if the stored token's fingerprint equals the failing token's** | `renewal:"blocked"`, reason `"invalid-token"` |
| `logout` | yes | delete | `epoch+1`, `renewal:"blocked"`, `"signed-out"` |
| `logout --all` (local) | yes | delete; remove browser profile | as `logout` |

Compare-and-swap on `epoch` closes the P4 race. The fingerprint check closes P3b.

## 3. Phases

### R0: Hygiene first, so the rest is reviewable (½ day)
- [ ] Add `.gitattributes` with `* text=auto eol=lf` (plus `*.ps1 eol=crlf` if any exist). In a **standalone commit**, run `git add --renormalize .` against `main`'s files only, so the whitespace churn leaves the feature diff (X3). Ideally land this on `main` first.
- [ ] Revert `vitest` to `^4.1.11` (D4) and restore the `package-lock.json` entry.
- [ ] Move `scripts/find-my-latest-ticket.ts` into its own commit (D5).
- [ ] Commit the current SSO work as a **baseline commit** on `feat/sso-user-auth`, staging only SSO files, so later reviews can use `main...HEAD`. Each phase below is one or more commits after it.
- **Exit:** `git diff main...HEAD --stat` shows only SSO-related files; `npm test` is green.

### R1: Correctness and safety fixes (2–2.5 days). *Completes deepen Task 2 (state) and Task 3 (classification and backoff).*

**R1.1 Failure taxonomy (P2, smell "every SsoLoginError = policy").** New `src/auth/sso-errors.ts`:
```ts
export type SsoFailureKind =
  | "transient"            // network, timeout before the IdP, 429/5xx, CDP unavailable or detached, profile in use
  | "interaction-required" // IdP shows MFA / CA / account picker, or still on the IdP at timeout
  | "identity-mismatch"    // expected user / pinned UID / tenant mismatch
  | "invalid-token"        // not a JWT, expired, getuser says 401/3xx
  | "configuration";       // playwright-core missing, browser channel missing, bad CDP URL
export class SsoFailure extends Error { constructor(readonly kind: SsoFailureKind, message: string) { super(message); } }
export const isRetryable = (k: SsoFailureKind) => k === "transient";
```
- [ ] `buildStoredToken`: no response, timeout, 429 or 5xx → `transient`. 401 or 3xx → `invalid-token`. Bad JWT or expired → `invalid-token`. User or tenant mismatch → `identity-mismatch`.
- [ ] `waitForJwt`: on timeout, check the page's last origin. Still on the TeamDynamix origin or `about:blank` (nothing loaded) → `transient`. On any other origin (the IdP) → `interaction-required`. **Report the origin's kind only, never the URL.**
- [ ] `openLocalBrowserSession`: the `playwright-core` import fails → `configuration`. Launch fails with a profile-in-use or SingletonLock error → `transient`. Other launch failures → `configuration`.
- [ ] `openHermesCdpBrowserSession`: connect or `newPage` fails → `transient`.
- [ ] Keep `SsoLoginError` as a deprecated alias for one release, or delete it if nothing outside `src/auth` uses it.

**R1.2 Renewal manager rewrite (P1, P2, D1).** In `SsoRenewalManager.getUsableToken()`:
```ts
const status = state.status(now);
if (status.kind === "action-required") throw new SsoActionRequiredError(status.reason);
const { token } = status;
if (token.expiresAtMs - now > leadMs) { schedule(token); return token.token; }       // fresh
if (status.kind === "renewal-blocked") return token.token;                             // D1: serve until expiry
if (token.expiresAtMs > now + SAFETY_MS) { void renewInBackground(); return token.token; } // don't make a tool call wait on a browser
return await renewNow();                                                               // expired or nearly: must wait
```
- [ ] Add `runRenewal` backoff: `delay = min(cap, base·2^attempt) ± 20% jitter`, with `base=30s`, `cap=15min`. Never schedule past `expiresAtMs − SAFETY_MS` (2 min). Inject the clock and scheduler.
- [ ] Temporary failure, token still valid → keep the token and reschedule. Token expired → throw `SsoUnavailableError` ("couldn't renew right now; retry shortly, or run `npm run login`"). This does **not** set action-required.
- [ ] Non-retryable failure → `state.blockRenewal(kind, epochAtStart)` (a no-op if the epoch moved). Serve the token if still valid; otherwise action-required.
- [ ] **Rewrite** the test `"records a policy interruption…"` in `test/sso-renewal.test.ts`. It currently asserts the wrong behaviour. New assertions: with the old token valid, the first call **resolves** with the old token; `openSession` is called once; the second call resolves with **no** new browser launch; after expiry, a call rejects with `/sign-in required/`.

**R1.3 Epoch CAS and pure persistence (P4).**
- [ ] Remove `allowAutomaticRenewal()` from `SsoTokenStore.write()`, and remove `blockAutomaticRenewal()` from `clear()`.
- [ ] Remove `isAutomaticRenewalAllowed`, `blockAutomaticRenewal` and the duplicated `AutomaticRenewalControl` interface from the store and the manager. `CredentialState` owns them (this also fixes the Refused Bequest and Middle Man smells).
- [ ] `CredentialState.commitRenewal(token, epochAtStart)` and `.beginRenewal()` (returns `epoch`) apply the table in §2 under the realm lock (R2). Until R2 lands, use a process-local mutex.
- [ ] Migrate the existing `.action-required` marker: if present, write a state file with `renewal:"blocked"`, `"signed-out"`, then delete the marker.

**R1.4 Pin identity on renewal (P6, D2).**
- [ ] `validate(token, previous, mode: "renewal" | "login")`. For `renewal`, require `stored.uid === previous.uid` when `previous.uid` is set; otherwise fail with `identity-mismatch`, which blocks renewal. For `login`, a UID change is allowed: audit `identity_changed { fromUid, toUid }`, purge caches, `epoch+1`.

**R1.5 401 probe: three outcomes and a CAS clear (P3, P3b).** Move the probe out of `client.ts` into the lifecycle (it reuses the identity validator's `getuser` call, which removes the duplicated-probe smell):
```ts
type UnauthorizedVerdict = "permission-denied" | "revoked" | "unknown";
// getuser 2xx → permission-denied; 401 or 3xx → revoked; timeout/429/5xx/network → unknown
```
- [ ] `permission-denied` → `TeamDynamixPermissionError` (as today). `revoked` → `state.revoke(fingerprint)`, which deletes the token only if it matches, then action-required. `unknown` → a new `TeamDynamixTransientAuthError` ("TeamDynamix couldn't confirm your sign-in; retry shortly"). **The token is not touched.**
- [ ] Remove `this.tokens.clear()` and `lastSsoProbeOk` from `client.ts` for SSO. The 60-second cache of a successful probe moves into the lifecycle, keyed by token fingerprint.

**R1 tests (red first):**

| Test | File |
|---|---|
| Policy failure in the lead window → the old token is served, no second browser launch, rejects after expiry | `test/sso-renewal.test.ts` |
| Temporary failure → backoff schedule 30s/60s/120s… capped, never past expiry minus safety (fake timers) | `test/sso-renewal.test.ts` |
| Renewal still running when logout happens → the renewal's token is discarded, the token file stays absent, the state stays `signed-out` | `test/sso-state.test.ts` (new) |
| Only `login` lifts a block: write, renewal success and status calls never do | `test/sso-state.test.ts` |
| A renewal returning a different UID (no expected user set) → rejected, renewal blocked, old token kept | `test/sso-lifecycle.test.ts` (new) |
| A renewal or second process writes a new token, then the old token's in-flight 401 resolves as `revoked` → the new token is **not** deleted | `test/sso-store-and-client.test.ts` |
| Probe times out, or returns 429/503 → `TeamDynamixTransientAuthError`, token kept | `test/sso-store-and-client.test.ts` |
| `waitForJwt` timeout on a TDX origin vs an IdP origin → `transient` vs `interaction-required`; the error text contains no URL or JWT | `test/sso-browser.test.ts` |
| `buildStoredToken` classification table (timeout, 429, 503, 401, 302, mismatch) | `test/sso-login.test.ts` |

**Exit:** all five sso-user-auth Review Focus items are covered by a test that fails on the old code.

### R2: Single flight across processes (P5) (1 day)
- [ ] New `src/auth/realm-lock.ts`: `withRealmLock(digest, fn, { waitMs, staleMs })`. It creates `tokens/sso-<digest>.lock` with `openSync(path, "wx")`, holding `{pid, hostname, acquiredAtMs}`. The lock counts as stale when older than `staleMs` (default 2 min) **or** when `process.kill(pid, 0)` throws ESRCH on the same host. Release it in `finally`.
- [ ] Renewal uses `tryAcquire`. If the lock is busy, another process is renewing: wait up to 45 s for the token file's mtime to change, then re-read it. That counts as success if the token is fresh; it is **not** a failure, and nothing is blocked.
- [ ] Short critical sections (commit, revoke, sign-out) use a blocking acquire: 50 ms polling, 5 s cap.
- [ ] Classify a browser profile-in-use error (Chromium `SingletonLock`) as `transient` (R1.1), as a backstop.
- [ ] Tests: two `SsoRenewalManager`s over one temp `TDX_HOME` → one `openSession` call, and both resolve to the same token. A stale lock (dead pid, old mtime) is taken over. The lock is released when `fn` throws.
- [ ] Manual check: Claude Desktop and Claude Code both running the server against the same realm → exactly one Edge launch at renewal time.

### R3: Structure (1.5–2 days). *Completes deepen Task 1 (resolved deployment) and Task 4 (opaque capability).*

**R3.1 Opaque authorization handle (G1).**
```ts
export interface SsoAuthorization {
  authorize(): Promise<{ header: string; fingerprint: string }>;          // "Bearer …"
  reportUnauthorized(fingerprint: string): Promise<UnauthorizedVerdict>;   // R1.5
}
```
- [ ] `TeamDynamixClient` receives `SsoAuthorization` from the composition root (`src/auth/sso-composition.ts`). It stops creating `SsoLifecycle` itself and never reads `this.tokens` in SSO mode. `getToken()`'s SSO branch shrinks to `authorize()`.
- [ ] Error mapping: `SsoActionRequiredError` → `TeamDynamixAuthError` carrying **one** canonical code, `SSO_ACTION_REQUIRED` (a constant in `sso-errors.ts`). That replaces the four spellings (Primitive Obsession smell).

**R3.2 Identity binding type (Data Clumps smell, G2).**
```ts
export interface IdentityBinding { realm: string /* normalized */; expectedUser?: string /* lower-cased */; }
export function bindingDigest(b: IdentityBinding): string; // one implementation
```
- [ ] `paths.ts`, `cache.ts`, `token-store.ts` and `scripts/auth.ts` take an `IdentityBinding` instead of `(apiBaseUrl, expectedUser)`. Delete the second hash implementation in `cache.ts`.
- [ ] Cache namespace = `bindingDigest(binding) + ":" + effectiveUid`, supplied by the lifecycle through `setCacheNamespace(fn)`, registered by the composition root. `scopedCacheKey` stops calling `getConfig()` (this also removes a hidden config dependency). Before validation, the namespace is `unverified`, so nothing is cached.
- [ ] Test: same realm and expected user but a different UID → cache miss; sandbox vs production → cache miss.

**R3.3 Config consolidation (S1, S2, Speculative Generality).**
- [ ] Add `LOCALAPPDATA` and `XDG_STATE_HOME` to `RawEnvSchema` as optional strings.
- [ ] `getTdxHome()` becomes a pure function of parsed values, `resolveTdxHome(raw, platform, homedir)`, and `Config` gains `stateHome`. Paths read `config.stateHome`.
- [ ] Add `parseCliEnv(env = process.env)`, which runs `RawEnvSchema.pick({...})` for the CLI and scripts that must start without full credentials. **This is the only other place allowed to see `process.env`, and it lives in `config.ts`.** `getApiBaseUrl()` uses it.
- [ ] Delete `getSsoCliSettings()` (no callers; deepen Task 1 says to remove it).
- [ ] Delete `TEAMDYNAMIX_SSO_BROWSER_ADAPTER` and `browserAdapter`. `TEAMDYNAMIX_MCP_DEPLOYMENT` is the sole selector (deepen "Decisions"). Reject the old variable with a `ConfigError` naming its replacement, the same pattern as `TEAMDYNAMIX_SSO_DEPLOYMENT`.
- [ ] `scripts/auth.ts`: replace the new `process.env.TEAMDYNAMIX_SSO_EXPECTED_USER` read with `parseCliEnv()`. Leave the older admin/user reads as a follow-up note.

**R3.4 Name the literal unions (Primitive Obsession).** Add `BrowserChannel = "msedge" | "chrome" | "chromium"`, `TokenSource = "sso" | "paste"` and `CredentialStatus` (from §2), each exported once and imported everywhere.

**R3.5 One place for SSO branching (Repeated Switches).** After R3.1, `auth.method === "sso"` should appear only in `config.ts` (parsing) and the composition root. `client.ts`, `token-store.ts` and `cache.ts` should take injected collaborators instead. `deployment === "external"` collapses into the resolved deployment's `browserAdapter` factory and its `fullSignOutEffect`.

**R3.6 Remaining smell cleanups**
- [ ] `isLoopbackHost(host)`, used once in `config.ts` (replaces the two copies).
- [ ] One `FALLBACK_TOKEN_LIFETIME_MS` constant (`sso-login.ts` and `client.ts`).
- [ ] One "user changed → purge caches" helper inside `SsoTokenStore` (read and write).
- [ ] One `loadPlaywright()` in `src/auth/playwright.ts`, used by both browser adapters, which classifies the missing-module error as `configuration`.
- [ ] Merge `openInteractiveSession` and `openRenewalSession` into `openSession({ interactive })` on the resolved deployment.

**R3 exit:** `grep -rn "process.env" src | grep -v "src/config.ts"` returns nothing. `grep -rn 'method === "sso"' src` shows only config and composition.

### R4: Finish the missing spec items (1.5 days). *Completes deepen Tasks 2, 4 and 5 and multi-user-remote Task 5.*

**R4.1 Legacy migration (G3).** The Phase 1 layout used `tokens/sso-<sha256(realm)[:16]>.json` (realm-only digest) and `browser-profile/` (singular).
- [ ] On lifecycle `start()`: if the new token file is missing and the legacy file exists, validate it via `/auth/getuser`. **Migrate only if the expected user is set and matches.** Then write the new file, rename the legacy one to `*.migrated`, and audit `state_migrated`. Otherwise leave it untouched; status says "run `npm run login`".
- [ ] Legacy `browser-profile/` → rename to `browser-profiles/sso-<digest>`, but only if no lock or SingletonLock is present. Otherwise skip and log.
- [ ] Tests: matching legacy → migrated; mismatched or no expected user → untouched; a second start is idempotent.

**R4.2 Hermes compatibility gate (G4).**
- [ ] Add `CompatibilityProbe` (exported for the script only, not the client): `forceRenewal(): Promise<{ uid, expiresAtMs }>`. It bypasses the freshness check but still goes through lock, validation and CAS.
- [ ] Before and after each mint, capture the CDP target set (`Target.getTargets`, or `browser.contexts().flatMap(c => c.pages())`). Compare sets of target IDs, **excluding the owned renewal tab's ID**. Report `{ unrelatedTargetsBefore: n, unrelatedTargetsAfter: n, unchanged: true }`, as counts and IDs only, **never URLs or titles**.
- [ ] The gate fails if the sets differ, the second mint returns the same JWT fingerprint, or the UID changes.
- [ ] Add `test/hermes-sso-compat.test.ts` covering argument parsing, the production guard, the set comparison, and that output has no URL or JWT.

**R4.3 External `logout --all` (G5).** `signOut({ full })` returns `{ removedLocalProfile: boolean; operatorAction?: string }`. For an external deployment, the CLI prints the operator action ("Ask the Hermes operator to sign the workspace browser out of CMU SSO") and exits 0. Test it.

**R4.4 Missing test files (G6).** `test/sso-lifecycle.test.ts` (start/stop, single flight, D1, P6), `test/http-auth.test.ts` (loopback-only SSO; MCP access secret rejected before dispatch; no TDX token forwarded), and `test/client.test.ts` additions (admin/user never construct the composition root; SSO client uses only `SsoAuthorization`).

### R5: Docs and standards (½ day)
- [ ] AGENTS.md (D3): change the entry-point rule to "`src/index.ts` selects a transport, or delegates `login`/`logout`/`whoami` to `src/cli`". Add the four scripts to Build & Run. Add a Key Convention: "SSO state transitions go through `CredentialState`; never call `SsoTokenStore.write/clear` directly."
- [ ] GLOSSARY: add **Renewal blocked** (D1) and **Epoch**. Align "SSO action required" with the single code.
- [ ] Amend the deepen-sso-lifecycle wording for D1, then tick off the checkboxes these phases complete.
- [ ] Update the README's SSO section for status states, multi-process behaviour and migration.

## 4. Verification

| Gate | Command / evidence |
|---|---|
| Unit | `npm test` (all new tests red on the baseline commit, green after) |
| Types / scripts | `npm run build`, `npm run check:scripts` |
| Protocol | `npm run test:mcp` |
| E2E (no network) | the stdio fake-TDX harness from 2026-10-23, extended with: a policy failure in the lead window, a renewal in flight during logout, a probe 503, and two server processes |
| Live sandbox | `npm run login` → 2 MCP clients open → force the lead window (`TEAMDYNAMIX_SSO_RENEW_LEAD_MS=82800000`) → one Edge launch, both clients keep working; run `logout` during a renewal → stays signed out |
| Review | re-run `/code-review` against `main` after R0's baseline commit; the target is zero Spec "implemented but wrong" findings |

## 5. Sequencing and estimate

R0 (½d) → **R1 (2–2.5d)** → R2 (1d) → R3 (1.5–2d) → R4 (1.5d) → R5 (½d). Total is about **7–8 working days**. R1 and R2 are the safety-critical part, ~3.5 days, and can ship as their own PR. Before R1 and R2 land, the local single-user path has these concrete risks: a valid token lost on a probe timeout (P3/P3b), being signed back in after logout (P4), and duplicate Edge launches with two clients (P5).

# TeamDynamix MCP

Terms used to describe the server's authentication and deployment model.

## Authentication and deployment

**Hermes workspace**:
A persistent Hermes execution environment assigned to exactly one CMU user. Its browser profile, stored credentials, and MCP activity represent that user's TeamDynamix identity.
_Avoid_: shared Hermes instance, multi-user Hermes server

**Local deployment**:
An MCP server process accessed only by its owning user's local tools or loopback HTTP endpoint.
_Avoid_: centrally hosted deployment

**Centrally managed single-user deployment**:
An organization-operated deployment that runs one isolated Hermes workspace and one TDX MCP instance per user; it is not a shared multi-user MCP process.
_Avoid_: multi-user service, shared hosted instance

**Server-held token state**:
A TeamDynamix bearer token retained only in the protected state of its owning MCP server and never delivered through chat or attached to ordinary MCP requests.
_Avoid_: client-held token, token forwarding

**Silent renewal**:
The server obtains and validates a replacement TeamDynamix JWT through its owner's persistent authenticated browser profile before the current JWT expires, without routine user interaction.
_Avoid_: token lifetime extension, token refresh grant

**Effective authentication method**:
The explicitly selected TeamDynamix authentication mode used for a server process or request: `admin`, `user`, or `sso`. Repository support for a method does not imply that every deployment enables it.
_Avoid_: fallback authentication, inferred credentials

**Renewal authority**:
The persistent, user-consented SSO browser session from which the server may mint replacement TeamDynamix JWTs. It is subject to the institution's MFA and Conditional Access policies.
_Avoid_: refresh token, long-lived TeamDynamix token

**Workspace browser**:
The existing CDP-controlled Chrome instance that belongs to a single Hermes workspace and is used for that workspace's interactive SSO and silent renewal.
_Avoid_: shared browser, separate renewal browser

**Expected user**:
The CMU email address or username assigned to an SSO deployment; a minted token is accepted only when TeamDynamix identifies it as that person.
_Avoid_: inferred user, mutable server identity

**MCP access secret**:
A deployment-specific bearer secret used only to authorize a caller to the loopback MCP endpoint. It is distinct from and grants no TeamDynamix identity.
_Avoid_: TeamDynamix token, SSO token

**CDP compatibility gate**:
A sandbox-only acceptance test that proves the MCP service can safely use its Hermes workspace browser to authenticate and silently renew a TeamDynamix token.
_Avoid_: assumed browser compatibility, production-first test

**SSO action required**:
A stable authentication state (`SSO_ACTION_REQUIRED`) meaning there is no usable token and automatic renewal is blocked, so a person must run `npm run login` before TeamDynamix calls can continue. A still-valid token never causes it; see Renewal blocked.
_Avoid_: chat credential prompt, authentication fallback

**Loopback deployment**:
A TDX MCP HTTP service bound only to the local interface of its single-user Hermes workspace and protected by an MCP access secret.
_Avoid_: public endpoint, shared remote service

**TeamDynamix realm**:
One TeamDynamix API environment, such as sandbox or production, with a separately valid SSO token and isolated stored authentication state.
_Avoid_: interchangeable endpoint, shared token environment

**Renewal single-flight**:
The rule that a workspace may run at most one token-renewal attempt for a TeamDynamix realm at a time; concurrent callers share its result.
_Avoid_: concurrent renewal, duplicate browser sign-in

**Authentication audit event**:
A structured, credential-free log record of an authentication, token validation, or renewal outcome for a workspace and TeamDynamix realm.
_Avoid_: credential log, browser transcript

**Renewal tab**:
The browser tab created and owned by the SSO renewal flow. It may be navigated and closed by that flow; existing Hermes browser tabs remain outside its control.
_Avoid_: workspace browser tab, shared browser state

**Full sign-out**:
An explicit operation that removes both the stored TeamDynamix token and the SSO browser state used as renewal authority.
_Avoid_: token-only logout, passive expiry

**Renewal scheduler**:
The MCP server-owned timer that starts with the server and schedules silent renewal for its active TeamDynamix realm before the current token expires.
_Avoid_: external credential cron job, client-managed renewal

**Renewal policy failure**:
A silent-renewal failure caused by sign-in, MFA, Conditional Access, or other identity policy requirements. It is not retried and puts renewal into Renewal blocked; it becomes SSO action required only once the current token has expired.
_Avoid_: transient renewal failure, retryable browser error

**Renewal blocked**:
The state in which automatic renewal is stopped (policy failure, identity mismatch, rejected token, or sign-out) but a token that has not yet expired is still served until its expiry. Only an interactive login lifts it. A transient failure (browser busy, network, 5xx) never blocks; it retries with backoff.
_Avoid_: locked out, signed out (a block is not a sign-out)

**Epoch**:
A counter in the sign-in state file, incremented by every login and sign-out. A renewal records the epoch when it starts and may commit its result only if it is unchanged, so a logout during a renewal always wins.
_Avoid_: version, generation

**Browser adapter**:
The deployment-specific implementation that obtains an SSO token from a browser: a dedicated local browser profile for desktop use or the existing Hermes CDP browser for centrally managed use.
_Avoid_: deployment-specific token lifecycle, implicit browser detection

**Identity binding**:
The invariant that an SSO deployment accepts tokens only for its configured expected user and TeamDynamix realm. A deliberate binding change clears the affected cached TeamDynamix data before use.
_Avoid_: implicit account switch, cross-realm cache reuse

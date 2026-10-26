# Hermes external SSO rollout

One Hermes workspace runs one loopback MCP service for one expected TeamDynamix user. Use `TEAMDYNAMIX_MCP_DEPLOYMENT=external`, `TRANSPORT=http`, `HOST=127.0.0.1`, a distinct `MCP_AUTH_TOKEN`, `TEAMDYNAMIX_SSO_EXPECTED_USER`, and the workspace's loopback `TEAMDYNAMIX_SSO_CDP_ENDPOINT` (normally `http://127.0.0.1:9222`). State is realm- and expected-user-scoped below `TDX_HOME`.

Run `npm run test:hermes-sso -- --realm sandbox` first. It exercises the production lifecycle interface through only the configured CDP endpoint and reports only realm, effective UID, and expiry. Production requires both `--realm production --allow-production`; perform read-only validation before a separately authorized write.

Migration is fail-safe: state is keyed by realm and Expected user, so do not move legacy realm-only state automatically. Retain the old owner-readable state as a backup and run `npm run login` to validate and establish the new identity-bound state. To roll back, stop the MCP process, restore the backed-up state/profile, and confirm the prior build is active before removing lifecycle state.

Every caller sends `Authorization: Bearer <MCP_AUTH_TOKEN>` to the loopback `POST /mcp` endpoint. This secret is not a TeamDynamix token. When `SSO_ACTION_REQUIRED` appears, run `npm run login` in the workspace after completing the approved human SSO/MFA step. `npm run logout` stops automatic renewal; `--all` is only meaningful for local browser profiles.

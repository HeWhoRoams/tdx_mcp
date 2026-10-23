# One user and one browser session per Hermes workspace

Each centrally managed deployment runs one Hermes workspace and one loopback TDX MCP server for one assigned CMU user. The server holds that user's TeamDynamix token, binds it to an expected user, and uses the workspace's existing CDP Chrome session as the opt-in renewal authority; a separate MCP access secret authorizes callers. This avoids cross-user credential state while allowing silent renewal when CMU SSO policy permits it.

Each TeamDynamix realm is deployed with isolated browser and token state. The server is loopback-only; externally hosted multi-user access is a separate architecture.

The shared SSO lifecycle uses a Hermes CDP browser adapter in this deployment; local desktop deployment uses a separate local-browser adapter. `admin` and `user` remain repository-supported modes, but this Hermes path is approved only for SSO in its initial phase.

## Considered Options

- A shared multi-user MCP service forwarding user JWTs was rejected for this deployment path because it requires a separate browser-facing session broker and durable per-user secret isolation.
- A dedicated browser profile was rejected in favor of the Hermes workspace browser, subject to a compatibility gate, because the latter already represents the user's persistent SSO state.

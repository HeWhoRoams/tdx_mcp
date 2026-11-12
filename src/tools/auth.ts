import { toolName } from "../constants.js";
import { z } from "zod";
import { READ } from "../framework/annotations.js";
import { runInteractiveLogin } from "../auth/interactive-login.js";
import { buildSsoLifecycle } from "../auth/sso-composition.js";
import { environmentLabel } from "../auth/sso-login.js";
import { getConfig, isSsoConfig } from "../config.js";
import { ToolInputError } from "../services/errors.js";
import { currentRequestContext } from "../services/request-context.js";
import { defineTool, type AnyToolDefinition } from "../framework/defineTool.js";
import { ResponseFormatSchema } from "../schemas/common.js";
import { tdRequest } from "../services/client.js";
import type { TdPerson } from "../types.js";

const GetCurrentUserInput = z.object({ response_format: ResponseFormatSchema }).strict();

interface SignInState {
  method: string;
  environment?: string;
  token_expires_at?: string;
  /** usable | renewal-blocked | needs-renewal | action-required. Never any token content. */
  state?: string;
  blocked_reason?: string;
}

function signInState(): SignInState {
  const config = getConfig();
  if (!isSsoConfig(config)) return { method: config.auth.method === "admin" ? "api key (service account)" : "service account login" };
  const status = buildSsoLifecycle(config).status();
  return {
    method: `sso (${config.auth.deployment})`,
    environment: environmentLabel(config.apiBaseUrl),
    ...(status.expiresAtMs ? { token_expires_at: new Date(status.expiresAtMs).toISOString() } : {}),
    state: status.state,
    ...(status.blockedReason ? { blocked_reason: status.blockedReason } : {}),
  };
}

const SignInInput = z.object({ response_format: ResponseFormatSchema }).strict();

interface SignedIn {
  name: string;
  uid?: string;
  email?: string;
  realm: string;
  expires_at: string;
}

export const authTools: AnyToolDefinition[] = [
  defineTool({
    name: toolName("sign_in"),
    title: "Sign In to TeamDynamix",
    description:
      "Opens a sign-in window on the user's computer where they complete SSO and MFA, then reports who is signed in.\n" +
      "Use when a tool says sign-in is required (SSO_ACTION_REQUIRED). The window times out after 5 minutes.",
    input: SignInInput,
    annotations: READ,
    // Only a server that runs on the user's own computer can open a window they can see.
    requiresAuth: { method: "sso", deployment: "local" },
    handler: async (): Promise<SignedIn> => {
      const config = getConfig();
      if (!isSsoConfig(config) || config.auth.deployment !== "local") {
        throw new ToolInputError("Sign-in from the chat needs TEAMDYNAMIX_AUTH_METHOD=sso on a locally run server.");
      }
      const stored = await runInteractiveLogin(config, { signal: currentRequestContext().signal });
      return {
        name: stored.fullName ?? "unknown user",
        ...(stored.uid ? { uid: stored.uid } : {}),
        ...(stored.email ?? stored.username ? { email: (stored.email ?? stored.username)! } : {}),
        realm: config.apiBaseUrl,
        expires_at: new Date(stored.expiresAtMs).toISOString(),
      };
    },
    render: (user) => `Signed in as ${user.name}${user.email ? ` <${user.email}>` : ""}. The sign-in is valid until ${user.expires_at}.`,
  }),

  defineTool({
    name: toolName("get_current_user"),
    title: "Get Current TeamDynamix User",
    description:
      "Returns the identity this server authenticates as, and the state of the sign-in (method, environment, expiry).\nUse it to confirm credentials and available permissions.",
    input: GetCurrentUserInput,
    annotations: READ,
    handler: async (): Promise<TdPerson & { sign_in: SignInState }> => {
      const user = await tdRequest<TdPerson>("/auth/getuser");
      return { ...user, sign_in: signInState() };
    },
    render: (user) =>
      [
        `## ${user.FullName} (${user.UID})`,
        `- **Email**: ${user.PrimaryEmail ?? "N/A"}`,
        `- **Sign-in**: ${user.sign_in.method}${user.sign_in.environment ? ` on ${user.sign_in.environment}` : ""}`,
        ...(user.sign_in.token_expires_at ? [`- **Token expires**: ${user.sign_in.token_expires_at}`] : []),
        ...(user.sign_in.state ? [`- **State**: ${user.sign_in.state}${user.sign_in.blocked_reason ? ` (${user.sign_in.blocked_reason})` : ""}`] : []),
      ].join("\n"),
  }),
];

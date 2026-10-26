import {
  environmentLabel,
  extractJwt,
  loginSsoUrl,
  SsoLoginError,
} from "../auth/sso-login.js";
import type { SignOutResult } from "../auth/sso-lifecycle.js";
import { buildSsoLifecycle } from "../auth/sso-composition.js";
import { getConfig, isSsoConfig } from "../config.js";
import type { StoredToken } from "../services/token-store.js";

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function describe(stored: StoredToken, apiBaseUrl: string): string {
  const mins = Math.round((stored.expiresAtMs - Date.now()) / 60_000);
  const left = mins > 0 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : "EXPIRED";
  return (
    `${stored.fullName ?? "unknown user"} <${stored.email ?? stored.username ?? "?"}> (UID ${stored.uid ?? "?"}) ` +
    `on ${environmentLabel(apiBaseUrl)}; token expires ${new Date(stored.expiresAtMs).toLocaleString()} (${left})`
  );
}

export function describeSignOut(label: string, result: SignOutResult): string {
  return (
    `Signed out of ${label}${result.removedLocalProfile ? " and removed the login browser profile" : ""}.\n` +
    (result.operatorAction ? `${result.operatorAction}\n` : "")
  );
}

export async function runAuthCli(command: string, args: string[]): Promise<number> {
  const config = getConfig();
  if (!isSsoConfig(config)) throw new SsoLoginError("The auth commands require TEAMDYNAMIX_AUTH_METHOD=sso.");
  const apiBaseUrl = config.apiBaseUrl;
  const lifecycle = buildSsoLifecycle(config);

  try {
    if (command === "login") {
      const paste = args.includes("--paste");
      let token: string;
      if (paste) {
        if (config.auth.deployment === "external") throw new SsoLoginError("External Hermes SSO does not accept pasted tokens. Complete login in the workspace browser.");
        process.stderr.write(`Open ${loginSsoUrl(apiBaseUrl)} in your browser, sign in, then paste the token.\n`);
        token = extractJwt(await promptHidden("Token (hidden): ")) ?? "";
        if (!token) throw new SsoLoginError("No JWT found in what was pasted.");
      } else {
        process.stderr.write(`Starting ${config.auth.deployment === "external" ? "Hermes" : "local"} SSO sign-in for ${environmentLabel(apiBaseUrl)}...\n`);
        const stored = await lifecycle.login();
        process.stdout.write(`Signed in: ${describe(stored, apiBaseUrl)}\n`);
        return 0;
      }
      const stored = await lifecycle.accept(token, "paste");
      process.stdout.write(`Signed in: ${describe(stored, apiBaseUrl)}\n`);
      return 0;
    }

    if (command === "whoami") {
      const status = lifecycle.status();
      if (!status.effectiveUid) {
        process.stdout.write(`Not signed in to ${environmentLabel(apiBaseUrl)}. Run: npm run login\n`);
        return 1;
      }
      const expires = new Date(status.expiresAtMs!).toLocaleString();
      const notes: Record<string, string> = {
        usable: "usable; renews automatically",
        "renewal-blocked": `usable until it expires; automatic renewal is blocked (${status.blockedReason}), run: npm run login`,
        "needs-renewal": "expired; will renew on next use if possible, otherwise run: npm run login",
        "action-required": `sign-in required (${status.blockedReason}); run: npm run login`,
      };
      process.stdout.write(`Signed in as ${status.effectiveUid} on ${environmentLabel(apiBaseUrl)}; token expires ${expires} (${notes[status.state]}).\n`);
      return status.state === "usable" || status.state === "renewal-blocked" ? 0 : 1;
    }

    if (command === "logout") {
      process.stdout.write(describeSignOut(environmentLabel(apiBaseUrl), lifecycle.signOut(args.includes("--all"))));
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof SsoLoginError ? error.message : `Error: ${String(error)}`}\n`);
    return 1;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  return 1;
}

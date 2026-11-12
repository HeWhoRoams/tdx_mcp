import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runInteractiveLogin } from "../auth/interactive-login.js";
import { environmentLabel } from "../auth/sso-login.js";
import { getConfig, getTdxHome, isSsoConfig, resetConfig } from "../config.js";
import { tdRequest } from "../services/client.js";
import { appKeyOf } from "../policy/availability.js";
import type { TdApp } from "../types.js";
import { promptHidden } from "./auth-cli.js";

/**
 * `teamdynamix-mcp-server init`: first-run setup for a packaged install. Writes the one per-user
 * `.env`, signs in when SSO is chosen, offers a default ticketing application, and prints the
 * configuration to paste into the client.
 */

export interface InitAnswers {
  baseUrl: string;
  authMethod: "sso" | "admin";
  beid?: string;
  wsKey?: string;
  expectedUser?: string;
  defaultAppId?: number;
}

/** The `.env` text for the answers. Blank optional values are left out rather than written empty. */
export function renderEnvFile(answers: InitAnswers): string {
  const lines = [
    "# Written by `teamdynamix-mcp-server init`. Edit freely; real environment variables take precedence.",
    `TEAMDYNAMIX_BASE_URL=${answers.baseUrl}`,
    `TEAMDYNAMIX_AUTH_METHOD=${answers.authMethod}`,
  ];
  if (answers.authMethod === "admin") {
    lines.push(`TEAMDYNAMIX_BEID=${answers.beid ?? ""}`, `TEAMDYNAMIX_WS_KEY=${answers.wsKey ?? ""}`);
  }
  if (answers.expectedUser) lines.push(`TEAMDYNAMIX_SSO_EXPECTED_USER=${answers.expectedUser}`);
  if (answers.defaultAppId !== undefined) lines.push(`TEAMDYNAMIX_DEFAULT_APP_ID=${answers.defaultAppId}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Client configuration. The server reads its settings from the `.env` init wrote, so the snippets
 * carry no secrets and need no env block.
 */
export function clientSnippets(): Record<"Claude Desktop" | "Claude Code" | "VS Code", string> {
  const server = { command: "npx", args: ["-y", "teamdynamix-mcp-server"] };
  return {
    "Claude Desktop": `Add to claude_desktop_config.json:\n${JSON.stringify({ mcpServers: { teamdynamix: server } }, null, 2)}`,
    "Claude Code": "claude mcp add teamdynamix -- npx -y teamdynamix-mcp-server",
    "VS Code": `Add to .vscode/mcp.json:\n${JSON.stringify({ servers: { teamdynamix: { type: "stdio", ...server } } }, null, 2)}`,
  };
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) throw new Error("The organization URL must start with https://");
  return trimmed;
}

export async function runInitCli(args: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const out = (text: string) => process.stderr.write(`${text}\n`);
  try {
    const envPath = join(getTdxHome(), ".env");
    if (existsSync(envPath) && !args.includes("--force")) {
      const answer = (await rl.question(`${envPath} already exists. Replace it? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        out("Left the existing configuration unchanged.");
        return 1;
      }
    }

    const baseUrl = normalizeUrl(await rl.question("TeamDynamix URL (e.g. https://yourorg.teamdynamix.com): "));
    const method = (await rl.question("Sign in as yourself with SSO, or use an admin API key? [sso/admin] (sso): ")).trim().toLowerCase();
    const answers: InitAnswers = { baseUrl, authMethod: method === "admin" ? "admin" : "sso" };

    if (answers.authMethod === "admin") {
      answers.beid = (await rl.question("BEID: ")).trim();
      rl.pause();
      answers.wsKey = (await promptHidden("Web services key (hidden): ")).trim();
      if (!answers.beid || !answers.wsKey) throw new Error("Both the BEID and the web services key are required.");
    } else {
      const expected = (await rl.question("Your TeamDynamix email, to pin sign-in to you (optional): ")).trim();
      if (expected) answers.expectedUser = expected;
    }

    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, renderEnvFile(answers), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Windows has no POSIX modes; the file lives in the user's own profile.
    }
    out(`Wrote ${envPath}`);

    // Use what was just written for the steps below.
    process.env.TEAMDYNAMIX_BASE_URL = answers.baseUrl;
    process.env.TEAMDYNAMIX_AUTH_METHOD = answers.authMethod;
    if (answers.beid) process.env.TEAMDYNAMIX_BEID = answers.beid;
    if (answers.wsKey) process.env.TEAMDYNAMIX_WS_KEY = answers.wsKey;
    if (answers.expectedUser) process.env.TEAMDYNAMIX_SSO_EXPECTED_USER = answers.expectedUser;
    resetConfig();

    const config = getConfig();
    if (isSsoConfig(config)) {
      out(`Starting sign-in for ${environmentLabel(config.apiBaseUrl)}. Complete it in the window that opens...`);
      const stored = await runInteractiveLogin(config);
      out(`Signed in as ${stored.fullName ?? stored.email ?? "unknown user"}.`);
    }

    try {
      const apps = (await tdRequest<TdApp[]>("/applications")) ?? [];
      const ticketing = apps.filter((app) => app.Active !== false && appKeyOf(app) === "tickets");
      if (ticketing.length > 0) {
        out("\nTicketing applications:");
        ticketing.forEach((app, index) => out(`  ${index + 1}. ${app.Name} (${app.AppID})`));
        const pick = (await rl.question("Use one as the default? Enter its number, or press Enter to skip: ")).trim();
        const chosen = ticketing[Number(pick) - 1];
        if (chosen) {
          answers.defaultAppId = chosen.AppID;
          writeFileSync(envPath, renderEnvFile(answers), { encoding: "utf8", mode: 0o600 });
          out(`Default application set to ${chosen.Name}.`);
        }
      }
    } catch (error) {
      out(`Could not list applications (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). You can set TEAMDYNAMIX_DEFAULT_APP_ID in ${envPath} later.`);
    }

    out("\nAdd the server to your client:\n");
    for (const [client, snippet] of Object.entries(clientSnippets())) out(`${client}\n${snippet}\n`);
    return 0;
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    rl.close();
  }
}

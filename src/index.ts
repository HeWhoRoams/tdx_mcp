#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { ConfigError, getConfig, getTdxHome } from "./config.js";
import { dropUnfilledPlaceholders, resolveEnvFile } from "./env-file.js";

/**
 * Load .env from TDX_ENV_FILE, else the per-user TDX_HOME/.env, else the project root (one level
 * above dist/), never process.cwd(), because MCP clients often start the server from another
 * folder. dotenv never overrides variables the client set explicitly, so a deployment can still pin
 * values in the client's env block.
 */
dropUnfilledPlaceholders(process.env);
const envFile = resolveEnvFile(
  process.env,
  getTdxHome(),
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  existsSync
);
if (envFile) loadDotenv({ path: envFile });

/**
 * Entry point for the TeamDynamix MCP server: loads configuration, then hands a server lifecycle
 * to the selected transport. Lifecycle decisions live in lifecycle.ts, server construction in
 * server.ts, and each transport in transports/.
 */

import { createServerLifecycle } from "./lifecycle.js";

function fail(error: unknown): never {
  const message = error instanceof ConfigError ? error.message : `Server error: ${String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "init") {
    const { runInitCli } = await import("./cli/init-cli.js");
    process.exit(await runInitCli(process.argv.slice(3)));
  }
  if (command === "login" || command === "logout" || command === "whoami") {
    // Human-run auth commands: no credentials required, and no server is started.
    const { runAuthCli } = await import("./cli/auth-cli.js");
    process.exit(await runAuthCli(command, process.argv.slice(3)));
  }
  const config = getConfig();
  const lifecycle = createServerLifecycle({ config });
  if (config.transport === "http") {
    // Imported lazily so the stdio path never loads the HTTP stack.
    const { runHttp } = await import("./transports/http.js");
    await runHttp(lifecycle);
  } else {
    const { runStdio } = await import("./transports/stdio.js");
    await runStdio(lifecycle);
  }
}

main().catch(fail);

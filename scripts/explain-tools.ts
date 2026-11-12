#!/usr/bin/env tsx
/**
 * explain-tools.ts
 *
 * Prints, for every tool and prompt, whether this server would register it and why: the tool-policy
 * decision first, then application availability. It resolves the same surface the running server
 * mounts, so it answers "why is (or isn't) this in my client?".
 *
 * Application names identify the organization, so only the kinds present (tickets, assets,
 * projects) are shown. Use `npm run list-apps` to see the applications themselves.
 *
 * Usage:
 *   npm run tools:explain              looks up applications the way the server does
 *   npm run tools:explain -- --offline skips the lookup (policy decisions only)
 *   npm run tools:explain -- --hidden  lists only entries that are not registered
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.TDX_ENV_FILE ?? resolve(root, ".env");
if (existsSync(envFile)) loadDotenv({ path: envFile });

const { getConfig } = await import("../src/config.js");
const { getAvailability } = await import("../src/policy/availability.js");
const { summarizePolicy } = await import("../src/policy/index.js");
const { catalog } = await import("../src/surface/catalog.js");
const { resolveSurface } = await import("../src/surface/resolve.js");
type Availability = import("../src/policy/availability.js").Availability;

const offline = process.argv.includes("--offline");
const onlyHidden = process.argv.includes("--hidden");

const config = getConfig();
console.log(`Policy: ${summarizePolicy(config.toolPolicy)}`);

let availability: Availability | undefined;
if (offline || config.appGating.mode === "off") {
  console.log(`Application gating: ${offline ? "skipped (--offline)" : "off (TDX_APP_GATING=off)"}`);
} else {
  availability = await getAvailability({ timeoutMs: 30_000 });
  console.log(
    availability.known
      ? `Application gating: known; kinds present: ${[...availability.present].sort().join(", ")}`
      : `Application gating: unknown (${availability.reason}); every policy-allowed tool stays registered`
  );
}
console.log("");

const surface = resolveSurface(catalog, config.toolPolicy, availability);
const width = Math.max(...surface.entries.map((entry) => entry.name.length));
for (const entry of surface.entries) {
  const registered = entry.state === "registered";
  if (onlyHidden && registered) continue;
  const label = `${entry.kind === "prompt" ? "prompt " : "tool   "}`;
  console.log(`${registered ? "registered" : "NOT      "}  ${label}  ${entry.name.padEnd(width)}  ${entry.reason}`);
}

const { tool, prompt } = surface.counts;
console.log(
  `\n${tool.registered} of ${catalog.tools.length} tools and ${prompt.registered} of ${catalog.prompts.length} prompts would be registered.`
);
process.exit(0);

import "dotenv/config";
import { assertRealmAllowed, evaluateCompat, listCdpTargetIds, parseHermesCompatArgs } from "../src/auth/hermes-compat.js";
import { buildSsoLifecycle } from "../src/auth/sso-composition.js";
import { environmentLabel } from "../src/auth/sso-login.js";
import { getConfig } from "../src/config.js";

async function main(): Promise<void> {
  const args = parseHermesCompatArgs(process.argv.slice(2));
  const config = getConfig();
  if (config.auth.method !== "sso" || config.auth.deployment !== "external" || !config.auth.cdpEndpoint) {
    throw new Error("Hermes compatibility requires external SSO configuration.");
  }
  assertRealmAllowed(environmentLabel(config.apiBaseUrl), args);

  const endpoint = config.auth.cdpEndpoint;
  const lifecycle = buildSsoLifecycle(config);
  const targetsBefore = await listCdpTargetIds(endpoint);
  const first = await lifecycle.forceRenewal();
  const second = await lifecycle.forceRenewal();
  const targetsAfter = await listCdpTargetIds(endpoint);

  const verdict = evaluateCompat({ realm: args.realm, targetsBefore, targetsAfter, first, second });
  process.stdout.write(`${JSON.stringify({ status: verdict.ok ? "ok" : "failed", ...verdict.report, failures: verdict.failures })}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`Hermes SSO compatibility failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});

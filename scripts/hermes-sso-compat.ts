import "dotenv/config";
import { environmentLabel } from "../src/auth/sso-login.js";
import { buildSsoLifecycle } from "../src/auth/sso-composition.js";
import { getConfig } from "../src/config.js";

export function parseHermesCompatArgs(args: string[]): { realm: "sandbox" | "production"; allowProduction: boolean } {
  const realm = args[args.indexOf("--realm") + 1];
  if (realm !== "sandbox" && realm !== "production") {
    throw new Error("Usage: npm run test:hermes-sso -- --realm sandbox [--allow-production]");
  }
  return { realm, allowProduction: args.includes("--allow-production") };
}

async function main(): Promise<void> {
  const { realm, allowProduction } = parseHermesCompatArgs(process.argv.slice(2));
  if (realm === "production" && !allowProduction) throw new Error("Production requires --allow-production.");
  const config = getConfig();
  if (config.auth.method !== "sso" || config.auth.deployment !== "external" || !config.auth.cdpEndpoint) {
    throw new Error("Hermes compatibility requires external SSO configuration.");
  }
  if (environmentLabel(config.apiBaseUrl) !== realm) throw new Error("Configured TeamDynamix realm does not match --realm.");
  const lifecycle = buildSsoLifecycle(config);
  lifecycle.start();
  try {
    await lifecycle.authorization();
    await lifecycle.authorization();
    const status = lifecycle.status();
    process.stdout.write(JSON.stringify({ status: "ok", realm, uid: status.effectiveUid, expiresAtMs: status.expiresAtMs, lifecycleAuthorization: true }) + "\n");
  } finally {
    lifecycle.stop();
  }
}

void main().catch((error) => { process.stderr.write(`Hermes SSO compatibility failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; });

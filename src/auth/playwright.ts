import { SsoLoginError } from "./sso-login.js";

/** Loads the optional playwright-core package. A missing package is a setup problem, not a retryable one. */
export async function loadPlaywright(missingMessage: string): Promise<any> {
  const moduleName = "playwright-core";
  try {
    return await import(moduleName);
  } catch {
    throw new SsoLoginError(missingMessage, "configuration");
  }
}

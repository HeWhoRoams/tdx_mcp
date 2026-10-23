import { loadPlaywright } from "./playwright.js";
import { SsoLoginError } from "./sso-login.js";
import { type BrowserPage, type SsoBrowserSession, waitForJwt } from "./sso-browser.js";

export interface HermesCdpBrowserOptions {
  apiBaseUrl: string;
  cdpEndpoint: string;
  timeoutMs: number;
}

type RenewalPage = BrowserPage & { close(): Promise<void> };
type ConnectedBrowser = { newPage(): Promise<RenewalPage> };
export type ConnectOverCdp = (endpoint: string) => Promise<ConnectedBrowser>;

async function defaultConnectOverCdp(endpoint: string): Promise<ConnectedBrowser> {
  const playwright = await loadPlaywright("Attaching to the Hermes browser needs the optional playwright-core package.");
  return playwright.chromium.connectOverCDP(endpoint) as Promise<ConnectedBrowser>;
}

/**
 * Creates exactly one owned renewal tab. It never discovers, reads, navigates,
 * or closes existing Hermes tabs; closing this session closes only its page.
 */
export async function openHermesCdpBrowserSession(
  options: HermesCdpBrowserOptions,
  connect: ConnectOverCdp = defaultConnectOverCdp
): Promise<SsoBrowserSession> {
  let browser: ConnectedBrowser;
  try {
    browser = await connect(options.cdpEndpoint);
  } catch (error) {
    // A missing playwright-core is a setup problem; an unreachable browser is worth retrying.
    throw error instanceof SsoLoginError && error.kind === "configuration"
      ? error
      : new SsoLoginError("The configured Hermes CDP browser is unavailable.", "transient");
  }
  let page: RenewalPage;
  try {
    page = await browser.newPage();
  } catch {
    throw new SsoLoginError("Could not create the owned Hermes SSO renewal tab.", "transient");
  }
  return {
    mintToken: () => waitForJwt(page, options.apiBaseUrl, options.timeoutMs),
    close: () => page.close().catch(() => undefined),
  };
}

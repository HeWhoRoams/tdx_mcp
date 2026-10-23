import { extractJwt, loginSsoUrl, SsoLoginError, SsoPolicyError } from "./sso-login.js";
import type { SsoFailureKind } from "./sso-errors.js";

export interface SsoBrowserSession {
  mintToken(): Promise<string>;
  close(): Promise<void>;
}

export interface LocalBrowserOptions {
  apiBaseUrl: string;
  browser: "msedge" | "chrome" | "chromium";
  profileDir: string;
  headless: boolean;
  timeoutMs: number;
}

export type BrowserPage = {
  on(event: "response", handler: (response: { status(): number; url(): string; text(): Promise<string> }) => void): void;
  goto(url: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  /** Optional: lets a timeout be classified by where the page was stuck. Never reported verbatim. */
  url?(): string;
};

type BrowserContext = {
  pages(): BrowserPage[];
  close(): Promise<void>;
};

export type LaunchLocalBrowser = (
  profileDir: string,
  options: { channel?: "msedge" | "chrome"; headless: boolean; viewport: { width: number; height: number } }
) => Promise<BrowserContext>;

async function defaultLaunchLocalBrowser(
  profileDir: string,
  options: { channel?: "msedge" | "chrome"; headless: boolean; viewport: { width: number; height: number } }
): Promise<BrowserContext> {
  const moduleName = "playwright-core";
  let playwright: any;
  try {
    playwright = await import(moduleName);
  } catch {
    throw new SsoLoginError(
      "Interactive sign-in needs the optional playwright-core package (run `npm install`), or use `npm run login -- --paste`.",
      "configuration"
    );
  }
  return playwright.chromium.launchPersistentContext(profileDir, options) as Promise<BrowserContext>;
}

/** A launch that fails because the browser is missing is a configuration problem; anything else may pass. */
export function classifyLaunchError(error: unknown): SsoLoginError {
  if (error instanceof SsoLoginError) return error;
  const text = error instanceof Error ? error.message : "";
  if (/executable doesn't exist|is not found|distribution .* not found|ENOENT/i.test(text)) {
    return new SsoLoginError("The configured sign-in browser could not be found on this machine.", "configuration");
  }
  if (/singleton|already in use|user data directory/i.test(text)) {
    return new SsoLoginError("The SSO browser profile is in use by another process.", "transient");
  }
  return new SsoLoginError("The sign-in browser could not be started.", "transient");
}

/** Where a stuck sign-in was waiting decides whether it can simply be retried. */
function timeoutError(page: BrowserPage, apiBaseUrl: string): SsoLoginError {
  let location: string | undefined;
  try {
    location = page.url?.();
  } catch {
    location = undefined;
  }
  if (location !== undefined) {
    let origin: string | undefined;
    try {
      origin = new URL(location).origin;
    } catch {
      origin = undefined;
    }
    const tdxOrigin = new URL(loginSsoUrl(apiBaseUrl)).origin;
    if (location === "about:blank" || location === "" || origin === tdxOrigin) {
      return new SsoLoginError("Timed out waiting for TeamDynamix to return a token.", "transient");
    }
  }
  return new SsoPolicyError("Timed out waiting for the SSO sign-in to finish.");
}

export function waitForJwt(page: BrowserPage, apiBaseUrl: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(timeoutError(page, apiBaseUrl))),
      timeoutMs
    );
    page.on("response", async (response) => {
      try {
        const expected = new URL(loginSsoUrl(apiBaseUrl));
        const actual = new URL(response.url());
        if (response.status() !== 200 || actual.origin !== expected.origin || actual.pathname !== expected.pathname) return;
        const token = extractJwt(await response.text());
        if (token) finish(() => resolve(token));
      } catch {
        // Redirect hops may not have a readable response body.
      }
    });
    const poll = setInterval(async () => {
      try {
        const token = extractJwt(String(await page.evaluate("document.body ? document.body.innerText : ''")));
        if (token) finish(() => resolve(token));
      } catch {
        // The page may be between redirects; keep waiting.
      }
    }, 750);
    void page.goto(loginSsoUrl(apiBaseUrl)).catch(() => undefined);
  });
}

/** Opens the dedicated local profile; callers own and must close the returned session. */
export async function openLocalBrowserSession(
  options: LocalBrowserOptions,
  launch: LaunchLocalBrowser = defaultLaunchLocalBrowser
): Promise<SsoBrowserSession> {
  let context: BrowserContext;
  try {
    context = await launch(options.profileDir, {
      ...(options.browser === "chromium" ? {} : { channel: options.browser }),
      headless: options.headless,
      viewport: { width: 900, height: 760 },
    });
  } catch (error) {
    throw classifyLaunchError(error);
  }
  const page = context.pages()[0];
  if (!page) {
    await context.close().catch(() => undefined);
    throw new SsoLoginError("The sign-in browser did not create a page.", "transient");
  }
  return {
    mintToken: () => waitForJwt(page, options.apiBaseUrl, options.timeoutMs),
    close: () => context.close().catch(() => undefined),
  };
}

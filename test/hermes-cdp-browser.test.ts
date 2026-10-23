import { describe, expect, it, vi } from "vitest";
import { openHermesCdpBrowserSession } from "../src/auth/hermes-cdp-browser.js";

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQ3MDAwMDAwMDB9.signature";

describe("Hermes CDP SSO browser", () => {
  it("creates and closes only one renewal tab while accepting the configured realm token", async () => {
    let responseHandler: ((response: { status(): number; url(): string; text(): Promise<string> }) => void) | undefined;
    const page = {
      on: vi.fn((_event, handler) => { responseHandler = handler; }),
      goto: vi.fn(async () => { await responseHandler?.({ status: () => 200, url: () => "https://td.example/SBTDWebApi/api/auth/loginsso", text: async () => jwt }); }),
      evaluate: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const browser = { newPage: vi.fn(async () => page) };
    const connect = vi.fn(async () => browser);

    const session = await openHermesCdpBrowserSession({ apiBaseUrl: "https://td.example/SBTDWebApi/api", cdpEndpoint: "http://127.0.0.1:9222", timeoutMs: 1_000 }, connect);
    await expect(session.mintToken()).resolves.toBe(jwt);
    await session.close();
    expect(connect).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(browser.newPage).toHaveBeenCalledOnce();
    expect(page.close).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import { openLocalBrowserSession } from "../src/auth/sso-browser.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTI4NTk1N30.signature";

describe("openLocalBrowserSession", () => {
  it("uses its dedicated profile and returns the token observed at loginsso", async () => {
    let responseHandler: ((response: { status(): number; url(): string; text(): Promise<string> }) => void) | undefined;
    const page = {
      on: vi.fn((event: string, handler: typeof responseHandler) => {
        if (event === "response") responseHandler = handler;
      }),
      goto: vi.fn(async () => {
        responseHandler?.({
          status: () => 200,
          url: () => "https://example.teamdynamix.com/SBTDWebApi/api/auth/loginsso",
          text: async () => JWT,
        });
      }),
      evaluate: vi.fn(async () => ""),
    };
    const context = { pages: () => [page], close: vi.fn(async () => undefined) };
    const launch = vi.fn(async () => context);

    const session = await openLocalBrowserSession(
      {
        apiBaseUrl: "https://example.teamdynamix.com/SBTDWebApi/api",
        browser: "msedge",
        profileDir: "C:/state/tdx-mcp/browser-profile",
        headless: false,
        timeoutMs: 5_000,
      },
      launch
    );

    await expect(session.mintToken()).resolves.toBe(JWT);
    expect(launch).toHaveBeenCalledWith("C:/state/tdx-mcp/browser-profile", expect.objectContaining({ channel: "msedge" }));
    await session.close();
    expect(context.close).toHaveBeenCalledOnce();
  });
});

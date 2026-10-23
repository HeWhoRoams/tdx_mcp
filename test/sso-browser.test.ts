import { describe, expect, it, vi } from "vitest";
import { classifyLaunchError, openLocalBrowserSession, waitForJwt } from "../src/auth/sso-browser.js";

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

const API = "https://example.teamdynamix.com/SBTDWebApi/api";

describe("failure classification", () => {
  const stuckPage = (url: string | undefined) => ({
    on: vi.fn(),
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ""),
    ...(url === undefined ? {} : { url: () => url }),
  });

  it.each([
    ["about:blank", "transient"],
    ["https://example.teamdynamix.com/SBTDWebApi/api/auth/loginsso", "transient"],
    ["https://login.microsoftonline.com/secret-tenant/oauth2/authorize?x=1", "interaction-required"],
    [undefined, "interaction-required"],
  ] as const)("a timeout while on %s is %s", async (url, kind) => {
    const error = await waitForJwt(stuckPage(url), API, 5).catch((e) => e);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toMatch(/microsoftonline|secret-tenant|https?:\/\//);
  });

  it("separates a missing browser from a busy profile from anything else", () => {
    expect(classifyLaunchError(new Error("Executable doesn't exist at C:/x/msedge.exe")).kind).toBe("configuration");
    expect(classifyLaunchError(new Error("The profile appears to be in use (Singleton lock)")).kind).toBe("transient");
    expect(classifyLaunchError(new Error("boom")).kind).toBe("transient");
  });

  it("a failing launch surfaces as a classified error", async () => {
    const launch = vi.fn(async () => {
      throw new Error("Executable doesn't exist at C:/x/msedge.exe");
    });
    await expect(
      openLocalBrowserSession(
        { apiBaseUrl: API, browser: "msedge", profileDir: "x", headless: false, timeoutMs: 100, interactive: true } as never,
        launch as never
      )
    ).rejects.toMatchObject({ kind: "configuration" });
  });
});

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceTokenStore } from "../src/auth/token-store.js";
import { resetConfig } from "../src/config.js";

const posix = process.platform !== "win32";
let home: string;

function useEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TEAMDYNAMIX_") || key.startsWith("MCP_")) delete process.env[key];
  }
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid-1";
  process.env.TEAMDYNAMIX_WS_KEY = "key-1";
  process.env.TEAMDYNAMIX_TOKEN_CACHE = "file";
  process.env.TDX_HOME = home;
  resetConfig();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tdx-token-store-"));
  useEnv();
});

afterEach(() => {
  delete process.env.TDX_HOME;
  delete process.env.TEAMDYNAMIX_TOKEN_CACHE;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

const token = { token: "test-jwt", expiresAtMs: Date.now() + 60_000 };

describe("service token file cache", () => {
  it("writes under the per-user state folder, not the temp folder", () => {
    createServiceTokenStore().write(token);
    const dir = join(home, "tokens");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^service-[0-9a-f]{32}\.json$/);
  });

  it("is read back by a new store instance", () => {
    createServiceTokenStore().write(token);
    expect(createServiceTokenStore().read()?.token).toBe("test-jwt");
  });

  it.runIf(posix)("uses private permissions", () => {
    createServiceTokenStore().write(token);
    const dir = join(home, "tokens");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)("replaces a planted symlink instead of writing through it", () => {
    const store = createServiceTokenStore();
    store.write(token);
    const dir = join(home, "tokens");
    const target = join(dir, readdirSync(dir)[0]!);
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "untouched");
    rmSync(target);
    symlinkSync(victim, target);

    store.write({ ...token, token: "test-jwt-2" });

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(createServiceTokenStore().read()?.token).toBe("test-jwt-2");
    expect(existsSync(victim)).toBe(true);
    expect(readdirSync(home)).toContain("victim.txt");
    expect(statSync(victim).size).toBe("untouched".length);
  });

  it("clear removes the file", () => {
    const store = createServiceTokenStore();
    store.write(token);
    store.clear();
    expect(createServiceTokenStore().read()).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");

describe("desktop extension manifest", () => {
  it("matches the package version and entry point", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.entry_point).toBe(pkg.main);
  });

  it("maps every user_config field to an environment variable and vice versa", () => {
    const env = manifest.server.mcp_config.env as Record<string, string>;
    const referenced = Object.values(env).flatMap((value) => [...value.matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((match) => match[1]));
    expect(new Set(referenced)).toEqual(new Set(Object.keys(manifest.user_config)));
  });

  it("signs in as the user and bundles no secrets", () => {
    expect(manifest.server.mcp_config.env.TEAMDYNAMIX_AUTH_METHOD).toBe("sso");
    expect(JSON.stringify(manifest)).not.toMatch(/WS_KEY|BEID|PASSWORD/);
  });
});

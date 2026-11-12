import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { dropUnfilledPlaceholders, envFileCandidates, resolveEnvFile } from "../src/env-file.js";

const home = join("h", "tdx");
const root = join("r", "clone");

describe("envFileCandidates", () => {
  it("uses TDX_ENV_FILE alone when set", () => {
    expect(envFileCandidates({ TDX_ENV_FILE: "/x/.env" }, home, root)).toEqual(["/x/.env"]);
  });
  it("prefers the per-user file over the project root", () => {
    expect(envFileCandidates({}, home, root)).toEqual([join(home, ".env"), join(root, ".env")]);
  });
});

describe("resolveEnvFile", () => {
  it("returns the first file that exists", () => {
    const only = (path: string) => path === join(root, ".env");
    expect(resolveEnvFile({}, home, root, only)).toBe(join(root, ".env"));
    expect(resolveEnvFile({}, home, root, () => true)).toBe(join(home, ".env"));
    expect(resolveEnvFile({}, home, root, () => false)).toBeUndefined();
  });
  it("does not fall back past an explicit TDX_ENV_FILE", () => {
    expect(resolveEnvFile({ TDX_ENV_FILE: "/x/.env" }, home, root, (path) => path !== "/x/.env")).toBeUndefined();
  });
});

describe("dropUnfilledPlaceholders", () => {
  it("removes literal user_config placeholders and keeps real values", () => {
    const env: NodeJS.ProcessEnv = { A: "${user_config.default_app_id}", B: "49", C: "pre ${user_config.x}" };
    expect(dropUnfilledPlaceholders(env)).toEqual(["A"]);
    expect(env).toEqual({ B: "49", C: "pre ${user_config.x}" });
  });
});

#!/usr/bin/env node
// @ts-check
/**
 * Builds the desktop extension bundle (.mcpb): the compiled server, its production dependencies
 * and manifest.json, zipped by the MCPB packer. Run after `npm run build`:  npm run pack:mcpb
 *
 * The bundle is built in CI and attached to releases. It is never committed.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (manifest.version !== pkg.version) {
  console.error(`pack-mcpb: manifest.json is ${manifest.version} but package.json is ${pkg.version}. Make them match.`);
  process.exit(1);
}
if (!existsSync("dist/index.js")) {
  console.error("pack-mcpb: dist/ is missing. Run `npm run build` first.");
  process.exit(2);
}

const stage = join("build", "mcpb");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "config"), { recursive: true });

cpSync("dist", join(stage, "dist"), { recursive: true });
for (const file of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "README.md"]) {
  if (existsSync(file)) cpSync(file, join(stage, file));
}
for (const file of ["tool-policy.json", "tool-policy.schema.json"]) cpSync(join("config", file), join(stage, "config", file));

// Production dependencies only. playwright-core stays an optional dependency, and the sign-in window
// uses the Edge or Chrome already on the machine, so no browser is bundled.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });

const output = join("build", `teamdynamix-mcp-server-${pkg.version}.mcpb`);
execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", stage, output], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`pack-mcpb: wrote ${output}`);

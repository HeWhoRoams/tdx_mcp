#!/usr/bin/env node
// @ts-check
/**
 * Verifies what `npm publish` would ship. Fails when the tarball would contain anything outside
 * the allowlist below, then runs the sensitive-content scanner over every file in it.
 *
 * Run after `npm run build`:  node scripts/check-package.mjs
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { run } from "./check-sensitive.mjs";

const ALLOWED = [/^dist\//, /^config\/tool-policy(?:\.schema)?\.json$/, /^(?:README\.md|LICENSE|package\.json)$/];

if (!existsSync("dist")) {
  console.error("check-package: dist/ is missing. Run `npm run build` first.");
  process.exit(2);
}

/** @type {{ files: { path: string }[] }[]} */
let packed;
try {
  const output = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  packed = JSON.parse(output);
} catch (error) {
  console.error(`check-package: could not list the package contents: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const files = (packed[0]?.files ?? []).map((file) => file.path.replace(/\\/g, "/"));
const unexpected = files.filter((path) => !ALLOWED.some((pattern) => pattern.test(path)));

console.log(`check-package: ${files.length} file(s) would be published`);
if (unexpected.length > 0) {
  console.error("check-package: these files are not on the publish allowlist (see package.json \"files\"):");
  for (const path of unexpected) console.error(`  ${path}`);
  process.exit(1);
}

process.exit(run(["--paths", ...files, "--require-terms"]));

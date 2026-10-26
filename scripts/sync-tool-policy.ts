/**
 * Rewrites config/tool-policy.json so every registered tool appears under
 * "tools", defaulting to "inherit". Run after adding or removing a tool.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allTools } from "../src/tools/index.js";

const POLICY_PATH = fileURLToPath(new URL("../config/tool-policy.json", import.meta.url));

interface PolicyFile {
  $schema?: string;
  defaults?: Record<string, string>;
  domains?: Record<string, Record<string, string>>;
  tools?: Record<string, string>;
  treatReadModifyWriteAsDestroy?: boolean;
}

const existing: PolicyFile = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const known = new Set(allTools.map((tool) => tool.name));
const previous = existing.tools ?? {};

const stale = Object.keys(previous).filter((name) => !known.has(name));
const added: string[] = [];

const tools: Record<string, string> = {};
for (const tool of allTools) {
  if (previous[tool.name] === undefined) added.push(tool.name);
  tools[tool.name] = previous[tool.name] ?? "inherit";
}

writeFileSync(POLICY_PATH, `${JSON.stringify({ ...existing, tools }, null, 2)}\n`, "utf8");

console.log(`Synced ${allTools.length} tools into ${POLICY_PATH}`);
if (added.length > 0) console.log(`  added: ${added.join(", ")}`);
if (stale.length > 0) console.log(`  removed: ${stale.join(", ")}`);

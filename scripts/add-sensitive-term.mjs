#!/usr/bin/env node
// @ts-check
/**
 * Adds an organization term to config/sensitive-terms.sha256 as a hash.
 *
 * The term is read from a masked terminal prompt, never from argv or an environment variable,
 * so it does not land in shell history, process listings or CI logs. The term is never echoed.
 *
 *   npm run sensitive:add-term              masked prompt (interactive terminal required)
 *   npm run sensitive:add-term -- --stdin   read one line from a pipe or file instead
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { hashesForTerm, parseTermsFile } from "./check-sensitive.mjs";

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "sensitive-terms.sha256");

const HEADER = [
  "# sensitive-terms-format: v1",
  "# SHA-256 hashes of organization terms that must never appear in this repository.",
  "# Add terms only with: npm run sensitive:add-term  (never write a term in this file or in a comment).",
];

/**
 * Adds terms to the hash file, keeping hashes sorted so file diffs reveal nothing about order.
 * @param {string} file
 * @param {string[]} rawTerms
 * @returns {{ added: number, skipped: number }}
 */
export function addTerms(file, rawTerms) {
  const current = existsSync(file) ? parseTermsFile(readFileSync(file, "utf8")) : { hashes: new Set(), lengths: [] };
  const hashes = new Set(current.hashes);
  const lengths = new Set(current.lengths);
  let added = 0;
  let skipped = 0;
  for (const raw of rawTerms) {
    const { hashes: termHashes, length } = hashesForTerm(raw);
    if (termHashes.every((hash) => hashes.has(hash))) {
      skipped += 1;
      continue;
    }
    for (const hash of termHashes) hashes.add(hash);
    if (length) lengths.add(length);
    added += 1;
  }
  const body = [...HEADER, `# lengths: ${[...lengths].sort((a, b) => a - b).join(",")}`, ...[...hashes].sort()];
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return { added, skipped };
}

/** @param {string} prompt @returns {Promise<string>} */
function readHidden(prompt) {
  return new Promise((resolveInput, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("stdin is not a terminal. Run this in an interactive terminal, or pass --stdin to read one line from a pipe."));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          cleanup();
          resolveInput(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

/** @returns {Promise<string>} */
function readPipedLine() {
  return new Promise((resolveInput) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolveInput(data.split(/\r?\n/)[0] ?? ""));
  });
}

async function main() {
  const term = process.argv.includes("--stdin") ? await readPipedLine() : await readHidden("Term to block (input hidden): ");
  const { added, skipped } = addTerms(DEFAULT_FILE, [term]);
  console.log(added ? "Added 1 term (stored as a hash). Commit config/sensitive-terms.sha256." : "That term is already in the list.");
  if (skipped && !added) process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`add-sensitive-term: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

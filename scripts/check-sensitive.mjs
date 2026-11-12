#!/usr/bin/env node
// @ts-check
/**
 * Sensitive-content scanner for this repository.
 *
 * Zero dependencies on purpose: it runs on plain Node 20 in CI *before* `npm install`, so a
 * malicious dependency or install script can never run ahead of the check.
 *
 * It looks for things that must never become public:
 *   - organization identifiers (matched against SHA-256 hashes, so the list does not publish them)
 *   - TeamDynamix credential shapes, tenant URLs, JWTs, institutional (.edu) email addresses
 *   - files that must never be tracked (.env, .mcp.json, tokens, browser profiles, ...)
 *   - the same things in commit metadata (author/committer, messages, branch names)
 *
 * Output never contains a matched value in full. CI logs on a public repository are public.
 *
 * Usage:
 *   node scripts/check-sensitive.mjs --tree                 every tracked file
 *   node scripts/check-sensitive.mjs --range <base>..<head> added lines + metadata of each commit
 *                                   (a single revision scans that revision's whole history)
 *   node scripts/check-sensitive.mjs --staged               staged additions (pre-commit hook)
 *   node scripts/check-sensitive.mjs --paths <file> [...]   specific files
 * Options:
 *   --terms <file>     hashed term list (default: config/sensitive-terms.sha256)
 *   --require-terms    fail instead of warn when the term list is missing or empty
 *
 * Suppress a finding on its own line with:  sensitive-scan: allow <rule-id> — <reason>
 * (a reason is required; org-term, metadata and forbidden-file findings cannot be suppressed).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── Hashed term matching ────────────────────────────────────────────────────────────────────

const FORMAT = "v1";
const MAX_NGRAM = 4;
const MIN_COMPACT_FOR_SUBSTRING = 5;
const MAX_RUN_FOR_SUBSTRING = 40;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** Hash of a normalized term: its words, lowercased, joined by single spaces. @param {string} spaced */
export const termHash = (spaced) => sha256(`${FORMAT}:${spaced}`);
/** Hash of a term with every separator removed, for matching inside run-together identifiers. @param {string} compact */
export const compactHash = (compact) => sha256(`${FORMAT}c:${compact}`);

// Split points inside an alphanumeric run: camelCase, ACRONYMWord, and letter/digit boundaries.
const SPLIT = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

/**
 * Lowercased word tokens with their positions. "user@Example.edu" gives user, example, edu;
 * "OrgPD2" gives org, pd, 2.
 * @param {string} text
 * @returns {{ text: string, index: number }[]}
 */
export function tokenize(text) {
  /** @type {{ text: string, index: number }[]} */
  const tokens = [];
  for (const match of text.matchAll(/[A-Za-z0-9]+/g)) {
    let offset = match.index ?? 0;
    for (const part of match[0].split(SPLIT)) {
      if (part) tokens.push({ text: part.toLowerCase(), index: offset });
      offset += part.length;
    }
  }
  return tokens;
}

/**
 * The hashes to store for a term, and the compact length to record (substring matching applies
 * to terms of 5+ characters only, so short terms never match inside unrelated words).
 * @param {string} raw
 * @returns {{ hashes: string[], length?: number }}
 */
export function hashesForTerm(raw) {
  const words = tokenize(raw).map((token) => token.text);
  if (words.length === 0 || words.length > MAX_NGRAM) throw new Error(`a term needs 1-${MAX_NGRAM} words`);
  const compact = words.join("");
  if (compact.length < 3) throw new Error("a term needs at least 3 letters or digits");
  const hashes = [termHash(words.join(" "))];
  if (compact.length < MIN_COMPACT_FOR_SUBSTRING) return { hashes };
  hashes.push(compactHash(compact));
  return { hashes, length: compact.length };
}

/**
 * @param {string} text
 * @returns {{ hashes: Set<string>, lengths: number[] }}
 */
export function parseTermsFile(text) {
  /** @type {Set<string>} */
  const hashes = new Set();
  /** @type {Set<number>} */
  const lengths = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const header = /^#\s*lengths:\s*([\d,\s]*)$/i.exec(line);
      if (header?.[1]) {
        for (const part of header[1].split(",")) {
          const value = Number.parseInt(part, 10);
          if (value > 0) lengths.add(value);
        }
      }
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(line)) throw new Error(`terms file line ${index + 1} is not a SHA-256 hash`);
    hashes.add(line);
  }
  return { hashes, lengths: [...lengths].sort((a, b) => a - b) };
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────

/** Rules that can never be silenced with an inline comment. */
const NOT_SUPPRESSIBLE = new Set(["org-term", "metadata", "forbidden-file"]);

const TENANT_URL = /(?<![\w-])([a-z0-9-]+)\.teamdynamix\.com/gi;
const TENANT_ALLOWED = new Set(["example", "yourorg", "org", "x", "sandbox", "solutions", "www", "docs"]);

const CREDENTIAL =
  /(TEAMDYNAMIX_(?:PASSWORD|WS_KEY|BEID|USERNAME|SSO_EXPECTED_USER)|MCP_AUTH_TOKEN)["'`]?\s*[=:]\s*["'`]?([^\s"'`#,;]{6,})/g;
// Values that are clearly not secrets: template markers, "your..." / "test-..." placeholders, and
// placeholder email addresses at documentation domains.
const PLACEHOLDER = /^(?:<|\$\{|your|changeme|example|test-|you@)|@(?:[\w-]+\.)*(?:example|x|yourorg)\.(?:edu|com|org|net)$/i;
// Code, not data: calls, generics, member access, type names, camelCase variables and CONSTANT_NAMES.
const CODE_REFERENCE =
  /[()<>]|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|^(?:string|number|boolean|undefined|null|true|false)$|^[a-z]+(?:[A-Z][a-z0-9]*)+$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]{20,}/g;

const EDU_EMAIL = /[\w.+-]+@((?:[\w-]+\.)*[\w-]+\.edu)\b/gi;
const EDU_ALLOWED = /^(?:[\w-]+\.)*(?:example|x|yourorg)\.edu$/i;

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const KEY_WORD = /BEID|WebServicesKey|WS_KEY/i;

const SUPPRESSION = /sensitive-scan:\s*allow\s+([a-z-]+)\s*(?:—|–|--|-|:)\s*(\S.*)$/i;

/**
 * @typedef {{ rule: string, col: number, len: number, detail: string }} LineFinding
 * @typedef {{ rule: string, file: string, line: number, col: number, detail: string }} Finding
 * @typedef {{ hashes: Set<string>, lengths: number[], local: RegExp[] }} Context
 */

/** Never print more than the shape of a value. @param {string} value */
export function mask(value) {
  if (value.length <= 12) return `${value.slice(0, 1)}… (len ${value.length})`;
  return `${value.slice(0, 2)}…${value.slice(-2)} (len ${value.length})`;
}

/**
 * @param {{ hashes: Set<string>, lengths: number[] }} terms
 * @param {string[]} localPatterns
 * @returns {Context}
 */
export function buildContext(terms, localPatterns = []) {
  return { hashes: terms.hashes, lengths: terms.lengths, local: localPatterns.map((pattern) => new RegExp(pattern, "i")) };
}

/**
 * Hashed organization terms: whole words and 2-4 word phrases anywhere in the line, plus
 * substrings of run-together identifiers for the recorded long-term lengths.
 * @param {Context} ctx
 * @param {string} text
 * @returns {LineFinding | undefined}
 */
function matchOrgTerms(ctx, text) {
  if (ctx.hashes.size === 0 && ctx.local.length === 0) return undefined;
  let hits = 0;
  let first;
  /** @param {number} col @param {number} len */
  const record = (col, len) => {
    hits += 1;
    first ??= { col, len };
  };

  if (ctx.hashes.size > 0) {
    const tokens = tokenize(text);
    for (let start = 0; start < tokens.length; start += 1) {
      let phrase = "";
      for (let size = 1; size <= MAX_NGRAM && start + size <= tokens.length; size += 1) {
        phrase = size === 1 ? tokens[start].text : `${phrase} ${tokens[start + size - 1].text}`;
        if (ctx.hashes.has(termHash(phrase))) {
          const last = tokens[start + size - 1];
          record(tokens[start].index + 1, last.index + last.text.length - tokens[start].index);
        }
      }
    }
    if (ctx.lengths.length > 0) {
      for (const run of text.matchAll(/[A-Za-z0-9]+/g)) {
        const lower = run[0].toLowerCase();
        if (lower.length > MAX_RUN_FOR_SUBSTRING) continue; // base64 and hashes, not identifiers
        for (const length of ctx.lengths) {
          for (let at = 0; at + length <= lower.length; at += 1) {
            if (ctx.hashes.has(compactHash(lower.slice(at, at + length)))) record((run.index ?? 0) + at + 1, length);
          }
        }
      }
    }
  }
  for (const pattern of ctx.local) {
    const match = pattern.exec(text);
    if (match) record(match.index + 1, match[0].length);
  }
  if (!first) return undefined;
  return { rule: "org-term", col: first.col, len: first.len, detail: `organization term match (${hits} hit${hits === 1 ? "" : "s"})` };
}

/**
 * @param {Context} ctx
 * @param {string} text
 * @param {string} [previous] the preceding line, for key/GUID proximity
 * @returns {LineFinding[]}
 */
export function scanLine(ctx, text, previous = "") {
  /** @type {LineFinding[]} */
  const findings = [];
  const org = matchOrgTerms(ctx, text);
  if (org) findings.push(org);

  for (const match of text.matchAll(TENANT_URL)) {
    if (!TENANT_ALLOWED.has(match[1].toLowerCase())) {
      findings.push({ rule: "tdx-tenant-url", col: (match.index ?? 0) + 1, len: match[0].length, detail: mask(match[1]) });
    }
  }

  for (const match of text.matchAll(CREDENTIAL)) {
    const value = match[2];
    if (PLACEHOLDER.test(value) || CODE_REFERENCE.test(value)) continue;
    findings.push({ rule: "credential-literal", col: (match.index ?? 0) + 1, len: match[0].length, detail: `${match[1]} = ${mask(value)}` });
  }

  for (const match of text.matchAll(JWT)) {
    findings.push({ rule: "jwt", col: (match.index ?? 0) + 1, len: match[0].length, detail: `eyJ… (len ${match[0].length})` });
  }

  for (const match of text.matchAll(EDU_EMAIL)) {
    if (!EDU_ALLOWED.test(match[1])) {
      findings.push({ rule: "institutional-email", col: (match.index ?? 0) + 1, len: match[0].length, detail: mask(match[0]) });
    }
  }

  for (const match of text.matchAll(GUID)) {
    const at = match.index ?? 0;
    const before = `${previous}\n${text}`.slice(0, previous.length + 1 + at).slice(-80);
    const after = text.slice(at + match[0].length, at + match[0].length + 80);
    if (KEY_WORD.test(before) || KEY_WORD.test(after)) {
      findings.push({ rule: "tdx-key-guid", col: at + 1, len: match[0].length, detail: mask(match[0]) });
    }
  }
  return findings;
}

/**
 * Drops findings silenced by a same-line `sensitive-scan: allow <rule> — <reason>` comment.
 * @param {string} text
 * @param {LineFinding[]} findings
 * @returns {{ kept: LineFinding[], suppressed: number }}
 */
export function applySuppressions(text, findings) {
  const comment = SUPPRESSION.exec(text);
  if (!comment) return { kept: findings, suppressed: 0 };
  const rule = comment[1].toLowerCase();
  if (NOT_SUPPRESSIBLE.has(rule)) return { kept: findings, suppressed: 0 };
  const kept = findings.filter((finding) => finding.rule !== rule || NOT_SUPPRESSIBLE.has(finding.rule));
  return { kept, suppressed: findings.length - kept.length };
}

/**
 * @param {Context} ctx
 * @param {string} file
 * @param {{ no: number, text: string }[]} lines
 * @param {{ suppressed: number }} stats
 * @returns {Finding[]}
 */
export function scanLines(ctx, file, lines, stats) {
  /** @type {Finding[]} */
  const out = [];
  let previous = "";
  for (const { no, text } of lines) {
    const { kept, suppressed } = applySuppressions(text, scanLine(ctx, text, previous));
    stats.suppressed += suppressed;
    for (const finding of kept) out.push({ rule: finding.rule, file, line: no, col: finding.col, detail: finding.detail });
    previous = text;
  }
  return out;
}

const FORBIDDEN_BASENAME = new Set([".mcp.json", ".sensitive-terms.local"]);
const FORBIDDEN_EXTENSION = /\.(?:pem|pfx|p12|har)$/i;

/**
 * Tracked paths that must never exist, plus hashed-term matches in the path itself.
 * @param {Context} ctx
 * @param {string} path
 * @returns {Finding[]}
 */
export function checkPath(ctx, path) {
  /** @type {Finding[]} */
  const findings = [];
  const name = basename(path);
  const forbidden =
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    FORBIDDEN_BASENAME.has(name) ||
    FORBIDDEN_EXTENSION.test(name) ||
    path === "config/tool-policy.local.json" ||
    /(^|\/)tokens\/sso-[^/]+\.json$/.test(path) ||
    /(^|\/)browser-profiles\//.test(path);
  if (forbidden) findings.push({ rule: "forbidden-file", file: path, line: 0, col: 0, detail: "this file must never be committed or published" });
  const org = matchOrgTerms(ctx, path);
  if (org) findings.push({ rule: "org-term", file: path, line: 0, col: org.col, detail: `${org.detail} in the file path` });
  return findings;
}

/**
 * Commit metadata: author/committer identity, message and ref names. GitHub noreply addresses
 * are public by design and are removed first.
 * @param {Context} ctx
 * @param {string} label
 * @param {string} text
 * @returns {Finding[]}
 */
export function scanMetadata(ctx, label, text) {
  const cleaned = text.replace(/[\w.+-]+@users\.noreply\.github\.com/g, "").replace(/noreply@github\.com/g, "");
  /** @type {Finding[]} */
  const out = [];
  for (const finding of scanLine(ctx, cleaned)) {
    if (finding.rule === "org-term" || finding.rule === "institutional-email") {
      out.push({ rule: "metadata", file: label, line: 0, col: 0, detail: `${finding.rule}: ${finding.detail}` });
    }
  }
  return out;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────────────────────

/**
 * Added lines per file from a `git diff/show -U0` patch. Hunk header counts decide which lines
 * are content, so an added line that itself starts with "++ " is not mistaken for a file header.
 * @param {string} patch
 * @returns {Map<string, { no: number, text: string }[]>}
 */
export function parseAddedLines(patch) {
  /** @type {Map<string, { no: number, text: string }[]>} */
  const files = new Map();
  /** @type {{ no: number, text: string }[] | undefined} */
  let current;
  let remaining = 0;
  let next = 0;
  for (const line of patch.split("\n")) {
    if (remaining > 0 && current) {
      if (line.startsWith("+")) {
        current.push({ no: next, text: line.slice(1).replace(/\r$/, "") });
        next += 1;
        remaining -= 1;
        continue;
      }
      if (line.startsWith("-") || line.startsWith("\\")) continue;
    }
    if (line.startsWith("diff --git ")) {
      current = undefined;
      remaining = 0;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t.*$/, "");
      if (target === "/dev/null") {
        current = undefined;
      } else {
        const path = target.startsWith("b/") ? target.slice(2) : target;
        current = files.get(path) ?? [];
        files.set(path, current);
      }
    } else if (line.startsWith("@@")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header) {
        next = Number.parseInt(header[1], 10);
        remaining = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
      }
    }
  }
  return files;
}

// ── Git access ───────────────────────────────────────────────────────────────────────────────

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** @param {string} root @param {string[]} args @returns {string[]} */
function gitList(root, args) {
  return git(root, args).split("\0").filter(Boolean);
}

/** @param {Buffer} buffer */
const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

/**
 * @param {Buffer} buffer
 * @returns {{ no: number, text: string }[]}
 */
function toLines(buffer) {
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((text, index) => ({ no: index + 1, text }));
}

/**
 * @typedef {{ files: number, commits: number, suppressed: number, skipped: number }} Stats
 */

/**
 * @param {Context} ctx @param {string} root @param {string[]} paths @param {Stats} stats @returns {Finding[]}
 */
function scanFilesOnDisk(ctx, root, paths, stats) {
  /** @type {Finding[]} */
  const out = [];
  for (const path of paths) {
    out.push(...checkPath(ctx, path));
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).size > MAX_FILE_BYTES) {
      stats.skipped += 1;
      continue;
    }
    const buffer = readFileSync(absolute);
    if (looksBinary(buffer)) {
      stats.skipped += 1;
      continue;
    }
    stats.files += 1;
    out.push(...scanLines(ctx, path, toLines(buffer), stats));
  }
  return out;
}

/**
 * @param {Context} ctx @param {Map<string, { no: number, text: string }[]>} added @param {Stats} stats @returns {Finding[]}
 */
function scanAdded(ctx, added, stats) {
  /** @type {Finding[]} */
  const out = [];
  for (const [path, lines] of added) {
    out.push(...scanLines(ctx, path, lines, stats));
  }
  return out;
}

/**
 * @param {Context} ctx @param {string} root @param {string} spec @param {Stats} stats @returns {Finding[]}
 */
function scanRange(ctx, root, spec, stats) {
  /** @type {Finding[]} */
  const out = [];
  const commits = git(root, ["rev-list", "--no-merges", "--reverse", spec]).split("\n").filter(Boolean);
  for (const sha of commits) {
    stats.commits += 1;
    const short = sha.slice(0, 10);
    const [authorName = "", authorEmail = "", committerName = "", committerEmail = "", ...message] = git(root, [
      "log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", sha,
    ]).split("\0");
    out.push(...scanMetadata(ctx, `commit ${short}`, [authorName, authorEmail, committerName, committerEmail, message.join("\0")].join("\n")));
    for (const path of gitList(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--diff-filter=AMR", sha])) {
      out.push(...checkPath(ctx, path));
    }
    const patch = git(root, ["show", "--format=", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR", sha]);
    out.push(...scanAdded(ctx, parseAddedLines(patch), stats));
  }
  for (const name of [process.env.GITHUB_HEAD_REF, process.env.GITHUB_REF_NAME]) {
    if (name) out.push(...scanMetadata(ctx, "ref name", name));
  }
  return out;
}

/**
 * @param {Context} ctx @param {string} root @param {Stats} stats @returns {Finding[]}
 */
function scanStaged(ctx, root, stats) {
  /** @type {Finding[]} */
  const out = [];
  for (const path of gitList(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=AMR"])) out.push(...checkPath(ctx, path));
  const patch = git(root, ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR"]);
  out.push(...scanAdded(ctx, parseAddedLines(patch), stats));
  // The identity this commit will carry is public once pushed.
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    try {
      out.push(...scanMetadata(ctx, `${variable.toLowerCase().replace("_ident", "")} identity`, git(root, ["var", variable])));
    } catch {
      // No identity configured; git will refuse the commit on its own.
    }
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/** @param {string} value */
const escapeProperty = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
/** @param {string} value */
const escapeData = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** @param {Finding} finding */
export function formatFinding(finding) {
  const where = `${finding.file}${finding.line ? `:${finding.line}` : ""}${finding.col && finding.line ? `:${finding.col}` : ""}`;
  return `${finding.rule}  ${where}  ${finding.detail}`;
}

/** @param {Finding} finding */
function annotate(finding) {
  const isFile = finding.line > 0 || !/^(commit |ref name|author|committer)/.test(finding.file);
  const location = isFile ? `file=${escapeProperty(finding.file)},line=${finding.line || 1},` : "";
  return `::error ${location}title=${escapeProperty(`sensitive-scan ${finding.rule}`)}::${escapeData(finding.detail)}`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { mode: "tree", spec: "", paths: /** @type {string[]} */ ([]), terms: "", requireTerms: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tree") args.mode = "tree";
    else if (arg === "--staged") args.mode = "staged";
    else if (arg === "--range") {
      args.mode = "range";
      args.spec = argv[(index += 1)] ?? "";
    } else if (arg === "--paths") {
      args.mode = "paths";
      args.paths = argv.slice(index + 1);
      break;
    } else if (arg === "--terms") args.terms = argv[(index += 1)] ?? "";
    else if (arg === "--require-terms") args.requireTerms = true;
    else if (arg === "--help" || arg === "-h") args.mode = "help";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.mode === "range" && !/^[^\s-][^\s]*$/.test(args.spec)) throw new Error("--range needs <base>..<head>, or a single revision to scan all of its history");
  return args;
}

/** @param {string[]} argv @returns {number} exit code */
export function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`check-sensitive: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (args.mode === "help") {
    console.log("usage: check-sensitive.mjs --tree | --range <base>..<head>|<rev> | --staged | --paths <file...> [--terms <file>] [--require-terms]");
    return 0;
  }

  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const termsPath = resolve(root, args.terms || "config/sensitive-terms.sha256");
    const terms = existsSync(termsPath) ? parseTermsFile(readFileSync(termsPath, "utf8")) : { hashes: new Set(), lengths: [] };
    if (terms.hashes.size === 0) {
      const message = "no hashed organization terms loaded; org-term matching is disabled (add some with: npm run sensitive:add-term)";
      if (args.requireTerms) {
        console.error(`check-sensitive: ${message}`);
        return 2;
      }
      console.warn(`check-sensitive: warning: ${message}`);
    }
    const localPath = resolve(root, ".sensitive-terms.local");
    const local = existsSync(localPath)
      ? readFileSync(localPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      : [];
    const ctx = buildContext(terms, local);

    /** @type {Stats} */
    const stats = { files: 0, commits: 0, suppressed: 0, skipped: 0 };
    /** @type {Finding[]} */
    let findings;
    if (args.mode === "tree") findings = scanFilesOnDisk(ctx, root, gitList(root, ["ls-files", "-z"]), stats);
    else if (args.mode === "range") findings = scanRange(ctx, root, args.spec, stats);
    else if (args.mode === "staged") findings = scanStaged(ctx, root, stats);
    else findings = scanFilesOnDisk(ctx, root, args.paths, stats);

    const inActions = process.env.GITHUB_ACTIONS === "true";
    for (const finding of findings) {
      console.log(formatFinding(finding));
      if (inActions) console.log(annotate(finding));
    }
    console.log(
      `check-sensitive (${args.mode}): ${stats.files} file(s), ${stats.commits} commit(s) scanned, ` +
        `${findings.length} finding(s), ${stats.suppressed} suppressed, ${stats.skipped} skipped`,
    );
    if (findings.length > 0) {
      console.log("Fix the findings above. Values are intentionally not printed. See README: Contributing > sensitive-content check.");
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`check-sensitive: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(run(process.argv.slice(2)));
}

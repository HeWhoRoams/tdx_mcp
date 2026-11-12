import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTerms } from "../scripts/add-sensitive-term.mjs";
import {
  applySuppressions,
  buildContext,
  checkPath,
  hashesForTerm,
  mask,
  parseAddedLines,
  parseTermsFile,
  run,
  scanLine,
  scanLines,
  scanMetadata,
  tokenize,
} from "../scripts/check-sensitive.mjs";

// Every sensitive-looking fixture is assembled at runtime so this file never matches its own rules.
const cred = (name: string, value: string) => `${"TEAMDYNAMIX_"}${name}=${value}`;
const SECRET = "A1b2C3d4" + "E5f6G7h8";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

// A throwaway organization that exists only in this test.
const LONG_TERM = "zebra" + "corp";
const SHORT_TERM = "z" + "cx";
const PHRASE = "zebra" + " " + "holdings";

function contextFor(terms: string[], local: string[] = []) {
  const hashes = new Set<string>();
  const lengths = new Set<number>();
  for (const term of terms) {
    const { hashes: termHashes, length } = hashesForTerm(term);
    for (const hash of termHashes) hashes.add(hash);
    if (length) lengths.add(length);
  }
  return buildContext({ hashes, lengths: [...lengths].sort((a, b) => a - b) }, local);
}

const ctx = contextFor([LONG_TERM, SHORT_TERM, PHRASE]);
const rules = (text: string, previous = "") => scanLine(ctx, text, previous).map((finding) => finding.rule);

describe("tokenize", () => {
  it("splits camelCase, acronyms, digits and email parts", () => {
    expect(tokenize("OrgPD2").map((token) => token.text)).toEqual(["org", "pd", "2"]);
    expect(tokenize("HTMLParser").map((token) => token.text)).toEqual(["html", "parser"]);
    expect(tokenize("pat@Example.edu").map((token) => token.text)).toEqual(["pat", "example", "edu"]);
  });
});

describe("terms", () => {
  it("refuses terms that are too short or too long", () => {
    expect(() => hashesForTerm("ab")).toThrow();
    expect(() => hashesForTerm("one two three four five")).toThrow();
  });

  it("records a substring length only for terms of five or more characters", () => {
    expect(hashesForTerm(LONG_TERM).length).toBe(LONG_TERM.length);
    expect(hashesForTerm(SHORT_TERM).length).toBeUndefined();
  });

  it("parses the lengths header and rejects anything that is not a hash", () => {
    const parsed = parseTermsFile(`# lengths: 5, 9\n${"a".repeat(64)}\n`);
    expect(parsed.lengths).toEqual([5, 9]);
    expect(parsed.hashes.size).toBe(1);
    expect(() => parseTermsFile("not-a-hash\n")).toThrow(/line 1/);
  });
});

describe("org-term rule", () => {
  it.each([
    ["a whole word", `welcome to ${LONG_TERM}`],
    ["different casing", `WELCOME TO ${LONG_TERM.toUpperCase()}`],
    ["a camelCase identifier", `const ${LONG_TERM.slice(0, 5)}${LONG_TERM.slice(5, 6).toUpperCase()}${LONG_TERM.slice(6)}Client = 1`],
    ["inside a run-together identifier", `const my${LONG_TERM}portal = 1`],
    ["a multi-word phrase", `owned by ${PHRASE.replace(" ", "_")}`],
    ["a hostname", `https://www.${LONG_TERM}.example.org/`],
    ["an email local part and domain", `me@${LONG_TERM}.com`],
    ["a short term before a capitalized word", `${SHORT_TERM.toUpperCase()}Device`],
  ])("matches %s", (_label, line) => {
    expect(rules(line)).toContain("org-term");
  });

  it("matches short terms only as whole words", () => {
    expect(rules(`value ${SHORT_TERM} here`)).toContain("org-term");
    expect(rules(`value ${SHORT_TERM}foo here`)).not.toContain("org-term");
  });

  it("ignores unrelated text and long base64-like runs", () => {
    expect(rules("nothing to see here")).toEqual([]);
    expect(rules(`sha512-${"x".repeat(60)}${LONG_TERM}${"y".repeat(60)}`)).not.toContain("org-term");
  });

  it("supports local regex patterns and reports no matched text", () => {
    const local = contextFor([], ["acme-\\d+"]);
    const findings = scanLine(local, "ticket acme-42 opened");
    expect(findings[0]?.rule).toBe("org-term");
    expect(JSON.stringify(findings)).not.toContain("acme-42");
  });

  it("never reports the matched term", () => {
    const [finding] = scanLine(ctx, `hello ${LONG_TERM}`);
    expect(JSON.stringify(finding)).not.toContain(LONG_TERM);
  });
});

describe("tenant urls", () => {
  it("flags a real tenant subdomain and allows documentation hosts", () => {
    expect(rules(`url = https://${"real" + "tenant"}.teamdynamix.com/TDWebApi`)).toContain("tdx-tenant-url");
    expect(rules("see https://sandbox.teamdynamix.com/SBTDWebApi")).not.toContain("tdx-tenant-url");
    expect(rules("e.g. https://yourorg.teamdynamix.com")).not.toContain("tdx-tenant-url");
    expect(rules("https://solutions.teamdynamix.com/TDWebApi/")).not.toContain("tdx-tenant-url");
  });

  it("catches a host written without a scheme", () => {
    expect(rules(`${"real" + "tenant"}.teamdynamix.com`)).toContain("tdx-tenant-url");
  });
});

describe("credential-literal rule", () => {
  it("flags real-looking literals in env, JSON and code syntax", () => {
    expect(rules(cred("WS_KEY", SECRET))).toContain("credential-literal");
    expect(rules(`  "${"TEAMDYNAMIX_"}PASSWORD": "${SECRET}"`)).toContain("credential-literal");
    expect(rules(`${"MCP_AUTH_"}TOKEN: '${SECRET}'`)).toContain("credential-literal");
  });

  it("does not flag placeholders, empty values or code references", () => {
    expect(rules(cred("WS_KEY", ""))).not.toContain("credential-literal");
    expect(rules(cred("WS_KEY", "<your-key>"))).not.toContain("credential-literal");
    expect(rules(cred("WS_KEY", "your-service-key"))).not.toContain("credential-literal");
    expect(rules(cred("WS_KEY", "test-key-value"))).not.toContain("credential-literal");
    expect(rules(cred("USERNAME", "you@yourorg.edu"))).not.toContain("credential-literal");
    expect(rules(`${"TEAMDYNAMIX_"}BEID: z.string().optional(),`)).not.toContain("credential-literal");
    expect(rules(`${"TEAMDYNAMIX_"}BEID: raw.${"TEAMDYNAMIX_"}BEID,`)).not.toContain("credential-literal");
    expect(rules(`${"TEAMDYNAMIX_"}BEID: z.ZodOptional<z.ZodString>;`)).not.toContain("credential-literal");
    expect(rules(`${"MCP_AUTH_"}TOKEN: authToken,`)).not.toContain("credential-literal");
    expect(rules(`${"MCP_AUTH_"}TOKEN: MCP_SECRET,`)).not.toContain("credential-literal");
  });

  it("never prints the credential value", () => {
    const findings = scanLine(ctx, cred("WS_KEY", SECRET));
    expect(JSON.stringify(findings)).not.toContain(SECRET);
  });
});

describe("jwt rule", () => {
  const token = (signature: string) => `${b64({ alg: "HS256" })}.${b64({ sub: "x" })}.${signature}`;

  it("flags a token with a real-length signature and allows short fixture signatures", () => {
    expect(rules(`Authorization: Bearer ${token("S".repeat(43))}`)).toContain("jwt");
    expect(rules(`const t = "${token("sig")}"`)).not.toContain("jwt");
  });
});

describe("institutional-email rule", () => {
  it("flags .edu addresses but not documentation domains", () => {
    expect(rules(`contact ${"pat"}@${"somecollege"}.edu`)).toContain("institutional-email");
    expect(rules("contact pat@example.edu")).not.toContain("institutional-email");
    expect(rules("contact pat@x.edu")).not.toContain("institutional-email");
    expect(rules("contact you@yourorg.edu")).not.toContain("institutional-email");
  });
});

describe("tdx-key-guid rule", () => {
  const guid = "11111111-2222-3333-4444-555555555555";
  const keyword = "BE" + "ID";

  it("flags a GUID next to a BEID or key label, including on the previous line", () => {
    expect(rules(`${keyword}: ${guid}`)).toContain("tdx-key-guid");
    expect(rules(guid, `${keyword}:`)).toContain("tdx-key-guid");
    expect(rules(`WebServices${"Key"}=${guid}`)).toContain("tdx-key-guid");
  });

  it("ignores GUIDs with no key label nearby", () => {
    expect(rules(`uid: ${guid}`)).not.toContain("tdx-key-guid");
  });
});

describe("suppression", () => {
  it("silences a suppressible rule only with a reason", () => {
    const line = cred("WS_KEY", SECRET);
    const findings = scanLine(ctx, line);
    const withReason = applySuppressions(`${line} // sensitive-scan: allow credential-literal — fixture`, findings);
    expect(withReason.kept).toEqual([]);
    expect(withReason.suppressed).toBe(1);
    const noReason = applySuppressions(`${line} // sensitive-scan: allow credential-literal`, findings);
    expect(noReason.kept).toHaveLength(findings.length);
  });

  it("cannot silence an organization term", () => {
    const line = `${LONG_TERM} // sensitive-scan: allow org-term — nope`;
    const result = applySuppressions(line, scanLine(ctx, line));
    expect(result.kept.map((finding) => finding.rule)).toContain("org-term");
    expect(result.suppressed).toBe(0);
  });

  it("counts suppressions through scanLines", () => {
    const stats = { suppressed: 0 };
    const text = `${cred("WS_KEY", SECRET)} # sensitive-scan: allow credential-literal — example`;
    expect(scanLines(ctx, "f.txt", [{ no: 1, text }], stats)).toEqual([]);
    expect(stats.suppressed).toBe(1);
  });
});

describe("checkPath", () => {
  it.each([
    [".env"],
    [".env.local"],
    ["nested/.env.production"],
    [".mcp.json"],
    [".sensitive-terms.local"],
    ["config/tool-policy.local.json"],
    ["certs/server.pem"],
    ["capture.har"],
    ["state/tokens/sso-abc123.json"],
    ["state/browser-profiles/sso-abc/Cookies"],
  ])("rejects %s", (path) => {
    expect(checkPath(ctx, path).map((finding) => finding.rule)).toContain("forbidden-file");
  });

  it.each([[".env.example"], ["config/tool-policy.json"], ["src/index.ts"]])("allows %s", (path) => {
    expect(checkPath(ctx, path)).toEqual([]);
  });

  it("matches organization terms inside a path", () => {
    expect(checkPath(ctx, `docs/${LONG_TERM}-notes.md`).map((finding) => finding.rule)).toContain("org-term");
  });
});

describe("scanMetadata", () => {
  it("flags organization terms and .edu addresses in commit identity", () => {
    expect(scanMetadata(ctx, "commit abc", `Pat\npat@${LONG_TERM}.com\nfix`)).toHaveLength(1);
    expect(scanMetadata(ctx, "commit abc", `Pat\npat@${"somecollege"}.edu`)).toHaveLength(1);
  });

  it("ignores GitHub noreply addresses, which are public by design", () => {
    expect(scanMetadata(ctx, "commit abc", `12345+${LONG_TERM}@users.noreply.github.com`)).toEqual([]);
  });

  it("is not suppressible and never prints the term", () => {
    const [finding] = scanMetadata(ctx, "commit abc", `owner ${LONG_TERM}`);
    expect(finding?.rule).toBe("metadata");
    expect(JSON.stringify(finding)).not.toContain(LONG_TERM);
  });
});

describe("parseAddedLines", () => {
  it("returns added lines with their new line numbers across hunks and files", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,0 +2,2 @@",
      "+first",
      "+second",
      "@@ -9 +11 @@",
      "-old",
      "+replacement",
      "diff --git a/b.txt b/b.txt",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+only",
      "",
    ].join("\n");
    const parsed = parseAddedLines(patch);
    expect(parsed.get("a.txt")).toEqual([
      { no: 2, text: "first" },
      { no: 3, text: "second" },
      { no: 11, text: "replacement" },
    ]);
    expect(parsed.get("b.txt")).toEqual([{ no: 1, text: "only" }]);
  });

  it("does not mistake an added line that starts with '++ ' for a file header", () => {
    const patch = ["diff --git a/a.txt b/a.txt", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+++ looks like a header", "+real"].join("\n");
    expect(parsed(patch)).toEqual([
      { no: 1, text: "++ looks like a header" },
      { no: 2, text: "real" },
    ]);

    function parsed(text: string) {
      return parseAddedLines(text).get("a.txt");
    }
  });
});

describe("mask", () => {
  it("never reveals more than the edges of a value", () => {
    expect(mask("short")).toBe("s… (len 5)");
    expect(mask("a-much-longer-secret-value")).toBe("a-…ue (len 26)");
  });
});

describe("command line, in a throwaway git repository", () => {
  const dirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  }

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "sensitive-scan-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "config"));
    addTerms(join(dir, "config", "sensitive-terms.sha256"), [LONG_TERM]);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    return dir;
  }

  function scan(dir: string, ...args: string[]) {
    process.chdir(dir);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => void lines.push(parts.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...parts) => void lines.push(parts.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...parts) => void lines.push(parts.join(" ")));
    const code = run(args);
    return { code, output: lines.join("\n") };
  }

  it("catches a secret that was added and then removed inside the range", () => {
    const dir = repo();
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "leak.txt"), `${cred("WS_KEY", SECRET)}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add config");
    writeFileSync(join(dir, "leak.txt"), "cleaned\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "remove it again");
    const head = git(dir, "rev-parse", "HEAD");

    expect(scan(dir, "--tree", "--require-terms").code).toBe(0);
    const result = scan(dir, "--range", `${base}..${head}`, "--require-terms");
    expect(result.code).toBe(1);
    expect(result.output).toContain("credential-literal");
    expect(result.output).not.toContain(SECRET);
  });

  it("scans commit metadata and flags forbidden files in the range", () => {
    const dir = repo();
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, ".mcp.json"), "{}\n");
    git(dir, "add", "-f", "-A");
    git(dir, "commit", "-qm", `notes about ${LONG_TERM}`);
    const result = scan(dir, "--range", `${base}..HEAD`, "--require-terms");
    expect(result.code).toBe(1);
    expect(result.output).toContain("forbidden-file");
    expect(result.output).toContain("metadata");
    expect(result.output).not.toContain(LONG_TERM);
  });

  it("fails closed when the term list is required but empty", () => {
    const dir = repo();
    writeFileSync(join(dir, "config", "sensitive-terms.sha256"), "# empty\n");
    expect(scan(dir, "--tree", "--require-terms").code).toBe(2);
  });

  it("scans staged additions", () => {
    const dir = repo();
    writeFileSync(join(dir, "new.txt"), `visit ${LONG_TERM}\n`);
    git(dir, "add", "-A");
    const result = scan(dir, "--staged", "--require-terms");
    expect(result.code).toBe(1);
    expect(result.output).toContain("org-term");
    expect(result.output).not.toContain(LONG_TERM);
  });

  it("scans a revision's whole history when given a single revision", () => {
    const dir = repo();
    writeFileSync(join(dir, "leak.txt"), `${cred("WS_KEY", SECRET)}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add config");
    const result = scan(dir, "--range", "HEAD", "--require-terms");
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/2 commit\(s\) scanned/);
  });

  it("rejects bad arguments", () => {
    expect(scan(repo(), "--range", "does-not-exist..HEAD").code).toBe(2);
    expect(scan(repo(), "--range", "--tree").code).toBe(2);
    expect(scan(repo(), "--bogus").code).toBe(2);
  });
});

describe("this repository", () => {
  const inGit = (() => {
    try {
      execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!inGit)("passes its own tree scan with the real hashed term list", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => void lines.push(parts.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const code = run(["--tree", "--require-terms"]);
    expect(lines.join("\n")).toMatch(/0 finding\(s\)/);
    expect(code).toBe(0);
  });
});

import { loadPlaywright } from "./playwright.js";

export interface HermesCompatArgs {
  realm: "sandbox" | "production";
  allowProduction: boolean;
}

export function parseHermesCompatArgs(args: string[]): HermesCompatArgs {
  const index = args.indexOf("--realm");
  const realm = index >= 0 ? args[index + 1] : undefined;
  if (realm !== "sandbox" && realm !== "production") {
    throw new Error("Usage: npm run test:hermes-sso -- --realm sandbox [--allow-production]");
  }
  return { realm, allowProduction: args.includes("--allow-production") };
}

/** The gate refuses to touch production unless asked, and refuses a realm that is not the configured one. */
export function assertRealmAllowed(configured: "sandbox" | "production", args: HermesCompatArgs): void {
  if (args.realm === "production" && !args.allowProduction) throw new Error("Production requires --allow-production.");
  if (configured !== args.realm) throw new Error("Configured TeamDynamix realm does not match --realm.");
}

export interface TargetReport {
  unrelatedTargetsBefore: number;
  unrelatedTargetsAfter: number;
  unchanged: boolean;
  /** Target ids only; never URLs or titles. */
  added: string[];
  removed: string[];
}

/** Compares the browser's tabs before and after, ignoring tabs the server itself owns. */
export function compareTargets(before: string[], after: string[], ownedIds: string[] = []): TargetReport {
  const owned = new Set(ownedIds);
  const b = new Set(before.filter((id) => !owned.has(id)));
  const a = new Set(after.filter((id) => !owned.has(id)));
  const added = [...a].filter((id) => !b.has(id)).sort();
  const removed = [...b].filter((id) => !a.has(id)).sort();
  return {
    unrelatedTargetsBefore: b.size,
    unrelatedTargetsAfter: a.size,
    unchanged: added.length === 0 && removed.length === 0,
    added,
    removed,
  };
}

export interface Mint {
  uid?: string;
  fingerprint: string;
}

export interface CompatVerdict {
  ok: boolean;
  failures: string[];
  report: { realm: string; uid?: string; targets: TargetReport; distinctMints: boolean; sameUser: boolean };
}

export function evaluateCompat(input: {
  realm: string;
  targetsBefore: string[];
  targetsAfter: string[];
  first: Mint;
  second: Mint;
}): CompatVerdict {
  const targets = compareTargets(input.targetsBefore, input.targetsAfter);
  const distinctMints = input.first.fingerprint !== input.second.fingerprint;
  const sameUser = input.first.uid === input.second.uid;
  const failures: string[] = [];
  if (!targets.unchanged) failures.push("The set of unrelated browser tabs changed during renewal.");
  if (!distinctMints) failures.push("The second renewal returned the same token; the browser may not be renewing.");
  if (!sameUser) failures.push("The signed-in user changed between renewals.");
  return {
    ok: failures.length === 0,
    failures,
    report: { realm: input.realm, ...(input.first.uid ? { uid: input.first.uid } : {}), targets, distinctMints, sameUser },
  };
}

export interface TargetLister {
  targetIds(): Promise<string[]>;
  disconnect(): Promise<void>;
}

async function defaultConnect(endpoint: string): Promise<TargetLister> {
  const playwright = await loadPlaywright("The Hermes compatibility gate needs the optional playwright-core package.");
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  return {
    async targetIds() {
      const session = await browser.newBrowserCDPSession();
      const { targetInfos } = await session.send("Target.getTargets");
      return (targetInfos as Array<{ type: string; targetId: string }>)
        .filter((target) => target.type === "page")
        .map((target) => target.targetId);
    },
    disconnect: () => browser.close(),
  };
}

/** Lists page target ids (ids only) of the Hermes browser. */
export async function listCdpTargetIds(
  endpoint: string,
  connect: (endpoint: string) => Promise<TargetLister> = defaultConnect
): Promise<string[]> {
  const lister = await connect(endpoint);
  try {
    return await lister.targetIds();
  } finally {
    await lister.disconnect().catch(() => undefined);
  }
}

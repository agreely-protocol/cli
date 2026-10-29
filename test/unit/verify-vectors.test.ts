// `agreely verify` run end to end on the SDK's own vectors, copied verbatim from @agreely/sdk vectors/ into
// test/fixtures/vectors: the JSON is the SDK's result passed through, and each reading's human line and exit code
// are the CLI's. The chain and the IPFS gateways are local stubs on 127.0.0.1 (./chain.ts): no live network.
// TRAP: the vectors read Base Sepolia and the CLI reads Base mainnet only, so every case runs re-pointed on mainnet
// (the salted bundle's issuer delegation and the AnchorBatch log address). No signature the SDK checks moves.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { onMainnetAnswers, onMainnetBundle, withChain, withGateways, type GatewayAnswer, type VectorAnswers } from "./chain.js";
import { argv, makeIo } from "./harness.js";

const vector = (rel: string): string => fileURLToPath(new URL(`../fixtures/vectors/${rel}`, import.meta.url));
const read = async <T>(rel: string): Promise<T> => JSON.parse(await readFile(vector(rel), "utf8")) as T;

let dir = "";
let didDocs: string[] = [];
let v4DidDocs: string[] = [];

/** A DID document map (did -> document) written one file per document, for --did-doc. */
async function didDocFlags(rel: string, prefix: string): Promise<string[]> {
  const docs = await read<Record<string, unknown>>(rel);
  const flags: string[] = [];
  let i = 0;
  for (const doc of Object.values(docs)) {
    const path = join(dir, `${prefix}-${String(i++)}.did.json`);
    await writeFile(path, JSON.stringify(doc));
    flags.push("--did-doc", path);
  }
  return flags;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agreely-cli-vectors-"));
  didDocs = await didDocFlags("receipts/did-documents.json", "receipts");
  v4DidDocs = await didDocFlags("receipts/v4-did-documents.json", "v4");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Run = { code: number; out: string; json: Record<string, unknown> };

async function verify(file: string, ...extra: string[]): Promise<{ json: Run; human: Run }> {
  const once = async (args: string[], tty: boolean): Promise<Run> => {
    const io = makeIo({ isTTY: tty });
    const code = await run(argv("verify", file, ...args), io.io);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(io.out().trim()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { code, out: io.out(), json };
  };
  return { json: await once([...extra, "--json"], false), human: await once(extra, true) };
}

async function writeBundle(name: string, bundle: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(bundle));
  return path;
}

/** The vector's expectation, field by field (the SDK's test/unit/vectorCase.ts). */
function expectFields(result: Record<string, unknown>, want: Record<string, unknown>): void {
  const companyKey = result["companyKey"] as { verdict?: string; rotated?: boolean } | undefined;
  const signedAnchor = result["signedAnchor"] as { binding?: string } | undefined;
  for (const [key, value] of Object.entries(want)) {
    if (key === "absent") {
      for (const field of value as string[]) expect(result).not.toHaveProperty(field);
    } else if (key === "companyKeyVerdict") {
      expect(companyKey?.verdict, key).toBe(value);
    } else if (key === "companyKeyRotated") {
      expect(companyKey?.rotated, key).toBe(value);
    } else if (key === "signedAnchorBinding") {
      expect(signedAnchor?.binding, key).toBe(value);
    } else if (key === "citizenKey") {
      expect(result["citizenKey"], key).toMatchObject(value as object);
    } else if (key === "counts") {
      expect(result["consentAnchorCounts"], key).toEqual(value);
    } else if (key !== "readRefs" && key !== "getLogsCalls" && key !== "tried") {
      expect(result[key], key).toEqual(value);
    }
  }
}

// The line each reading prints, written out here so that a changed mapping reddens.
const CITIZEN_LINE: Record<string, string> = {
  chainConfirmed: "inForce: recorded on chain in force at grantedAt, and the consent's anchor bounds that date",
  pending: "pending: not recorded on chain yet: recording can take up to 72 hours after grantedAt",
  notRecorded: "notRecorded: still not recorded on chain 72 hours after grantedAt, which withholds the verdict",
  voided: "voided: recorded on chain as voided, which withholds the verdict",
  notInForce: "notInForce: recorded on chain as NOT in force at grantedAt (not valid yet, or retired)",
  recordedLate: "recordedLate: recorded on chain more than 72 hours after grantedAt",
  unreachable: "unreachable: the registry could not be read",
  unreadable: "unreadable: the bundle's citizenKeySalt or the registry's answer cannot be read, which withholds the verdict",
  notLinked:
    "notLinked: the bundle carries no citizenKeySalt, so the key cannot be looked up on chain, which withholds the verdict",
  grantedAfterConsentAnchor: "inForce: grantedAt is later than the consent's own anchor allows, so the date is contradicted",
  consentRecordedLate: "inForce: grantedAt falls more than 72 hours before the consent's earliest anchor, which withholds the verdict",
};

const COMPANY_LINE: Record<string, string> = {
  authentic: "authentic: read on chain as in force on its domain at the instant it signed",
  "key-not-authorised": "key-not-authorised: read on chain as NOT in force on its domain at the instant it signed",
  "signed-after-anchor": "signed-after-anchor: it signed later than the consent's own anchor allows, so the signing date is contradicted",
  pending: "pending: no window on its domain is recorded on chain yet",
  voided: "voided: its window is recorded on chain as voided",
  unreachable: "unreachable: the registry could not be read",
  "retired-issuer-dated": "retired-issuer-dated: retired since, and the instant it signed is the issuer's own date, which no anchor bounds",
};

const SIGNED_LINE: Record<string, string> = {
  bound: "signedAnchor      bound  the bundle's root and refs are the ones the receipt signs: the chain is read on the signed refs",
  contradicts: "signedAnchor      contradicts  the bundle's root, or a ref it carries, is not one the receipt signs",
  malformed:
    "signedAnchor      malformed  a signed anchor member is missing or malformed, or the bundle carries no root: no anchor is tied",
};

function expectKeyLines(out: string, json: Record<string, unknown>): void {
  const company = json["companyKey"] as { verdict: string } | undefined;
  if (company !== undefined) {
    expect(COMPANY_LINE[company.verdict], `a line for the company verdict ${company.verdict}`).toBeDefined();
    expect(out).toContain(`companyKey        ${String(json["companyKeyRegistry"])}  ${COMPANY_LINE[company.verdict]!}`);
  }
  const citizen = json["citizenKey"] as { reason: string } | undefined;
  if (citizen !== undefined) {
    expect(CITIZEN_LINE[citizen.reason], `a line for the citizen reason ${citizen.reason}`).toBeDefined();
    expect(out).toContain(`citizenKey        ${String(json["citizenKeyChain"])}  ${CITIZEN_LINE[citizen.reason]!}`);
  }
}

interface ChainCase {
  name: string;
  rpc: boolean;
  now: string;
  citizenKeySalt?: string | null;
  answers: VectorAnswers | null;
  expect: Record<string, unknown> & { citizenKey?: { reason: string } };
}

// The exit code of each case, as the header of src/commands/verify.ts maps it.
const CHAIN_EXIT: Record<string, number> = {
  "a key in force at grantedAt reads green": EXIT.OK,
  "a key never recorded, now one second before G + LAG, is pending and neutral": EXIT.OK,
  "a key never recorded, now at G + LAG, reads notRecorded and withholds": EXIT.UNAVAILABLE,
  "a voided key record withholds the key and leaves the root untrusted": EXIT.UNAVAILABLE,
  "a key not yet valid at grantedAt is refused": EXIT.VERIFY_FAILED,
  "a key retired before grantedAt is refused": EXIT.VERIFY_FAILED,
  "a key recorded more than LAG after grantedAt is amber but does not withhold": EXIT.OK,
  "a keyOf read that fails is unreachable and neutral": EXIT.OK,
  "a keyOf answer that does not decode is unreadable and withholds": EXIT.UNAVAILABLE,
  "a malformed salt is unreadable and withholds, with no keyOf read": EXIT.UNAVAILABLE,
  "a salt absent on a registry that serves keyOf reads notLinked and withholds": EXIT.UNAVAILABLE,
  "a salt absent without an rpcUrl changes nothing": EXIT.OK,
  "a salted bundle without an rpcUrl reads no key": EXIT.OK,
  "a consent anchored more than SKEW before grantedAt is refused, and so is the company key's date": EXIT.VERIFY_FAILED,
  "a consent anchored more than LAG after grantedAt reads consentRecordedLate and withholds": EXIT.UNAVAILABLE,
  "a company key retired before grantedAt is refused": EXIT.VERIFY_FAILED,
  "a company key with no window on its domain is pending and not confirmed": EXIT.UNAVAILABLE,
  "a voided company key is refused": EXIT.VERIFY_FAILED,
  "a companyKeyOf read that fails leaves the company key unconfirmed": EXIT.UNAVAILABLE,
  "a company that has since rotated its key still verifies, and says so": EXIT.OK,
};

const CHAIN = await read<{ bundle: string; cases: ChainCase[] }>("citizen-key-chain.json");

describe("citizen-key-chain.json: both keys read on chain, through the CLI", () => {
  it("every vector case has an exit code here", () => {
    expect(CHAIN.cases.map((c) => c.name).sort()).toEqual(Object.keys(CHAIN_EXIT).sort());
  });

  it.each(CHAIN.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const bundle = onMainnetBundle(await read<Record<string, unknown>>(CHAIN.bundle));
    if (c.citizenKeySalt === null) delete bundle["citizenKeySalt"];
    else if (c.citizenKeySalt !== undefined) bundle["citizenKeySalt"] = c.citizenKeySalt;
    const path = await writeBundle("ck.bundle.json", bundle);
    const now = ["--now", new Date(Number(c.now) * 1000).toISOString()];

    await withChain(onMainnetAnswers(c.answers ?? {}), async (chain) => {
      const onchain = c.rpc ? ["--onchain", "--rpc-url", chain.url] : [];
      const { json, human } = await verify(path, ...didDocs, ...now, ...onchain);
      expectFields(json.json, c.expect);
      expect(json.code).toBe(CHAIN_EXIT[c.name]);
      expect(human.code).toBe(CHAIN_EXIT[c.name]);
      if (c.rpc) {
        expectKeyLines(human.out, json.json);
      } else {
        expect(chain.calls).toBe(0);
        expect(human.out).not.toContain("companyKey ");
        expect(human.out).not.toContain("citizenKey ");
      }
    });
  });
});

describe("what the matrix says when a key reading holds back the verdict", () => {
  async function chainCase(name: string): Promise<{ json: Run; human: Run }> {
    const c = CHAIN.cases.find((k) => k.name === name)!;
    const bundle = onMainnetBundle(await read<Record<string, unknown>>(CHAIN.bundle));
    if (c.citizenKeySalt === null) delete bundle["citizenKeySalt"];
    else if (c.citizenKeySalt !== undefined) bundle["citizenKeySalt"] = c.citizenKeySalt;
    const path = await writeBundle("ck-says.bundle.json", bundle);
    let result: { json: Run; human: Run } | null = null;
    await withChain(onMainnetAnswers(c.answers ?? {}), async (chain) => {
      result = await verify(path, ...didDocs, "--now", new Date(Number(c.now) * 1000).toISOString(), "--onchain", "--rpc-url", chain.url);
    });
    return result!;
  }

  it("a person's key withheld says so, and that it is not a refusal, never the connectivity advice", async () => {
    const { human } = await chainCase("a salt absent on a registry that serves keyOf reads notLinked and withholds");
    expect(human.out).toContain("? UNAVAILABLE");
    expect(human.out).toContain("PERSON'S KEY WITHHELD ON CHAIN (notLinked)");
    expect(human.out).toContain("It is not a refusal: a refusal on chain reads FAILED.");
    expect(human.out).not.toContain("retry with connectivity");
    expect(human.out).not.toContain("COMPANY KEY NOT CONFIRMED");
  });

  it("a company key with no window yet says it is not confirmed, never the connectivity advice", async () => {
    const { human } = await chainCase("a company key with no window on its domain is pending and not confirmed");
    expect(human.out).toContain("COMPANY KEY NOT CONFIRMED ON CHAIN (pending)");
    expect(human.out).not.toContain("retry with connectivity");
  });

  it("a company key the registry could not answer for keeps the connectivity advice, and says it is not a forgery", async () => {
    const { human } = await chainCase("a companyKeyOf read that fails leaves the company key unconfirmed");
    expect(human.out).toContain("COMPANY KEY NOT CONFIRMED ON CHAIN (unreachable)");
    expect(human.out).toContain("This is NOT a forgery: retry with connectivity");
  });

  it("a rotated company key still verifies, and the line says the company rotated", async () => {
    const { human } = await chainCase("a company that has since rotated its key still verifies, and says so");
    expect(human.code).toBe(EXIT.OK);
    expect(human.out).toContain("(assurance-boreale.example), and the company has since rotated to another key");
  });

  it("a refusal on chain reads FAILED, never unavailable", async () => {
    const { human } = await chainCase("a voided company key is refused");
    expect(human.out).toContain("✗ FAILED");
    expect(human.out).toContain("companyKey        fail  voided: its window is recorded on chain as voided");
  });
});

interface V4Case {
  name: string;
  file: string;
  answers: VectorAnswers | null;
  expect: Record<string, unknown> & { readRefs?: string[] };
}

const V4_EXIT: Record<string, number> = {
  "a3v4 bound, read on the signed refs": EXIT.OK,
  "a4v4 bound is partial, read on the signed refs": EXIT.OK,
  "a3v4 offline: bound, nothing read": EXIT.OK,
  "a3v4 with a withdrawn cell reads withdrawn": EXIT.WITHDRAWN,
  "a3v4 whose anchor predates its signing is a contradiction": EXIT.VERIFY_FAILED,
  "a3v4 anchored inside the skew of its signing is bound": EXIT.OK,
  "a3v4 under an unconfirmed company key reads nothing on the signed refs": EXIT.UNAVAILABLE,
  "a3v4 under a company key retired before its signing is refused": EXIT.VERIFY_FAILED,
  "a3v4 under a retired key on its own date is not confirmed": EXIT.UNAVAILABLE,
  "a3v4 whose envelope root differs contradicts its signature": EXIT.VERIFY_FAILED,
  "a3v4 contradicts offline too": EXIT.VERIFY_FAILED,
  "a3v4 whose envelope carries a ref the signature does not contradicts it": EXIT.VERIFY_FAILED,
  "a3v4 whose envelope names fewer refs is bound, and the signed refs are read": EXIT.OK,
  // Bound to no anchor, so --onchain reads no withdrawal: 4, as the header says.
  "a3v4 missing a signed member ties no anchor": EXIT.UNAVAILABLE,
  "a3v4 with no envelope root ties no anchor": EXIT.UNAVAILABLE,
  "a v3 carrying an anchor is a mismatch, never verified": EXIT.VERIFY_FAILED,
  "an unknown receipt version is refused unread": EXIT.VERIFY_FAILED,
};

const V4 = await read<{ cases: V4Case[] }>("recorded-v4.json");

describe("recorded-v4.json: the anchor a version 4 paper or telephone receipt signs, through the CLI", () => {
  it("every vector case has an exit code here", () => {
    expect(V4.cases.map((c) => c.name).sort()).toEqual(Object.keys(V4_EXIT).sort());
  });

  it.each(V4.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    await withChain(c.answers ?? {}, async (chain) => {
      const onchain = c.answers !== null ? ["--onchain", "--rpc-url", chain.url] : [];
      const { json, human } = await verify(vector(c.file), ...v4DidDocs, ...onchain);
      expectFields(json.json, c.expect);
      // Two runs (--json, then the matrix) read the same refs each.
      if (c.expect.readRefs !== undefined) expect(chain.refs).toEqual([...c.expect.readRefs, ...c.expect.readRefs]);
      expect(json.code).toBe(V4_EXIT[c.name]);
      expect(human.code).toBe(V4_EXIT[c.name]);
      const binding = c.expect["signedAnchorBinding"] as string | undefined;
      if (binding !== undefined) expect(human.out).toContain(SIGNED_LINE[binding]);
      else expect(human.out).not.toContain("signedAnchor");
      if (c.answers !== null) expectKeyLines(human.out, json.json);
      else expect(chain.calls).toBe(0);
    });
  });
});

interface GatewayCase {
  name: string;
  options: { ipfsGateway?: string; ipfsGateways?: string[] };
  answers: Record<string, GatewayAnswer>;
  expect: { disclosureCopy: string; disclosureGateway?: string; tried: string[] };
}

const GATEWAYS = await read<{ defaultGateways: string[]; file: string; bundle: string; cases: GatewayCase[] }>("ipfs-gateways.json");

describe("ipfs-gateways.json: the gateway that delivered, or each one tried, through the CLI", () => {
  // --ipfs-gateway is the SDK's ipfsGateways: a named gateway then the list is the same order written as one list.
  // An empty list cannot be written (no flag is the SDK default, a live gateway), so that one case is not run here.
  const runnable = GATEWAYS.cases.filter((c) => !(c.options.ipfsGateways?.length === 0 && c.options.ipfsGateway === undefined));

  it("only the empty list is left out", () => {
    expect(GATEWAYS.cases.length - runnable.length).toBe(1);
  });

  it.each(runnable.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const list = [...(c.options.ipfsGateway !== undefined ? [c.options.ipfsGateway] : []), ...(c.options.ipfsGateways ?? GATEWAYS.defaultGateways)];
    await withGateways(c.answers, vector(GATEWAYS.file), async (mirror) => {
      const flags = list.flatMap((g) => ["--ipfs-gateway", mirror(g)]);
      const { json, human } = await verify(vector(GATEWAYS.bundle), ...didDocs, "--ipfs", ...flags);
      expect(json.json["disclosureCopy"]).toBe(c.expect.disclosureCopy);
      if (c.expect.disclosureGateway !== undefined) {
        expect(json.json["disclosureGateway"]).toBe(mirror(c.expect.disclosureGateway));
        expect(human.out).toContain(`disclosureGateway delivered by ${mirror(c.expect.disclosureGateway)}`);
        expect(human.code).toBe(EXIT.OK);
      } else {
        expect(json.json).not.toHaveProperty("disclosureGateway");
        const line = human.out.split("\n").find((l) => l.includes("disclosureGateway")) ?? "";
        expect(line).toContain("disclosureGateway none delivered: ");
        for (const g of list) expect(line).toContain(mirror(g));
        expect(human.code).toBe(EXIT.UNAVAILABLE);
      }
    });
  });

  it("without --ipfs, no gateway line and nothing fetched", async () => {
    await withGateways({}, vector(GATEWAYS.file), async (mirror) => {
      const { human } = await verify(vector(GATEWAYS.bundle), ...didDocs, "--ipfs-gateway", mirror(GATEWAYS.defaultGateways[0]!));
      expect(human.out).toContain("disclosureCopy    skipped");
      expect(human.out).not.toContain("disclosureGateway");
    });
  });
});

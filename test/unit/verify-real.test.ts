// `agreely verify` on real artefacts the app issued, through the REAL @agreely/sdk (no vi.mock in this file).
// --did-doc keeps every run air-gapped: an unknown DID resolves to null, never to the network.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { exitFor } from "../../src/commands/verify.js";
import { EXIT } from "../../src/errors.js";
import { onMainnetAnswers, onMainnetBundle, withChain, type VectorAnswers } from "./chain.js";
import { argv, makeIo } from "./harness.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/verify/${name}`, import.meta.url));
const DOCS = ["--did-doc", fixture("boreale.did.json"), "--did-doc", fixture("citizen-91bf.did.json")];

type Run = { code: number; out: string; json: Record<string, unknown> | null };

async function verify(file: string, ...extra: string[]): Promise<Run> {
  return verifyPath(fixture(file), ...extra);
}

async function verifyPath(path: string, ...extra: string[]): Promise<Run> {
  const io = makeIo({ isTTY: !extra.includes("--json") });
  const code = await run(argv("verify", path, ...extra), io.io);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(io.out().trim()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code, out: io.out(), json };
}

async function withTempFile(name: string, content: string, body: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agreely-cli-verify-"));
  try {
    await writeFile(join(dir, name), content);
    await body(join(dir, name));
  } finally {
    await rm(join(dir, name), { force: true });
    await rm(dir, { recursive: false, force: true }).catch(() => undefined);
  }
}

describe("agreely verify exit codes on real files", () => {
  it("0: a genuine passkey bundle is verified", async () => {
    const { code, json } = await verify("a1v1.bundle.json", ...DOCS, "--json");
    expect(json?.["overall"]).toBe("verified");
    expect(json?.["input"]).toBe("bundle");
    expect(code).toBe(EXIT.OK);
  });

  it("0: a genuine paper receipt is verified, bare or in its bundle", async () => {
    for (const file of ["a3v3.receipt.json", "a3v3.bundle.json"]) {
      const { code, json } = await verify(file, ...DOCS, "--json");
      expect(json?.["overall"]).toBe("verified");
      expect(code).toBe(EXIT.OK);
    }
  });

  it("0: a genuine telephone receipt is partial, the organisation's signed word", async () => {
    const { code, json } = await verify("a4v3.receipt.json", ...DOCS, "--json");
    expect(json?.["overall"]).toBe("partial");
    expect(json?.["receiptType"]).toBe("company_documented");
    expect(code).toBe(EXIT.OK);
  });

  it("11: a genuine bare passkey receipt is incomplete, and the matrix says to verify the bundle", async () => {
    const { code, json } = await verify("a1v1.receipt.json", ...DOCS, "--json");
    expect(json?.["overall"]).toBe("incomplete");
    expect(json?.["citizenAssertion"]).toBe("unbound");
    expect(code).toBe(EXIT.VERIFY_INCOMPLETE);
    expect(EXIT.VERIFY_INCOMPLETE).not.toBe(EXIT.VERIFY_FAILED);

    const human = await verify("a1v1.receipt.json", ...DOCS);
    expect(human.code).toBe(EXIT.VERIFY_INCOMPLETE);
    expect(human.out).toContain("INCOMPLETE: verify the bundle");
    expect(human.out).toContain("receiptIntegrity");
    expect(human.out).toContain("consentAnchor");
  });

  it("11, never 0: a forged bare passkey receipt (F1, purpose rewritten) is not verified", async () => {
    const { code, json } = await verify("f1-purpose.receipt.json", ...DOCS, "--json");
    expect(json?.["overall"]).not.toBe("verified");
    expect(code).toBe(EXIT.VERIFY_INCOMPLETE);
  });

  it("6: a forged bundle, a forged paper receipt and a self-signed bundle fail", async () => {
    for (const file of ["f1-purpose.bundle.json", "f8-paper.receipt.json", "f10-selfsigned-paper.bundle.json"]) {
      const { code, json } = await verify(file, ...DOCS, "--json");
      expect(json?.["overall"]).toBe("failed");
      expect(code).toBe(EXIT.VERIFY_FAILED);
    }
  });

  it("4: an issuer DID that cannot be resolved is unavailable, not a tamper", async () => {
    const { code, json } = await verify("a3v3.receipt.json", "--did-doc", fixture("unrelated.did.json"), "--json");
    expect(json?.["overall"]).toBe("unavailable");
    expect(code).toBe(EXIT.UNAVAILABLE);
  });

  it("2: an unreadable file is a usage error", async () => {
    const io = makeIo();
    const code = await run(argv("verify", fixture("no-such-file.json"), "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("agreely verify on hostile files", () => {
  it("6, never 1: a paper receipt nested 3000 levels deep is malformed, not a crash", async () => {
    const receipt = JSON.parse(await readFile(fixture("a3v3.receipt.json"), "utf8")) as { credentialSubject: Record<string, unknown> };
    let deep: unknown = "leaf";
    for (let i = 0; i < 3000; i++) deep = { a: deep };
    receipt.credentialSubject["deep"] = deep;
    await withTempFile("deep.receipt.json", JSON.stringify(receipt), async (path) => {
      const { code, json } = await verifyPath(path, ...DOCS, "--json");
      expect(json?.["overall"]).toBe("malformed");
      expect(code).toBe(EXIT.VERIFY_FAILED);
      expect(code).not.toBe(EXIT.ERROR);
    });
  });

  it("6: a bundle whose receipt is an array is MALFORMED in the matrix, never worded as a tamper", async () => {
    const bundle = JSON.parse(await readFile(fixture("a1v1.bundle.json"), "utf8")) as Record<string, unknown>;
    bundle["receipt"] = [bundle["receipt"]];
    await withTempFile("array.bundle.json", JSON.stringify(bundle), async (path) => {
      const { code, out } = await verifyPath(path, ...DOCS);
      expect(code).toBe(EXIT.VERIFY_FAILED);
      expect(out).toContain("✗ MALFORMED");
      expect(out).toContain("NOT evidence of a tamper");
      expect(out).not.toContain("FAILED");
    });
  });

  it("4, never 0: a bundle whose subject is a did:web (c6) is not verified, even with its host's document", async () => {
    for (const extra of [[], ["--did-doc", fixture("evil-web-subject.did.json")]]) {
      const { code, json } = await verify("c6-web-subject.bundle.json", ...DOCS, ...extra, "--json");
      expect(json?.["companySignature"]).toBe("pass");
      expect(json?.["citizenAssertion"]).toBe("unavailable");
      expect(json?.["overall"]).not.toBe("verified");
      expect(code).toBe(EXIT.UNAVAILABLE);
    }
  });

  // The issued a1v1 bundle names the emit-only Base Sepolia registry in its issuer delegation, which the SDK refuses
  // before any RPC: to reach the RPC at all, the copy names the registry the CLI reads (Base mainnet, the SDK default).
  it("4, not 0: --onchain asked for and the RPC unreachable (a closed local port)", async () => {
    const bundle = JSON.parse(await readFile(fixture("a1v1.bundle.json"), "utf8")) as {
      didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } };
    };
    bundle.didDocuments.issuer.delegation.body["registry"] = "0x6f2cf94045cf0cbdd94338882c34d183575023e9";
    bundle.didDocuments.issuer.delegation.body["chainId"] = "8453";
    await withTempFile("mainnet.bundle.json", JSON.stringify(bundle), async (path) => {
      const { code, json } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/", "--json");
      expect(json?.["overall"]).toBe("unavailable");
      expect(json?.["consentAnchor"]).toBe("unavailable");
      expect(json?.["companyKeyRegistry"]).toBe("unavailable");
      expect(code).toBe(EXIT.UNAVAILABLE);

      const human = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/");
      expect(human.code).toBe(EXIT.UNAVAILABLE);
      expect(human.out).toContain("companyKey        unavailable  unreachable: the registry could not be read");
      expect(human.out).toContain("This is NOT a forgery: retry with connectivity");
    });
  });

  it("4, not 0: --onchain where the chain confirms both keys but does not answer for the consent's records", async () => {
    const keys = { ...(await keysInForce()), registry: {} };
    const bundle = onMainnetBundle(JSON.parse(await readFile(vectorFile("receipts/ck-salted.bundle.json"), "utf8")) as object);
    await withTempFile("keys-only.bundle.json", JSON.stringify(bundle), (path) =>
      withChain(keys, async (chain) => {
        const { code, json } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", chain.url, "--json");
        expect(json?.["overall"]).toBe("verified");
        expect(json?.["consentAnchor"]).toBe("unavailable");
        expect(code).toBe(EXIT.UNAVAILABLE);

        const human = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", chain.url);
        expect(human.code).toBe(EXIT.UNAVAILABLE);
        expect(human.out).toContain("A CHECK YOU ASKED FOR could not complete");
      }),
    );
  });

  it("4, never 0: --onchain on a bundle naming a registry the SDK does not read is refused, never verified", async () => {
    const { code, json } = await verify("a1v1.bundle.json", ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/", "--json");
    expect(json?.["companySignature"]).toBe("pass");
    expect(json?.["consentAnchor"]).toBe("unavailable");
    expect(json?.["overall"]).toBe("unavailable");
    expect((json?.["notes"] as string[]).join("\n")).toContain("unknown registry: the bundle names the registry 0x3532a9dff3c910152543afca49de7c66113c5312");
    expect(code).toBe(EXIT.UNAVAILABLE);
  });

  it("4: a refused registry names the real cause, never the connectivity advice", async () => {
    const { code, out } = await verify("a1v1.bundle.json", ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/");
    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(out).toContain("UNVERIFIABLE ON CHAIN");
    expect(out).not.toContain("retry with connectivity");
  });

  it("4: an outage keeps the connectivity advice, never the refused-registry cause", async () => {
    const { code, out } = await verify("a3v3.receipt.json", "--did-doc", fixture("unrelated.did.json"));
    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(out).toContain("retry with connectivity");
    expect(out).not.toContain("UNVERIFIABLE ON CHAIN");
  });
});

// The salted vector bundle (vectors/receipts/ck-salted.bundle.json: a1v1 with a citizenKeySalt), on the Base mainnet
// registry the CLI reads, and a chain with both keys in force (citizen-key-chain.json, its first case). Each test
// chooses the consent's cells; a ref it leaves out is not anchored yet (registry answers zero words).
type Cell = { state: 1 | 2; revokedAt: number };
const REVOKED_AT = Date.UTC(2026, 9, 25, 14, 3, 0) / 1000;
const word = (n: number): string => n.toString(16).padStart(64, "0");
const vectorFile = (rel: string): string => fileURLToPath(new URL(`../fixtures/vectors/${rel}`, import.meta.url));

async function keysInForce(): Promise<VectorAnswers> {
  const vectors = JSON.parse(await readFile(vectorFile("citizen-key-chain.json"), "utf8")) as { cases: Array<{ answers: VectorAnswers | null }> };
  return onMainnetAnswers(vectors.cases[0]!.answers!);
}

async function withChainCells(
  cellsFor: (refs: string[]) => Record<string, Cell>,
  fn: (path: string, rpcUrl: string) => Promise<void>,
): Promise<void> {
  const answers = await keysInForce();
  const bundle = onMainnetBundle(
    JSON.parse(await readFile(vectorFile("receipts/ck-salted.bundle.json"), "utf8")) as { consentRefs: string[] },
  );
  // The vector's in-force record: merkleRoot, anchoredAt, revokedAt, state, block. A cell keeps all but revokedAt and state.
  const record = Object.values(answers.registry ?? {})[0]!.slice(2);
  const [root, anchoredAt, , , block] = [0, 1, 2, 3, 4].map((i) => record.slice(i * 64, (i + 1) * 64));
  const cells = cellsFor(bundle.consentRefs.map((ref) => ref.toLowerCase()));
  const registry: Record<string, string> = {};
  for (const ref of bundle.consentRefs.map((r) => r.toLowerCase())) {
    const cell = cells[ref];
    registry[ref] = cell
      ? `0x${root!}${anchoredAt!}${word(cell.state === 2 ? cell.revokedAt : 0)}${word(cell.state)}${block!}`
      : `0x${word(0).repeat(5)}`;
  }
  await withTempFile("withdrawn.bundle.json", JSON.stringify(bundle), (path) =>
    withChain({ ...answers, registry }, (chain) => fn(path, chain.url)),
  );
}

/** The first `withdrawnCells` refs are withdrawn, the others active. */
async function withWithdrawn(withdrawnCells: number, fn: (path: string, rpcUrl: string) => Promise<void>): Promise<void> {
  await withChainCells(
    (refs) => Object.fromEntries(refs.map((ref, i): [string, Cell] => [ref, { state: i < withdrawnCells ? 2 : 1, revokedAt: REVOKED_AT }])),
    fn,
  );
}

describe("agreely verify --onchain on an authentic consent the chain records as withdrawn", () => {
  it("12: exits WITHDRAWN, a code of its own, never 0, 1, 4 or 6", async () => {
    await withWithdrawn(3, async (path, rpcUrl) => {
      const { code, json } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl, "--json");
      expect(json?.["overall"]).toBe("withdrawn");
      expect(json?.["consentAnchor"]).toBe("withdrawn");
      expect(json?.["withdrawal"]).toBe("withdrawn");
      expect(json?.["withdrawnAt"]).toBe(REVOKED_AT);
      expect(code).toBe(EXIT.WITHDRAWN);
      expect([EXIT.OK, EXIT.ERROR, EXIT.UNAVAILABLE, EXIT.VERIFY_FAILED]).not.toContain(EXIT.WITHDRAWN);
    });
  });

  it("the matrix says WITHDRAWN in the web verifier's words, never FAILED", async () => {
    await withWithdrawn(3, async (path, rpcUrl) => {
      const { code, out } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
      expect(code).toBe(EXIT.WITHDRAWN);
      expect(out).toContain("~ WITHDRAWN");
      expect(out).not.toContain("FAILED");
      expect(out).not.toContain("✗");
      expect(out).toContain("withdrawn on 2026-10-25T14:03:00Z");
      expect(out).toContain("cryptographically authentic");
    });
  });

  it("the consentAnchor check line reads withdrawn, never skipped", async () => {
    await withWithdrawn(3, async (path, rpcUrl) => {
      const { out } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
      expect(out).toContain("consentAnchor     withdrawn");
      expect(out).not.toContain("consentAnchor     skipped");
    });
  });

  it("12: one purpose of three withdrawn says how many, and that the rest remain active", async () => {
    await withWithdrawn(1, async (path, rpcUrl) => {
      const { code, out } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
      expect(code).toBe(EXIT.WITHDRAWN);
      expect(out).toContain("1 of 3 purposes has been withdrawn");
      expect(out).toContain("2026-10-25T14:03:00Z");
    });
  });
});

describe("agreely verify --onchain on a consent the chain does not carry yet", () => {
  it("4: the chain answers, no cell is anchored yet, and the advice is to retry later, never to retry with connectivity", async () => {
    await withChainCells(
      () => ({}),
      async (path, rpcUrl) => {
        const { code, out } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
        expect(code).toBe(EXIT.UNAVAILABLE);
        expect(out).toContain("retry later");
        expect(out).not.toContain("Retry with connectivity");
      },
    );
  });

  it("12: one purpose withdrawn and the rest not anchored yet says it in the readable words", async () => {
    await withChainCells(
      (refs) => ({ [refs[0]!]: { state: 2, revokedAt: REVOKED_AT } }),
      async (path, rpcUrl) => {
        const { code, out } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
        expect(code).toBe(EXIT.WITHDRAWN);
        expect(out).toContain("were withdrawn (latest withdrawal on 2026-10-25T14:03:00Z)");
        expect(out).not.toContain("This consent was withdrawn");
      },
    );
  });
});

describe("agreely verify says whether the consent is still in force", () => {
  it("0 offline, and the matrix says the withdrawal was not checked and how to check it", async () => {
    const { code, json } = await verify("a1v1.bundle.json", ...DOCS, "--json");
    expect(json?.["overall"]).toBe("verified");
    expect(json?.["withdrawal"]).toBe("not_checked");
    expect(code).toBe(EXIT.OK);

    const human = await verify("a1v1.bundle.json", ...DOCS);
    expect(human.code).toBe(EXIT.OK);
    expect(human.out).toContain("withdrawal        not checked");
    expect(human.out).toContain("WITHDRAWAL NOT CHECKED");
    expect(human.out).toContain("--onchain --rpc-url https://base-rpc.publicnode.com");
  });

  it("0 with --onchain once the chain reads every purpose in force", async () => {
    await withChainCells(
      (refs) => Object.fromEntries(refs.map((ref): [string, Cell] => [ref, { state: 1, revokedAt: 0 }])),
      async (path, rpcUrl) => {
        const { code, json } = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl, "--json");
        expect(json?.["overall"]).toBe("verified");
        expect(json?.["withdrawal"]).toBe("active");
        expect(code).toBe(EXIT.OK);

        const human = await verifyPath(path, ...DOCS, "--onchain", "--rpc-url", rpcUrl);
        expect(human.code).toBe(EXIT.OK);
        expect(human.out).toContain("withdrawal        active");
        expect(human.out).not.toContain("WITHDRAWAL NOT CHECKED");
      },
    );
  });

  it("4, never 0: --onchain on a version 3 paper receipt, whose withdrawal this verifier does not read on chain", async () => {
    const { companyKeyOf, getCompanyDid } = await keysInForce();
    await withChain({ ...(companyKeyOf !== undefined ? { companyKeyOf } : {}), ...(getCompanyDid !== undefined ? { getCompanyDid } : {}) }, async (chain) => {
      const extra = [...DOCS, "--onchain", "--rpc-url", chain.url];
      const { code, json } = await verify("a3v3.receipt.json", ...extra, "--json");
      expect(json?.["overall"]).toBe("verified");
      expect(json?.["companyKeyRegistry"]).toBe("pass");
      expect(json?.["withdrawal"]).toBe("not_checked");
      expect(code).toBe(EXIT.UNAVAILABLE);

      const human = await verify("a3v3.receipt.json", ...extra);
      expect(human.code).toBe(EXIT.UNAVAILABLE);
      expect(human.out).toContain("WITHDRAWAL NOT CHECKED (--onchain)");
      expect(human.out).toContain("retrying will not change it");
      expect(human.out).not.toContain("A CHECK YOU ASKED FOR");
    });
  });

  it("6: a passkey receipt carrying a field the issuer never writes is MALFORMED, never FAILED", async () => {
    const bundle = JSON.parse(await readFile(fixture("a1v1.bundle.json"), "utf8")) as {
      receipt: { credentialSubject: { consent: Record<string, unknown> } };
    };
    bundle.receipt.credentialSubject.consent["status"] = "active";
    await withTempFile("field.bundle.json", JSON.stringify(bundle), async (path) => {
      const { code, json } = await verifyPath(path, ...DOCS, "--json");
      expect(json?.["overall"]).toBe("malformed");
      expect(code).toBe(EXIT.VERIFY_FAILED);

      const human = await verifyPath(path, ...DOCS);
      expect(human.out).toContain("✗ MALFORMED");
      expect(human.out).not.toContain("✗ FAILED");
    });
  });
});

describe("exitFor never reads an unproven overall as success", () => {
  const as = (r: Record<string, unknown>): Parameters<typeof exitFor>[0] => r as unknown as Parameters<typeof exitFor>[0];

  it("partial is 0 only for the organisation's documented word", () => {
    expect(exitFor(as({ overall: "partial", receiptType: "company_documented" }))).toBe(EXIT.OK);
    expect(exitFor(as({ overall: "partial", receiptType: "citizen_signed" }))).toBe(EXIT.ERROR);
  });

  it("malformed is 6, like a failure, never 1", () => {
    expect(exitFor(as({ overall: "malformed", receiptType: "company_attested" }))).toBe(EXIT.VERIFY_FAILED);
  });

  it("an asked-for check that is unavailable turns 0 into 4, and only an asked-for one", () => {
    const sound = { overall: "verified", receiptType: "citizen_signed", documentAnchor: "skipped", consentAnchor: "skipped", disclosureCopy: "skipped", withdrawal: "active" };
    expect(exitFor(as({ ...sound, consentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, documentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, disclosureCopy: "unavailable" }), { ipfs: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, disclosureCopy: "unavailable" }), { onchain: true })).toBe(EXIT.OK);
    expect(exitFor(as({ ...sound, consentAnchor: "pass", documentAnchor: "pass" }), { onchain: true })).toBe(EXIT.OK);
    expect(exitFor(as({ ...sound, overall: "partial", receiptType: "company_documented", disclosureCopy: "unavailable" }), { ipfs: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, overall: "failed", consentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.VERIFY_FAILED);
  });

  it("withdrawn is 12, and an asked-for anchor that could not complete does not hide it", () => {
    const withdrawn = { overall: "withdrawn", receiptType: "citizen", consentAnchor: "withdrawn", disclosureCopy: "skipped" };
    expect(exitFor(as({ ...withdrawn, documentAnchor: "skipped" }), { onchain: true })).toBe(EXIT.WITHDRAWN);
    expect(exitFor(as({ ...withdrawn, documentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.WITHDRAWN);
  });

  it("with --onchain, 0 needs the chain to read the consent in force; offline, an unread withdrawal stays 0", () => {
    const sound = { overall: "verified", receiptType: "company_attested", documentAnchor: "pass", consentAnchor: "skipped", disclosureCopy: "skipped" };
    expect(exitFor(as({ ...sound, withdrawal: "not_checked" }))).toBe(EXIT.OK);
    expect(exitFor(as({ ...sound, withdrawal: "not_checked" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as(sound), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, overall: "partial", receiptType: "company_documented", withdrawal: "not_checked" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, consentAnchor: "pass", withdrawal: "active" }), { onchain: true })).toBe(EXIT.OK);
  });

  it("an overall this CLI does not know is an error", () => {
    expect(exitFor(as({ overall: "something-new", receiptType: "citizen_signed" }))).toBe(EXIT.ERROR);
  });
});

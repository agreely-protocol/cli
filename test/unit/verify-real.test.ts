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

  it("4, not 0: --onchain asked for and the RPC unreachable (a closed local port)", async () => {
    const { code, json } = await verify("a1v1.bundle.json", ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/", "--json");
    expect(json?.["overall"]).toBe("verified");
    expect(json?.["consentAnchor"]).toBe("unavailable");
    expect(code).toBe(EXIT.UNAVAILABLE);

    const human = await verify("a1v1.bundle.json", ...DOCS, "--onchain", "--rpc-url", "http://127.0.0.1:9/");
    expect(human.code).toBe(EXIT.UNAVAILABLE);
    expect(human.out).toContain("A CHECK YOU ASKED FOR could not complete");
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
    const sound = { overall: "verified", receiptType: "citizen_signed", documentAnchor: "skipped", consentAnchor: "skipped", disclosureCopy: "skipped" };
    expect(exitFor(as({ ...sound, consentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, documentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, disclosureCopy: "unavailable" }), { ipfs: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, disclosureCopy: "unavailable" }), { onchain: true })).toBe(EXIT.OK);
    expect(exitFor(as({ ...sound, consentAnchor: "pass", documentAnchor: "pass" }), { onchain: true })).toBe(EXIT.OK);
    expect(exitFor(as({ ...sound, overall: "partial", receiptType: "company_documented", disclosureCopy: "unavailable" }), { ipfs: true })).toBe(EXIT.UNAVAILABLE);
    expect(exitFor(as({ ...sound, overall: "failed", consentAnchor: "unavailable" }), { onchain: true })).toBe(EXIT.VERIFY_FAILED);
  });

  it("an overall this CLI does not know is an error", () => {
    expect(exitFor(as({ overall: "something-new", receiptType: "citizen_signed" }))).toBe(EXIT.ERROR);
  });
});

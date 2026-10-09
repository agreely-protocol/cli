// Unit tests for the commands that cover the 0.5.0 /v1 surface: verbal consents,
// withdrawals, customers, retention, holds, consent sheets, documents, and the
// error envelope. The SDK is mocked; no network, no process.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyRateLimitError,
  AgreelyTimeoutError,
  AgreelyValidationError,
} from "@agreely/sdk";
import type * as AgreelySdk from "@agreely/sdk";
import type * as FlagsModule from "../../src/flags.js";
import { run } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { argv, makeIo } from "./harness.js";

const h = vi.hoisted(() => ({
  checkDetailed: vi.fn(),
  vRecord: vi.fn(),
  vGet: vi.fn(),
  vPaper: vi.fn(),
  withdraw: vi.fn(),
  custGet: vi.fn(),
  custUpsert: vi.fn(),
  retGet: vi.fn(),
  retDispose: vi.fn(),
  holdPlace: vi.fn(),
  holdRelease: vi.fn(),
  holdList: vi.fn(),
  holdSync: vi.fn(),
  sheet: vi.fn(),
  docList: vi.fn(),
  docGet: vi.fn(),
  docPdf: vi.fn(),
  mRecord: vi.fn(),
  catList: vi.fn(),
  catDoc: vi.fn(),
  ctor: vi.fn(),
  reqCreate: vi.fn(),
  failWrite: { on: false },
}));

vi.mock("@agreely/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof AgreelySdk>();
  class FakeAgreely {
    verbalConsents = { record: h.vRecord, get: h.vGet, confirmWithPaper: h.vPaper };
    withdrawals = { record: h.withdraw };
    customers = { get: h.custGet, upsert: h.custUpsert };
    retention = {
      getCustomerRetention: h.retGet,
      declareDisposition: h.retDispose,
      placeHold: h.holdPlace,
      releaseHold: h.holdRelease,
      listHolds: h.holdList,
      syncHolds: h.holdSync,
    };
    manualConsents = { createConsentSheet: h.sheet, record: h.mRecord };
    consentDocuments = { list: h.docList, get: h.docGet, getInformationPdf: h.docPdf };
    consentRequests = { create: h.reqCreate };
    catalog = { list: h.catList, forDocument: h.catDoc };
    checkDetailed = h.checkDetailed;
    constructor(opts: unknown) {
      h.ctor(opts);
    }
  }
  return { ...actual, Agreely: FakeAgreely };
});

// A post-mint write failure cannot be provoked on a real file, so the handle's write is broken on demand.
vi.mock("../../src/flags.js", async (importOriginal) => {
  const actual = await importOriginal<typeof FlagsModule>();
  return {
    ...actual,
    openOutput: async (...a: Parameters<typeof actual.openOutput>) => {
      const out = await actual.openOutput(...a);
      if (h.failWrite.on) {
        out.handle.writeFile = async () => {
          throw new Error("disk full");
        };
      }
      return out;
    },
  };
});

vi.mock("@clack/prompts", () => {
  const boom = () => {
    throw new Error("PROMPTED");
  };
  return { intro: boom, outro: boom, text: boom, password: boom, select: boom, confirm: boom, multiselect: boom, spinner: boom, isCancel: () => false, cancel: boom, note: boom, log: {} };
});

const ENV = { AGREELY_API_KEY: "ak_test_key_1234567890" };
const CONSENT = "0x" + "a".repeat(64);
const UUID = "11111111-2222-3333-4444-555555555555";
const tmp = mkdtempSync(join(tmpdir(), "agreely-cli-v1-"));

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === "function") fn.mockReset();
  h.failWrite.on = false;
});

async function json(...args: string[]): Promise<{ code: number; out: unknown; err: string }> {
  const io = makeIo({ env: ENV });
  const code = await run(argv(...args, "--json"), io.io);
  const out = io.out().trim();
  return { code, out: out === "" ? undefined : JSON.parse(out), err: io.err() };
}

describe("verbal-consent", () => {
  const base = [
    "verbal-consent", "record", "--customer", "c1", "--document-version", UUID,
    "--answer", "Cat A:Purpose 1=yes", "--answer", "Cat B:Purpose 2=no",
    "--obtained-at", "2026-10-09T10:00:00-04:00", "--obtained-by", "agent-7", "--script-version", "v1",
    "--consented-by", "self", "--valid-until", "2027-10-09",
  ];

  it("records with parsed answers and the idempotency key", async () => {
    h.vRecord.mockResolvedValue({ consentId: UUID, tier: "verbal", assurance: "company_documented", consentRefs: [], acknowledged: [], asksDeclined: false });
    const r = await json(...base, "--paper-expected", "--idempotency-key", "k1");
    expect(r.code).toBe(EXIT.OK);
    const [input, opts] = h.vRecord.mock.calls[0] as [Record<string, unknown>, unknown];
    // Statutory fields: assert the WHOLE input so a swapped pair cannot pass.
    expect(input).toEqual({
      customerId: "c1",
      documentVersionId: UUID,
      answers: [
        { category: "Cat A", purpose: "Purpose 1", answer: "yes" },
        { category: "Cat B", purpose: "Purpose 2", answer: "no" },
      ],
      obtainedAt: "2026-10-09T10:00:00-04:00",
      obtainedBy: "agent-7",
      scriptVersion: "v1",
      respondent: { consentedBy: "self" },
      validUntil: "2027-10-09",
      paperExpected: true,
    });
    expect(opts).toEqual({ idempotencyKey: "k1" });
  });

  it("refuses a malformed answer locally (exit 2)", async () => {
    const args = base.map((a) => (a === "Cat A:Purpose 1=yes" ? "Cat A:Purpose 1=maybe" : a));
    expect((await json(...args)).code).toBe(EXIT.USAGE);
    expect(h.vRecord).not.toHaveBeenCalled();
  });

  it("requires --consented-by from the closed list", async () => {
    const args = base.map((a) => (a === "self" ? "robot" : a));
    expect((await json(...args)).code).toBe(EXIT.USAGE);
    expect(h.vRecord).not.toHaveBeenCalled();
  });

  it("show prints the history", async () => {
    const hist = { consentId: UUID, state: "awaiting_paper", purposes: [] };
    h.vGet.mockResolvedValue(hist);
    const r = await json("verbal-consent", "show", UUID);
    expect(r.out).toEqual(hist);
  });

  it("paper hashes the PDF locally and sends the hash only", async () => {
    const pdf = join(tmp, "signed.pdf");
    writeFileSync(pdf, "%PDF-1.4 signed");
    h.vPaper.mockResolvedValue({ verbalConsentId: UUID, manualConsentId: null, confirmed: [], withdrawn: [] });
    const r = await json("verbal-consent", "paper", UUID, "--signed-at", "2026-10-10T09:00:00-04:00", "--answer", "A:B=yes", "--pdf", pdf);
    expect(r.code).toBe(EXIT.OK);
    const [id, input] = h.vPaper.mock.calls[0] as [string, { evidence: Record<string, string> }];
    expect(id).toBe(UUID);
    expect(input.evidence["pdfSha256"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(input.evidence["pdf"]).toBeUndefined();
  });
});

describe("withdraw", () => {
  const args = ["withdraw", "c1", CONSENT, "--channel", "phone", "--operator", "op-1"];

  it("records a withdrawal and prints the gate", async () => {
    const res = { consentRef: CONSENT, withdrawn: true, alreadyWithdrawn: false, recordedOnBehalf: true, assurance: "company_attested", gate: "denied", alsoWithdrawn: [] };
    h.withdraw.mockResolvedValue(res);
    const r = await json(...args, "--reason", "asked by phone", "--requested-at", "2026-10-09T10:00:00Z", "--idempotency-key", "k");
    expect(r.out).toEqual(res);
    expect(h.withdraw).toHaveBeenCalledWith(
      "c1", CONSENT,
      { channel: "phone", operator: "op-1", requestedAt: "2026-10-09T10:00:00Z", reason: "asked by phone" },
      { idempotencyKey: "k" },
    );
  });

  it("requires channel and operator, and a valid channel", async () => {
    expect((await json("withdraw", "c1", CONSENT, "--operator", "o")).code).toBe(EXIT.USAGE);
    expect((await json("withdraw", "c1", CONSENT, "--channel", "phone")).code).toBe(EXIT.USAGE);
    expect((await json("withdraw", "c1", CONSENT, "--channel", "pigeon", "--operator", "o")).code).toBe(EXIT.USAGE);
    expect(h.withdraw).not.toHaveBeenCalled();
  });

  it("a daily cap exits 8, not 5, and carries code and reason", async () => {
    h.withdraw.mockRejectedValue(
      new AgreelyDailyCapError("cap", { code: "withdrawal_daily_cap", status: 429, reason: "daily_cap" }),
    );
    const r = await json(...args);
    expect(r.code).toBe(EXIT.DAILY_CAP);
    expect(JSON.parse(r.err.trim())).toEqual({ error: { code: "withdrawal_daily_cap", message: "cap", reason: "daily_cap" } });
  });

  it("a plain rate limit still exits 5", async () => {
    h.withdraw.mockRejectedValue(new AgreelyRateLimitError("slow", { code: "rate_limited", status: 429, retryAfter: 3 }));
    expect((await json(...args)).code).toBe(EXIT.RATE_LIMITED);
  });
});

describe("error envelope", () => {
  it("prints code, reason and field, and keeps a specific 409 code", async () => {
    h.custUpsert.mockRejectedValue(new AgreelyConflictError("held", { code: "identity_held", status: 409, reason: "x_reason", field: "email" }));
    const r = await json("customer", "set", "c1", "--email", "a@b.co");
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.err.trim())).toEqual({ error: { code: "identity_held", message: "held", reason: "x_reason", field: "email" } });
  });

  it("human mode prints the code line", async () => {
    h.custUpsert.mockRejectedValue(new AgreelyValidationError("bad", { code: "invalid_request", status: 422, reason: "invalid_field", field: "email" }));
    const io = makeIo({ env: ENV, isTTY: true });
    await run(argv("customer", "set", "c1", "--email", "x"), io.io);
    expect(io.err()).toContain("code invalid_request, reason invalid_field, field email");
  });
});

describe("customer", () => {
  it("get returns metadata", async () => {
    h.custGet.mockResolvedValue({ customerRef: "c1", registered: true });
    expect((await json("customer", "get", "c1")).out).toEqual({ customerRef: "c1", registered: true });
  });

  it("set merges: only the passed flags are sent, empty clears", async () => {
    h.custUpsert.mockResolvedValue({ customerRef: "c1", created: true });
    await json("customer", "set", "c1", "--display-name", "Ada", "--email", "");
    expect(h.custUpsert).toHaveBeenCalledWith("c1", { displayName: "Ada", email: null });
  });

  it("set with nothing to set is a usage error", async () => {
    expect((await json("customer", "set", "c1")).code).toBe(EXIT.USAGE);
    expect(h.custUpsert).not.toHaveBeenCalled();
  });
});

describe("retention", () => {
  it("show", async () => {
    h.retGet.mockResolvedValue({ customerRef: "c1", holds: [] });
    expect((await json("retention", "show", "c1")).out).toEqual({ customerRef: "c1", holds: [] });
  });

  it("dispose destroyed", async () => {
    h.retDispose.mockResolvedValue({ customerRef: "c1", disposition: "destroyed", warnings: [] });
    await json("retention", "dispose", "c1", "--disposition", "destroyed", "--schedule-ref", "S1");
    expect(h.retDispose).toHaveBeenCalledWith("c1", { disposition: "destroyed", scheduleRef: "S1" });
  });

  it("legal_hold needs --reason; retention-until needs legal_hold", async () => {
    expect((await json("retention", "dispose", "c1", "--disposition", "legal_hold")).code).toBe(EXIT.USAGE);
    expect((await json("retention", "dispose", "c1", "--disposition", "destroyed", "--retention-until", "2030-01-01")).code).toBe(EXIT.USAGE);
    expect(h.retDispose).not.toHaveBeenCalled();
  });
});

describe("holds", () => {
  it("place defaults to scope all, and other_law requires a provision", async () => {
    h.holdPlace.mockResolvedValue({ id: UUID });
    await json("holds", "place", "c1", "--ground", "rights_request");
    expect(h.holdPlace).toHaveBeenCalledWith("c1", { scope: "all", ground: "rights_request" }, { idempotencyKey: expect.any(String) });
    expect((await json("holds", "place", "c1", "--ground", "other_law")).code).toBe(EXIT.USAGE);
    await json("holds", "place", "c1", "--ground", "other_law", "--provision", "Tax Act s. 1", "--rule", "r1", "--cell", "c9");
    expect(h.holdPlace).toHaveBeenLastCalledWith(
      "c1",
      { scope: { rules: ["r1"], cells: ["c9"] }, ground: "other_law", provision: "Tax Act s. 1" },
      { idempotencyKey: expect.any(String) },
    );
  });

  it("release requires a reason", async () => {
    expect((await json("holds", "release", "c1", UUID)).code).toBe(EXIT.USAGE);
    h.holdRelease.mockResolvedValue({ id: UUID, placedBy: "api", agreelyIdentity: "none_held" });
    expect((await json("holds", "release", "c1", UUID, "--reason", "done")).code).toBe(EXIT.OK);
    expect(h.holdRelease).toHaveBeenCalledWith("c1", UUID, { reason: "done" }, { idempotencyKey: expect.any(String) });
  });

  it("list reads one page with the page token", async () => {
    const page = { holds: [], nextPageToken: "t2", cursor: null };
    h.holdList.mockResolvedValue(page);
    const r = await json("holds", "list", "--changed-since", "cur", "--page-token", "t1");
    expect(h.holdList).toHaveBeenCalledWith({ changedSince: "cur", pageToken: "t1" });
    expect(r.out).toEqual(page);
  });

  it("sync prints the cursor to keep in human mode", async () => {
    h.holdSync.mockResolvedValue({ mode: "snapshot", holds: [{ id: UUID, customerRef: "c1", status: "active", scope: "all", changedAt: "t" }], cursor: "CUR-9" });
    const io = makeIo({ env: ENV, isTTY: true });
    expect(await run(argv("holds", "sync"), io.io)).toBe(EXIT.OK);
    expect(io.out()).toContain("cursor to keep");
    expect(io.out()).toContain("CUR-9");
    expect(h.holdSync).toHaveBeenCalledWith({});
  });

  it("a hold cap exits 8", async () => {
    h.holdRelease.mockRejectedValue(new AgreelyDailyCapError("cap", { code: "hold_release_cap_reached", status: 429 }));
    expect((await json("holds", "release", "c1", UUID, "--reason", "r")).code).toBe(EXIT.DAILY_CAP);
  });
});

describe("consent-sheet create", () => {
  const sheet = {
    signatureSheet: { documentVersionId: UUID, locale: "fr", contentType: "application/pdf", filename: "s.pdf", pdf: Buffer.from("%PDF-1.4 blank").toString("base64") },
    printedReference: "ABCD-EFGH",
    claim: { claimUrl: "https://x/claim/t", token: "tok", expiresAt: "2026-11-01T00:00:00Z" },
  };

  it("writes the PDF to --out, never stdout, and states the rules", async () => {
    h.sheet.mockResolvedValue(sheet);
    const out = join(tmp, "sheet1.pdf");
    const io = makeIo({ env: ENV, isTTY: true });
    expect(await run(argv("consent-sheet", "create", "c1", "--document-version", UUID, "--out", out), io.io)).toBe(EXIT.OK);
    expect(readFileSync(out, "utf8")).toBe("%PDF-1.4 blank");
    expect(io.out()).toContain("ABCD-EFGH");
    expect(io.out()).toContain("https://x/claim/t");
    expect(io.out()).toContain("Never send the claim link in the same envelope as the sheet");
    expect(io.out()).toContain("Never send the blank sheet's hash as evidence.pdfSha256");
    expect(io.out()).not.toContain(sheet.signatureSheet.pdf);
  });

  it("json output omits the base64 PDF", async () => {
    h.sheet.mockResolvedValue(sheet);
    const out = join(tmp, "sheet2.pdf");
    const r = await json("consent-sheet", "create", "c1", "--document-version", UUID, "--out", out, "--locale", "en");
    expect(h.sheet).toHaveBeenCalledWith("c1", { documentVersionId: UUID, locale: "en" }, {});
    expect(r.out).toMatchObject({ file: out, printedReference: "ABCD-EFGH", claim: sheet.claim });
    expect(JSON.stringify(r.out)).not.toContain(sheet.signatureSheet.pdf);
  });

  it("refuses an existing --out BEFORE minting, and requires --out", async () => {
    const out = join(tmp, "exists.pdf");
    writeFileSync(out, "x");
    expect((await json("consent-sheet", "create", "c1", "--document-version", UUID, "--out", out)).code).toBe(EXIT.USAGE);
    expect((await json("consent-sheet", "create", "c1", "--document-version", UUID)).code).toBe(EXIT.USAGE);
    expect(h.sheet).not.toHaveBeenCalled();
  });

  it("an already_minted 409 keeps its code", async () => {
    h.sheet.mockRejectedValue(new AgreelyConflictError("minted", { code: "already_minted", status: 409 }));
    const r = await json("consent-sheet", "create", "c1", "--document-version", UUID, "--out", join(tmp, "never.pdf"));
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain("already_minted");
    expect(existsSync(join(tmp, "never.pdf"))).toBe(false);
  });
});

describe("documents", () => {
  it("list and show", async () => {
    h.docList.mockResolvedValue([{ code: "D1" }]);
    h.docGet.mockResolvedValue({ code: "D1", items: [] });
    expect((await json("documents", "list")).out).toEqual([{ code: "D1" }]);
    expect((await json("documents", "show", "D1")).out).toEqual({ code: "D1", items: [] });
  });

  it("pdf writes to a file", async () => {
    h.docPdf.mockResolvedValue({ pdf: new Uint8Array([37, 80, 68, 70]), filename: "f.pdf", contentType: "application/pdf" });
    const out = join(tmp, "doc.pdf");
    const r = await json("documents", "pdf", UUID, "--out", out);
    expect(h.docPdf).toHaveBeenCalledWith(UUID, { locale: "fr" });
    expect(readFileSync(out, "utf8")).toBe("%PDF");
    expect(r.out).toMatchObject({ file: out, bytes: 4 });
  });

  it("pdf refuses stdout", async () => {
    expect((await json("documents", "pdf", UUID, "--out", "-")).code).toBe(EXIT.USAGE);
  });
});

describe("check: validUntil and revokedAt", () => {
  it("passes both through in json", async () => {
    h.checkDetailed.mockResolvedValue({ decision: "deny", status: "revoked", consentRef: CONSENT, assurance: "company_attested", tier: "manual", validUntil: "2027-01-01T04:59:59Z", revokedAt: "2026-10-08T20:00:00Z", checkedAt: "t" });
    const r = await json("check", "c", "Cat", "Pur");
    expect(r.code).toBe(EXIT.DENY);
    expect(r.out).toMatchObject({ validUntil: "2027-01-01T04:59:59Z", revokedAt: "2026-10-08T20:00:00Z" });
  });

  it("shows them in human mode and omits them when absent", async () => {
    h.checkDetailed.mockResolvedValue({ decision: "allow", status: "active", consentRef: CONSENT, validUntil: "2027-01-01T04:59:59Z", checkedAt: "t" });
    const io = makeIo({ env: ENV, isTTY: true });
    await run(argv("check", "c", "Cat", "Pur"), io.io);
    expect(io.out()).toContain("validUntil 2027-01-01T04:59:59Z");
    h.checkDetailed.mockResolvedValue({ decision: "allow", status: "necessity", basis: "contract", checkedAt: "t" });
    const r = await json("check", "c", "Cat", "Pur");
    expect(r.out).not.toHaveProperty("validUntil");
  });
});

describe("manual-consent create attestations", () => {
  it("forwards the two attestation flags", async () => {
    h.mRecord.mockResolvedValue({ consentId: UUID, merkleRoot: "0x1", assurance: "company_attested", anchored: false, consentRefs: [] });
    const pdf = join(tmp, "m.pdf");
    writeFileSync(pdf, "%PDF-1.4 m");
    await json("manual-consent", "create", "--customer", "c", "--document-version", UUID, "--effective-date", "2026-10-01", "--valid-until", "2027-10-01", "--pdf", pdf, "--sensitive-express-attested", "--version-attested");
    expect(h.mRecord.mock.calls[0]?.[0]).toMatchObject({ sensitiveExpressAttested: true, versionAttested: true });
  });
});

describe("catalog --document", () => {
  it("scopes to one document and prints the version id", async () => {
    const regime = { sector: "private", statute: "P-39.1" };
    h.catDoc.mockResolvedValue({ regime, document: { code: "D1", documentVersionId: UUID }, catalog: [{ id: "x", category: "C", purpose: "P" }] });
    const r = await json("catalog", "--document", "D1");
    expect(h.catDoc).toHaveBeenCalledWith("D1");
    expect(r.out).toEqual({ regime, document: { code: "D1", documentVersionId: UUID }, catalog: [{ id: "x", category: "C", purpose: "P" }] });
    const io = makeIo({ env: ENV, isTTY: true });
    await run(argv("catalog", "--document", "D1"), io.io);
    expect(io.out()).toContain(`D1  documentVersionId ${UUID}`);
    expect(io.out()).toContain("regime P-39.1");
  });

  it("without the flag lists the whole catalog", async () => {
    h.catList.mockResolvedValue([]);
    expect((await json("catalog")).out).toEqual({ catalog: [] });
    expect(h.catDoc).not.toHaveBeenCalled();
  });
});

describe("consent-sheet: the output file is opened BEFORE the mint", () => {
  const sheet = {
    signatureSheet: { documentVersionId: UUID, locale: "fr", contentType: "application/pdf", filename: "s.pdf", pdf: Buffer.from("%PDF-1.4 x").toString("base64") },
    printedReference: "ABCD-EFGH",
    claim: { claimUrl: "https://x/claim/t", token: "tok", expiresAt: "2026-11-01T00:00:00Z" },
  };
  const create = (out: string, ...more: string[]) => ["consent-sheet", "create", "c1", "--document-version", UUID, "--out", out, ...more];

  it("a missing parent directory never reaches the SDK", async () => {
    expect((await json(...create(join(tmp, "nope", "s.pdf")))).code).toBe(EXIT.USAGE);
    expect(h.sheet).not.toHaveBeenCalled();
  });

  it("a directory path never reaches the SDK, even with --force", async () => {
    expect((await json(...create(tmp, "--force"))).code).toBe(EXIT.USAGE);
    expect(h.sheet).not.toHaveBeenCalled();
  });

  it("a non-regular file such as /dev/stdout is refused before minting", async () => {
    expect((await json(...create("/dev/stdout", "--force"))).code).toBe(EXIT.USAGE);
    expect(h.sheet).not.toHaveBeenCalled();
  });

  it("a failed mint removes the empty file it created", async () => {
    h.sheet.mockRejectedValue(new AgreelyConflictError("minted", { code: "already_minted", status: 409 }));
    const out = join(tmp, "gone.pdf");
    await json(...create(out));
    expect(existsSync(out)).toBe(false);
  });

  it("a write failure AFTER the mint still prints the reference and claim, exit 9", async () => {
    h.sheet.mockResolvedValue(sheet);
    h.failWrite.on = true;
    const r = await json(...create(join(tmp, "lost.pdf")));
    expect(r.code).toBe(EXIT.PARTIAL);
    expect(r.out).toMatchObject({ file: null, writeError: "disk full", printedReference: "ABCD-EFGH", claim: sheet.claim });
    const io = makeIo({ env: ENV, isTTY: true });
    expect(await run(argv(...create(join(tmp, "lost2.pdf"))), io.io)).toBe(EXIT.PARTIAL);
    expect(io.out()).toContain("ABCD-EFGH");
    expect(io.out()).toContain("https://x/claim/t");
    expect(io.err()).toContain("Do NOT retry");
  });

  it("exit 9 leaves no 0-byte file behind (the reference and claim are already printed)", async () => {
    h.sheet.mockResolvedValue(sheet);
    h.failWrite.on = true;
    const out = join(tmp, "lost3.pdf");
    expect((await json(...create(out))).code).toBe(EXIT.PARTIAL);
    expect(existsSync(out)).toBe(false);
  });

  it("--force keeps the previous file intact when the mint fails", async () => {
    h.sheet.mockRejectedValue(new AgreelyConflictError("ended", { code: "relationship_ended", status: 409 }));
    const out = join(tmp, "previous.pdf");
    writeFileSync(out, "previous signed pdf");
    expect((await json(...create(out, "--force"))).code).toBe(EXIT.USAGE);
    expect(readFileSync(out, "utf8")).toBe("previous signed pdf");
  });

  it("--force replaces the previous file only after the mint succeeded", async () => {
    h.sheet.mockResolvedValue(sheet);
    const out = join(tmp, "replaced.pdf");
    writeFileSync(out, "previous signed pdf that is longer than the new one");
    expect((await json(...create(out, "--force"))).code).toBe(EXIT.OK);
    expect(readFileSync(out, "utf8")).toBe("%PDF-1.4 x");
  });
});

describe("documents pdf opens its file first", () => {
  it("--force keeps the previous file when the download fails, a new path is removed", async () => {
    h.docPdf.mockRejectedValue(new AgreelyValidationError("no english", { code: "english_text_missing", status: 422 }));
    const kept = join(tmp, "kept-doc.pdf");
    writeFileSync(kept, "previous");
    await json("documents", "pdf", UUID, "--out", kept, "--force");
    expect(readFileSync(kept, "utf8")).toBe("previous");
    const fresh = join(tmp, "fresh-doc.pdf");
    await json("documents", "pdf", UUID, "--out", fresh);
    expect(existsSync(fresh)).toBe(false);
  });

  it("a missing directory never reaches the SDK", async () => {
    expect((await json("documents", "pdf", UUID, "--out", join(tmp, "nope", "d.pdf"))).code).toBe(EXIT.USAGE);
    expect(h.docPdf).not.toHaveBeenCalled();
  });
});

describe("writes: timeout, retry key, no global flags in the request", () => {
  it("a write client gets 15 s, a read 5 s, and check keeps the SDK default", async () => {
    h.withdraw.mockResolvedValue({ gate: "denied", alsoWithdrawn: [] });
    await json("withdraw", "c1", CONSENT, "--channel", "phone", "--operator", "o");
    expect(h.ctor.mock.calls[0]?.[0]).toMatchObject({ timeout: 15000 });
    h.ctor.mockReset();
    h.custGet.mockResolvedValue({ customerRef: "c1" });
    await json("customer", "get", "c1");
    expect(h.ctor.mock.calls[0]?.[0]).toMatchObject({ timeout: 5000 });
    h.ctor.mockReset();
    h.checkDetailed.mockResolvedValue({ decision: "allow", status: "active", checkedAt: "t" });
    await json("check", "c", "Cat", "Pur");
    expect(h.ctor.mock.calls[0]?.[0]).not.toHaveProperty("timeout");
  });

  it("a timeout prints the generated key so the retry reuses it", async () => {
    h.holdPlace.mockRejectedValue(new AgreelyTimeoutError("timed out", {}));
    const r = await json("holds", "place", "c1", "--ground", "rights_request");
    expect(r.code).toBe(EXIT.UNAVAILABLE);
    const sent = (h.holdPlace.mock.calls[0] as [string, unknown, { idempotencyKey: string }])[2].idempotencyKey;
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(r.err.trim()).error.idempotencyKey).toBe(sent);
  });

  it("request create sends and prints a key too, and a 409 retry prints it", async () => {
    h.reqCreate.mockRejectedValue(new AgreelyConflictError("in flight", { code: "retry", status: 409 }));
    const r = await json("request", "create", "--customer", "c1", "--to", "a@b.co", "--document", UUID, "--valid-until", "2027-01-01");
    const sent = (h.reqCreate.mock.calls[0] as [unknown, { idempotencyKey: string }])[1].idempotencyKey;
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(r.err.trim()).error).toMatchObject({ code: "retry", idempotencyKey: sent });
  });

  it("a user-given key is the one sent and printed", async () => {
    h.holdPlace.mockRejectedValue(new AgreelyTimeoutError("timed out", {}));
    const r = await json("holds", "place", "c1", "--ground", "rights_request", "--idempotency-key", "mine");
    expect(JSON.parse(r.err.trim()).error.idempotencyKey).toBe("mine");
  });

  it("manual-consent create takes --idempotency-key", async () => {
    h.mRecord.mockResolvedValue({ consentId: UUID, merkleRoot: "0x1", assurance: "company_attested", anchored: false, consentRefs: [], acknowledged: [], asksDeclined: false });
    const pdf = join(tmp, "k.pdf");
    writeFileSync(pdf, "%PDF-1.4 k");
    await json("manual-consent", "create", "--customer", "c", "--document-version", UUID, "--effective-date", "2026-10-01", "--valid-until", "2027-10-01", "--pdf", pdf, "--idempotency-key", "mk");
    expect(h.mRecord.mock.calls[0]?.[1]).toEqual({ idempotencyKey: "mk" });
  });

  it("--api-key never reaches a request input", async () => {
    h.custUpsert.mockResolvedValue({ customerRef: "c1", created: false });
    await json("customer", "set", "c1", "--email", "a@b.co", "--api-key", "ak_secret_key_9999");
    expect(JSON.stringify(h.custUpsert.mock.calls)).not.toContain("ak_secret");
  });
});

describe("input validation shared across commands", () => {
  const rec = [
    "verbal-consent", "record", "--customer", "c1", "--document-version", UUID, "--answer", "A:B=yes",
    "--obtained-at", "2026-10-09T10:00:00-04:00", "--obtained-by", "a", "--script-version", "v1",
    "--consented-by", "self", "--valid-until", "2027-10-09",
  ];
  const swap = (flag: string, value: string) => rec.map((a, i) => (rec[i - 1] === flag ? value : a));

  it("refuses an obtained-at without an offset and a valid-until phrase", async () => {
    expect((await json(...swap("--obtained-at", "2026-10-09T10:00:00"))).code).toBe(EXIT.USAGE);
    expect((await json(...swap("--valid-until", "next year"))).code).toBe(EXIT.USAGE);
    expect(h.vRecord).not.toHaveBeenCalled();
  });

  it("validates --capacity against its list and ties it to a representative", async () => {
    expect((await json(...rec, "--capacity", "tutelle")).code).toBe(EXIT.USAGE);
    expect((await json(...swap("--consented-by", "representative"))).code).toBe(EXIT.USAGE);
    expect((await json(...swap("--consented-by", "representative"), "--capacity", "wizard")).code).toBe(EXIT.USAGE);
    h.vRecord.mockResolvedValue({ consentId: UUID, tier: "verbal", assurance: "company_documented", consentRefs: [], acknowledged: [], asksDeclined: false });
    expect((await json(...swap("--consented-by", "representative"), "--capacity", "tutelle")).code).toBe(EXIT.OK);
  });

  it("an answer splits on the first colon only", async () => {
    h.vRecord.mockResolvedValue({ consentId: UUID, tier: "verbal", assurance: "company_documented", consentRefs: [], acknowledged: [], asksDeclined: false });
    await json(...swap("--answer", " Cat : Purpose: two =no"));
    expect((h.vRecord.mock.calls[0] as [{ answers: unknown }])[0].answers).toEqual([{ category: "Cat", purpose: "Purpose: two", answer: "no" }]);
  });

  it("withdraw accepts 64 hex with or without 0x, and refuses anything else", async () => {
    h.withdraw.mockResolvedValue({ gate: "denied", alsoWithdrawn: [] });
    const hex = "b".repeat(64);
    expect((await json("withdraw", "c1", hex, "--channel", "mail", "--operator", "o")).code).toBe(EXIT.OK);
    expect((await json("withdraw", "c1", "0xabc", "--channel", "mail", "--operator", "o")).code).toBe(EXIT.USAGE);
    expect(h.withdraw).toHaveBeenCalledTimes(1);
    expect((await json("withdraw", "c1", hex, "--channel", "mail", "--operator", "o", "--requested-at", "yesterday")).code).toBe(EXIT.USAGE);
  });

  it("customer set: one clearing rule, trimmed, legal basis and locale checked", async () => {
    h.custUpsert.mockResolvedValue({ customerRef: "c1", created: false });
    await json("customer", "set", "c1", "--display-name", " Ada ", "--basis-note", "", "--legal-basis", "", "--notice-locale", "en");
    expect(h.custUpsert).toHaveBeenCalledWith("c1", { displayName: "Ada", basisNote: null, legalBasis: null, noticeLocale: "en" });
    expect((await json("customer", "set", "c1", "--legal-basis", "consent")).code).toBe(EXIT.USAGE);
    expect((await json("customer", "set", "c1", "--notice-locale", "de")).code).toBe(EXIT.USAGE);
  });

  it("holds sync forwards --max-pages and refuses a bad one", async () => {
    h.holdSync.mockResolvedValue({ mode: "snapshot", holds: [], cursor: "c" });
    await json("holds", "sync", "--max-pages", "5");
    expect(h.holdSync).toHaveBeenCalledWith({ maxPages: 5 });
    expect((await json("holds", "sync", "--max-pages", "0")).code).toBe(EXIT.USAGE);
  });
});

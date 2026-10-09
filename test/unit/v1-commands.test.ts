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
  AgreelyValidationError,
} from "@agreely/sdk";
import type * as AgreelySdk from "@agreely/sdk";
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
    checkDetailed = h.checkDetailed;
  }
  return { ...actual, Agreely: FakeAgreely };
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
  for (const fn of Object.values(h)) fn.mockReset();
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
    expect(input).toMatchObject({
      customerId: "c1",
      documentVersionId: UUID,
      answers: [
        { category: "Cat A", purpose: "Purpose 1", answer: "yes" },
        { category: "Cat B", purpose: "Purpose 2", answer: "no" },
      ],
      respondent: { consentedBy: "self" },
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
    expect(h.custUpsert).toHaveBeenCalledWith("c1", { displayName: "Ada", email: "" });
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
    expect(h.holdPlace).toHaveBeenCalledWith("c1", { scope: "all", ground: "rights_request" }, {});
    expect((await json("holds", "place", "c1", "--ground", "other_law")).code).toBe(EXIT.USAGE);
    await json("holds", "place", "c1", "--ground", "other_law", "--provision", "Tax Act s. 1", "--rule", "r1", "--cell", "c9");
    expect(h.holdPlace).toHaveBeenLastCalledWith(
      "c1",
      { scope: { rules: ["r1"], cells: ["c9"] }, ground: "other_law", provision: "Tax Act s. 1" },
      {},
    );
  });

  it("release requires a reason", async () => {
    expect((await json("holds", "release", "c1", UUID)).code).toBe(EXIT.USAGE);
    h.holdRelease.mockResolvedValue({ id: UUID, placedBy: "api", agreelyIdentity: "none_held" });
    expect((await json("holds", "release", "c1", UUID, "--reason", "done")).code).toBe(EXIT.OK);
    expect(h.holdRelease).toHaveBeenCalledWith("c1", UUID, { reason: "done" }, {});
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

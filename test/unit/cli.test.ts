// The unit matrix for the CLI shell, with the SDK and the prompt library mocked.
// The @clack/prompts mock THROWS on any call, so any test that reaches a prompt
// fails loudly — that is how we prove agent mode never prompts.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgreelyAuthError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelyTimeoutError,
  AgreelyUnavailableError,
  AgreelyValidationError,
} from "@agreely/sdk";
import type * as AgreelySdk from "@agreely/sdk";
import { run } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { argv, makeIo, makeStore } from "./harness.js";

// --- the programmable SDK fake ------------------------------------------------
const h = vi.hoisted(() => ({
  checkDetailed: vi.fn(),
  catalogList: vi.fn(),
  identity: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
  record: vi.fn(),
  claimLink: vi.fn(),
  revoke: vi.fn(),
  erase: vi.fn(),
  relationshipEnd: vi.fn(),
  verify: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("@agreely/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof AgreelySdk>();
  class FakeAgreely {
    consentRequests = { create: h.create, list: h.list, get: h.get, cancel: h.cancel, waitForSettlement: h.wait };
    manualConsents = { record: h.record, createClaimLink: h.claimLink, revoke: h.revoke, erase: h.erase };
    relationships = { end: h.relationshipEnd };
    catalog = { list: h.catalogList };
    identity = h.identity;
    checkDetailed = h.checkDetailed;
    static verifyReceipt = h.verify;
    static hashPdf = actual.Agreely.hashPdf;
    constructor(opts: unknown) {
      h.ctor(opts);
    }
    async check(...a: unknown[]) {
      const r = (await h.checkDetailed(...a)) as { decision: string };
      return r.decision === "allow";
    }
  }
  return { ...actual, Agreely: FakeAgreely };
});

// Any prompt call throws — agent mode (non-TTY / --json) must never reach here.
vi.mock("@clack/prompts", () => {
  const boom = () => {
    throw new Error("PROMPTED");
  };
  return {
    intro: boom,
    outro: boom,
    text: boom,
    password: boom,
    multiselect: boom,
    select: boom,
    confirm: boom,
    spinner: boom,
    note: boom,
    cancel: boom,
    isCancel: () => false,
  };
});

const ENV = { AGREELY_API_KEY: "agr_live_testtesttesttesttesttesttesttesttest00" };

beforeEach(() => {
  vi.clearAllMocks();
  h.catalogList.mockResolvedValue([]);
});

// -----------------------------------------------------------------------------
describe("exit-code mapping (the agent contract)", () => {
  const allow = { decision: "allow", status: "active", consentRef: "0xabc", checkedAt: "t" };
  const deny = { decision: "deny", status: "none", checkedAt: "t" };

  it("ALLOW -> 0", async () => {
    h.checkDetailed.mockResolvedValue(allow);
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.OK);
  });

  it("DENY -> 10", async () => {
    h.checkDetailed.mockResolvedValue(deny);
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.DENY);
  });

  it("auth error -> 3", async () => {
    h.checkDetailed.mockRejectedValue(new AgreelyAuthError("bad", { code: "unauthorized", status: 401 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.AUTH);
  });

  it("unavailable (outage) -> 4 (distinct from deny)", async () => {
    h.checkDetailed.mockRejectedValue(new AgreelyUnavailableError("down", { status: 503 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.UNAVAILABLE);
  });

  it("rate-limited -> 5", async () => {
    h.checkDetailed.mockRejectedValue(
      new AgreelyRateLimitError("slow", { code: "rate_limited", status: 429, retryAfter: 7 }),
    );
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.RATE_LIMITED);
  });

  it("validation -> 2", async () => {
    h.checkDetailed.mockRejectedValue(
      new AgreelyValidationError("bad", { code: "invalid_request", status: 422, field: "purpose" }),
    );
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "Cat", "", "--json"), io.io)).toBe(EXIT.USAGE);
  });

  it("missing required arg -> 2 (usage), and NEVER prompts", async () => {
    const io = makeIo({ env: ENV });
    expect(await run(argv("check", "c", "--json"), io.io)).toBe(EXIT.USAGE);
    expect(io.err()).not.toContain("PROMPTED");
  });

  it("no credentials -> 2", async () => {
    const io = makeIo({ env: {} });
    expect(await run(argv("check", "c", "Cat", "Pur", "--json"), io.io)).toBe(EXIT.USAGE);
  });
});

// -----------------------------------------------------------------------------
describe("--json emits PURE JSON to stdout and nothing else", () => {
  it("a success writes one parseable JSON line, stderr empty", async () => {
    h.checkDetailed.mockResolvedValue({ decision: "allow", status: "active", consentRef: "0xabc", checkedAt: "t" });
    const io = makeIo({ env: ENV });
    await run(argv("check", "c", "Cat", "Pur", "--json"), io.io);
    const out = io.out().trim();
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual({ decision: "allow", status: "active", consentRef: "0xabc" });
    expect(io.err()).toBe("");
  });

  it("a DENY still goes to stdout (it is not an error)", async () => {
    h.checkDetailed.mockResolvedValue({ decision: "deny", status: "revoked", consentRef: "0xdef", checkedAt: "t" });
    const io = makeIo({ env: ENV });
    const code = await run(argv("check", "c", "Cat", "Pur", "--json"), io.io);
    expect(code).toBe(EXIT.DENY);
    expect(JSON.parse(io.out().trim())).toEqual({ decision: "deny", status: "revoked", consentRef: "0xdef" });
    expect(io.err()).toBe("");
  });

  it("an ERROR keeps stdout clean; the envelope goes to stderr", async () => {
    h.checkDetailed.mockRejectedValue(new AgreelyAuthError("bad", { code: "unauthorized", status: 401 }));
    const io = makeIo({ env: ENV });
    await run(argv("check", "c", "Cat", "Pur", "--json"), io.io);
    expect(io.out()).toBe("");
    expect(JSON.parse(io.err().trim())).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("non-TTY (no --json) is still agent mode: JSON out", async () => {
    h.checkDetailed.mockResolvedValue({ decision: "allow", status: "active", checkedAt: "t" });
    const io = makeIo({ env: ENV, isTTY: false });
    await run(argv("check", "c", "Cat", "Pur"), io.io);
    expect(() => JSON.parse(io.out().trim())).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
describe("agent mode never prompts", () => {
  it("`request create` with no flags in a non-TTY errors (exit 2), does not prompt", async () => {
    const io = makeIo({ env: ENV, isTTY: false });
    const code = await run(argv("request", "create"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.err()).not.toContain("PROMPTED");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("--json forces agent mode even when stdout is a TTY", async () => {
    const io = makeIo({ env: ENV, isTTY: true });
    const code = await run(argv("request", "create", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.err()).not.toContain("PROMPTED");
  });
});

// -----------------------------------------------------------------------------
describe("auth precedence: flag > env > keychain > config", () => {
  const flagKey = "agr_live_FLAGFLAGFLAGFLAGFLAGFLAGFLAGFLAGFLAGFLAG01";
  const envKey = "agr_live_ENVENVENVENVENVENVENVENVENVENVENVENVENV0002";
  const storeKey = "agr_live_STORESTORESTORESTORESTORESTORESTORESTORE03";

  function ctorOpts() {
    return h.ctor.mock.calls[0]?.[0] as { apiKey: string; baseUrl?: string };
  }

  it("flag wins over env and store", async () => {
    const io = makeIo({ env: { AGREELY_API_KEY: envKey } });
    const store = makeStore({ apiKey: { value: storeKey, source: "keychain" } });
    await run(argv("catalog", "--api-key", flagKey, "--json"), io.io, store);
    expect(ctorOpts().apiKey).toBe(flagKey);
  });

  it("env wins over store", async () => {
    const io = makeIo({ env: { AGREELY_API_KEY: envKey } });
    const store = makeStore({ apiKey: { value: storeKey, source: "keychain" } });
    await run(argv("catalog", "--json"), io.io, store);
    expect(ctorOpts().apiKey).toBe(envKey);
  });

  it("store (keychain) is used when no flag and no env", async () => {
    const io = makeIo({ env: {} });
    const store = makeStore({ apiKey: { value: storeKey, source: "keychain" } });
    await run(argv("catalog", "--json"), io.io, store);
    expect(ctorOpts().apiKey).toBe(storeKey);
  });

  it("base URL precedence: flag > env > store", async () => {
    const io = makeIo({ env: { AGREELY_API_KEY: envKey, AGREELY_BASE_URL: "http://env" } });
    const store = makeStore({ apiKey: { value: storeKey, source: "config" }, baseUrl: "http://store" });
    await run(argv("catalog", "--base-url", "http://flag", "--json"), io.io, store);
    expect(ctorOpts().baseUrl).toBe("http://flag");

    h.ctor.mockClear();
    const io2 = makeIo({ env: { AGREELY_API_KEY: envKey, AGREELY_BASE_URL: "http://env" } });
    await run(argv("catalog", "--json"), io2.io, store);
    expect(ctorOpts().baseUrl).toBe("http://env");
  });
});

// -----------------------------------------------------------------------------
describe("request create maps flags to the SDK input (bound consent document)", () => {
  const issued = {
    requestId: "0x" + "a".repeat(64),
    status: "pending",
    deepLink: "http://x",
    emailDelivered: true,
    items: [],
    document: { code: "terms", name: "Terms", version: "1.0" },
  };

  it("passes --document as consentDocumentId and never an items list", async () => {
    h.create.mockResolvedValue(issued);
    const io = makeIo({ env: ENV });
    const code = await run(
      argv(
        "request",
        "create",
        "--customer",
        "cust-1",
        "--to",
        "ops@acme.example",
        "--document",
        "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
        "--valid-until",
        "2030-01-01",
        "--json",
      ),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    expect(h.create).toHaveBeenCalledTimes(1);
    const [input] = h.create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toEqual({
      customerId: "cust-1",
      recipientEmail: "ops@acme.example",
      consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
      validUntil: "2030-01-01",
    });
  });

  it("passes --document-code as documentCode", async () => {
    h.create.mockResolvedValue(issued);
    const io = makeIo({ env: ENV });
    const code = await run(
      argv(
        "request",
        "create",
        "--customer",
        "cust-1",
        "--to",
        "ops@acme.example",
        "--document-code",
        "conditions-marketing",
        "--valid-until",
        "2030-01-01",
        "--json",
      ),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    const [input] = h.create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toEqual({
      customerId: "cust-1",
      recipientEmail: "ops@acme.example",
      documentCode: "conditions-marketing",
      validUntil: "2030-01-01",
    });
  });

  it("errors (exit 2) without a --document/--document-code and never calls the SDK", async () => {
    const io = makeIo({ env: ENV, isTTY: false });
    const code = await run(
      argv("request", "create", "--customer", "c", "--to", "a@b.co", "--valid-until", "2030-01-01"),
      io.io,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(io.err()).toContain("--document");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("forwards --idempotency-key to the SDK create options", async () => {
    h.create.mockResolvedValue(issued);
    const io = makeIo({ env: ENV });
    await run(
      argv(
        "request",
        "create",
        "--customer",
        "c",
        "--to",
        "a@b.co",
        "--document-code",
        "terms",
        "--valid-until",
        "2030-01-01",
        "--idempotency-key",
        "key-123",
        "--json",
      ),
      io.io,
    );
    const [, opts] = h.create.mock.calls[0] as [unknown, { idempotencyKey?: string }];
    expect(opts).toEqual({ idempotencyKey: "key-123" });
  });
});

// -----------------------------------------------------------------------------
describe("manual-consent create: local PDF hashing (data minimization)", () => {
  const recorded = {
    consentId: "mc_1",
    merkleRoot: "0x" + "1".repeat(64),
    consentRefs: ["0x" + "a".repeat(64)],
    assurance: "company_attested",
    anchored: false,
  };
  const PDF_BYTES = Buffer.from("%PDF-1.7 signed consent bytes");
  const EXPECTED_SHA = "0x" + createHash("sha256").update(PDF_BYTES).digest("hex");

  function writePdf(): string {
    const dir = mkdtempSync(join(tmpdir(), "agreely-mc-"));
    const path = join(dir, "consent.pdf");
    writeFileSync(path, PDF_BYTES);
    return path;
  }

  it("computes the SHA-256 locally and sends ONLY the hash (no bytes) by default", async () => {
    h.record.mockResolvedValue(recorded);
    const pdf = writePdf();
    const io = makeIo({ env: ENV });
    const code = await run(
      argv(
        "manual-consent",
        "create",
        "--customer",
        "cust-1",
        "--document-version",
        "doc-9",
        "--effective-date",
        "2026-06-01",
        "--valid-until",
        "2031-01-01",
        "--item",
        "Email Address:Marketing Outreach",
        "--item",
        "cat-uuid-123",
        "--pdf",
        pdf,
        "--json",
      ),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    expect(h.record).toHaveBeenCalledTimes(1);
    const [input] = h.record.mock.calls[0] as [Record<string, unknown>];
    expect(input).toEqual({
      customerId: "cust-1",
      documentVersionId: "doc-9",
      effectiveDate: "2026-06-01",
      validUntil: "2031-01-01",
      items: [{ category: "Email Address", purpose: "Marketing Outreach" }, "cat-uuid-123"],
      evidence: { pdfSha256: EXPECTED_SHA },
    });
    expect(JSON.parse(io.out().trim())).toEqual(recorded);
  });

  it("uploads the bytes (base64) ONLY when --upload is passed", async () => {
    h.record.mockResolvedValue(recorded);
    const pdf = writePdf();
    const io = makeIo({ env: ENV });
    await run(
      argv(
        "manual-consent",
        "create",
        "--customer",
        "c",
        "--document-version",
        "d",
        "--effective-date",
        "2026-06-01",
        "--valid-until",
        "2031-01-01",
        "--item",
        "x:y",
        "--pdf",
        pdf,
        "--upload",
        "--json",
      ),
      io.io,
    );
    const [input] = h.record.mock.calls[0] as [{ evidence: { pdfSha256: string; pdf?: string } }];
    expect(input.evidence.pdfSha256).toBe(EXPECTED_SHA);
    expect(input.evidence.pdf).toBe(PDF_BYTES.toString("base64"));
  });

  it("a missing required flag errors (exit 2) and NEVER prompts or calls the SDK", async () => {
    const io = makeIo({ env: ENV, isTTY: false });
    const code = await run(argv("manual-consent", "create", "--customer", "c"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.err()).not.toContain("PROMPTED");
    expect(h.record).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("manual-consent claim-link / revoke", () => {
  it("claim-link posts the customer and prints the link JSON", async () => {
    const link = { claimUrl: "https://x/claim/abc", token: "tok_abc", expiresAt: "2026-07-01T00:00:00Z" };
    h.claimLink.mockResolvedValue(link);
    const io = makeIo({ env: ENV });
    const code = await run(
      argv("manual-consent", "claim-link", "--customer", "cust-1", "--reference", "order-99", "--json"),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    const [input] = h.claimLink.mock.calls[0] as [Record<string, unknown>];
    expect(input).toEqual({ customerId: "cust-1", reference: "order-99" });
    expect(JSON.parse(io.out().trim())).toEqual(link);
  });

  it("revoke is keyed on the consentRef and forwards the reason", async () => {
    const ref = "0x" + "a".repeat(64);
    h.revoke.mockResolvedValue({ consentRef: ref, revoked: true, alreadyRevoked: false });
    const io = makeIo({ env: ENV });
    const code = await run(
      argv("manual-consent", "revoke", ref, "--reason", "withdrawn", "--json"),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    const [consentRef, opts] = h.revoke.mock.calls[0] as [string, { reason?: string }];
    expect(consentRef).toBe(ref);
    expect(opts).toEqual({ reason: "withdrawn" });
  });

  it("revoke rejects a non-0x consentRef (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("manual-consent", "revoke", "not-a-ref", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.revoke).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("manual-consent erase (parity with the SDK erase)", () => {
  it("erase is keyed on the consentRef and forwards the reason (JSON)", async () => {
    const ref = "0x" + "b".repeat(64);
    h.erase.mockResolvedValue({ consentRef: ref, erased: true, alreadyErased: false });
    const io = makeIo({ env: ENV });
    const code = await run(
      argv("manual-consent", "erase", ref, "--reason", "art-28.1 request", "--json"),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    const [consentRef, opts] = h.erase.mock.calls[0] as [string, { reason?: string }];
    expect(consentRef).toBe(ref);
    expect(opts).toEqual({ reason: "art-28.1 request" });
    expect(JSON.parse(io.out().trim())).toEqual({ consentRef: ref, erased: true, alreadyErased: false });
  });

  it("erase rejects a non-0x consentRef (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("manual-consent", "erase", "nope", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.erase).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("whoami (server-verified via /v1/whoami)", () => {
  it("calls identity() and reports the REAL server scopes (JSON)", async () => {
    h.identity.mockResolvedValue({ scopes: ["check", "issue"] });
    const io = makeIo({ env: ENV });
    const code = await run(argv("whoami", "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    expect(h.identity).toHaveBeenCalledTimes(1);
    // It no longer derives identity by listing the catalog.
    expect(h.catalogList).not.toHaveBeenCalled();
    const out = JSON.parse(io.out().trim());
    expect(out).toMatchObject({ authenticated: true, scopes: ["check", "issue"] });
    // No secret leaks: the raw key never appears, only a masked form.
    expect(io.out()).not.toContain(ENV.AGREELY_API_KEY);
  });

  it("a bad key surfaces as exit 3 (auth)", async () => {
    h.identity.mockRejectedValue(new AgreelyAuthError("bad", { code: "unauthorized", status: 401 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("whoami", "--json"), io.io)).toBe(EXIT.AUTH);
  });
});

// -----------------------------------------------------------------------------
describe("request cancel", () => {
  const rid = "0x" + "a".repeat(64);

  it("cancels a pending request and prints the outcome (exit 0, JSON)", async () => {
    h.cancel.mockResolvedValue({ requestId: rid, status: "revoked_before_action", cancelled: true });
    const io = makeIo({ env: ENV });
    const code = await run(argv("request", "cancel", rid, "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    expect(h.cancel).toHaveBeenCalledWith(rid);
    expect(JSON.parse(io.out().trim())).toEqual({ requestId: rid, status: "revoked_before_action", cancelled: true });
  });

  it("is idempotent: an already-terminal request still exits 0 (cancelled:false)", async () => {
    h.cancel.mockResolvedValue({ requestId: rid, status: "approved", cancelled: false });
    const io = makeIo({ env: ENV });
    const code = await run(argv("request", "cancel", rid, "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(io.out().trim()).cancelled).toBe(false);
  });

  it("a check-only key (403 forbidden) surfaces as exit 3 (auth)", async () => {
    h.cancel.mockRejectedValue(new AgreelyAuthError("no scope", { code: "forbidden", status: 403 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("request", "cancel", rid, "--json"), io.io)).toBe(EXIT.AUTH);
  });

  it("rejects a bad requestId (exit 2) and never calls the SDK", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("request", "cancel", "0xshort", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.cancel).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("relationship end", () => {
  const ref = "cust-1";
  const ended = { customerRef: ref, status: "ended", endedAt: "2026-07-02T10:00:00Z", endedBy: "company" };

  it("ends the relationship and prints the outcome (exit 0, JSON)", async () => {
    h.relationshipEnd.mockResolvedValue(ended);
    const io = makeIo({ env: ENV });
    const code = await run(argv("relationship", "end", ref, "--reason", "purposes accomplished", "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    expect(h.relationshipEnd).toHaveBeenCalledWith({ customerRef: ref, reason: "purposes accomplished" });
    expect(JSON.parse(io.out().trim())).toEqual(ended);
  });

  it("requires --reason and NEVER calls the SDK when it is missing (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("relationship", "end", ref, "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.relationshipEnd).not.toHaveBeenCalled();
  });

  it("rejects a blank --reason and never calls the SDK (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("relationship", "end", ref, "--reason", "   ", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.relationshipEnd).not.toHaveBeenCalled();
  });

  it("a scope-less key (403 forbidden) surfaces as exit 3 (auth)", async () => {
    h.relationshipEnd.mockRejectedValue(new AgreelyAuthError("no scope", { code: "forbidden", status: 403 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("relationship", "end", ref, "--reason", "done", "--json"), io.io)).toBe(EXIT.AUTH);
  });

  it("an unknown/foreign ref (404) surfaces as exit 2 (usage)", async () => {
    h.relationshipEnd.mockRejectedValue(new AgreelyNotFoundError("no such customer", { code: "not_found", status: 404 }));
    const io = makeIo({ env: ENV });
    expect(await run(argv("relationship", "end", "ghost", "--reason", "done", "--json"), io.io)).toBe(EXIT.USAGE);
  });
});

// -----------------------------------------------------------------------------
describe("request wait", () => {
  const settled = {
    requestId: "0x" + "c".repeat(64),
    status: "approved",
    validUntil: "t",
    expiresAt: "t",
    createdAt: "t",
    settledAt: "t",
    items: [],
  };

  it("polls to a terminal state and prints the record (JSON)", async () => {
    h.wait.mockResolvedValue(settled);
    const io = makeIo({ env: ENV });
    const code = await run(
      argv("request", "wait", settled.requestId, "--interval", "10", "--timeout", "50", "--json"),
      io.io,
    );
    expect(code).toBe(EXIT.OK);
    const [requestId, opts] = h.wait.mock.calls[0] as [string, { intervalMs?: number; timeoutMs?: number }];
    expect(requestId).toBe(settled.requestId);
    expect(opts).toEqual({ intervalMs: 10, timeoutMs: 50 });
    expect(JSON.parse(io.out().trim())).toEqual(settled);
  });

  it("maps a wait timeout to exit 4", async () => {
    h.wait.mockRejectedValue(new AgreelyTimeoutError("timed out", { lastStatus: "pending" }));
    const io = makeIo({ env: ENV });
    const code = await run(argv("request", "wait", settled.requestId, "--json"), io.io);
    expect(code).toBe(EXIT.UNAVAILABLE);
  });

  it("rejects a bad requestId (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("request", "wait", "0xshort", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.wait).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("verify (the headline)", () => {
  const matrix = (overall: string) => ({
    receiptType: "company_attested",
    companySignature: overall === "failed" ? "fail" : "pass",
    citizenAssertion: "unsupported",
    disclosureCopy: "skipped",
    documentAnchor: "skipped",
    overall,
    notes: ["note one", "note two"],
  });

  function writeReceipt(): string {
    const dir = mkdtempSync(join(tmpdir(), "agreely-verify-"));
    const path = join(dir, "receipt.json");
    writeFileSync(path, JSON.stringify({ type: ["VerifiableCredential", "ConsentReceipt"] }));
    return path;
  }

  it("verified -> exit 0 and emits the matrix JSON", async () => {
    h.verify.mockResolvedValue(matrix("verified"));
    const io = makeIo({ env: ENV });
    const path = writeReceipt();
    const code = await run(argv("verify", path, "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(io.out().trim())).toEqual(matrix("verified"));
    // No auth needed for offline verify.
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("partial (citizen offline) -> exit 0", async () => {
    h.verify.mockResolvedValue(matrix("partial"));
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--json"), io.io);
    expect(code).toBe(EXIT.OK);
  });

  it("failed -> exit 6", async () => {
    h.verify.mockResolvedValue(matrix("failed"));
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--json"), io.io);
    expect(code).toBe(EXIT.VERIFY_FAILED);
  });

  it("unavailable (unresolvable DID) -> exit 4, NOT 6 (distinct from a tamper)", async () => {
    h.verify.mockResolvedValue({
      ...matrix("unavailable"),
      companySignature: "unavailable",
    });
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--json"), io.io);
    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(code).not.toBe(EXIT.VERIFY_FAILED);
  });

  it("--did-doc supplies a local resolver for an air-gapped verify", async () => {
    h.verify.mockResolvedValue(matrix("verified"));
    const dir = mkdtempSync(join(tmpdir(), "agreely-diddoc-"));
    const docPath = join(dir, "did.json");
    writeFileSync(docPath, JSON.stringify({ id: "did:web:api.agreely.ca:c:acme", verificationMethod: [] }));
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--did-doc", docPath, "--json"), io.io);
    expect(code).toBe(EXIT.OK);
    const [, opts] = h.verify.mock.calls[0] as [unknown, { resolver?: (did: string) => unknown }];
    expect(typeof opts.resolver).toBe("function");
    // The local resolver returns the supplied doc by id, and null for anything else.
    expect(opts.resolver!("did:web:api.agreely.ca:c:acme")).toMatchObject({ id: "did:web:api.agreely.ca:c:acme" });
    expect(opts.resolver!("did:web:unknown")).toBeNull();
  });

  it("--did-doc with a file that has no id is a usage error (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agreely-diddoc-"));
    const docPath = join(dir, "bad.json");
    writeFileSync(docPath, JSON.stringify({ verificationMethod: [] }));
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--did-doc", docPath, "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("passes --ipfs / --onchain through as verifier options", async () => {
    h.verify.mockResolvedValue(matrix("verified"));
    const io = makeIo({ env: { ...ENV, AGREELY_RPC_URL: "https://rpc.test" } });
    await run(argv("verify", writeReceipt(), "--ipfs", "--onchain", "--json"), io.io);
    const [, opts] = h.verify.mock.calls[0] as [unknown, { verifyDisclosure?: boolean; rpcUrl?: string }];
    expect(opts.verifyDisclosure).toBe(true);
    expect(opts.rpcUrl).toBe("https://rpc.test");
  });

  it("--onchain without an rpc url is a usage error (exit 2)", async () => {
    h.verify.mockResolvedValue(matrix("verified"));
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", writeReceipt(), "--onchain", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("a missing receipt file is a usage error (exit 2)", async () => {
    const io = makeIo({ env: ENV });
    const code = await run(argv("verify", "/no/such/receipt.json", "--json"), io.io);
    expect(code).toBe(EXIT.USAGE);
  });
});

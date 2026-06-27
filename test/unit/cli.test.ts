// The unit matrix for the CLI shell, with the SDK and the prompt library mocked.
// The @clack/prompts mock THROWS on any call, so any test that reaches a prompt
// fails loudly — that is how we prove agent mode never prompts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgreelyAuthError,
  AgreelyRateLimitError,
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
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("@agreely/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof AgreelySdk>();
  class FakeAgreely {
    consentRequests = { create: h.create, list: h.list, get: h.get };
    catalog = { list: h.catalogList };
    checkDetailed = h.checkDetailed;
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
describe("request create maps flags to the SDK input (raw category/purpose)", () => {
  const issued = {
    requestId: "0x" + "a".repeat(64),
    status: "pending",
    deepLink: "http://x",
    emailDelivered: true,
    items: [],
  };

  it("passes a {category,purpose} pair RAW and a catalog id as a string", async () => {
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
        "--item",
        "Email Address:Marketing Outreach",
        "--item",
        "cat-uuid-123",
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
      items: [{ category: "Email Address", purpose: "Marketing Outreach" }, "cat-uuid-123"],
      validUntil: "2030-01-01",
    });
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
        "--item",
        "x:y",
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

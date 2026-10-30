// `agreely verify` through the CLI for the issuer's departure (issuerDeparture, departure) and the company domain's live
// DNS declaration (liveDns): the SDK's vector cases, copied into test/fixtures/verify, run end to end. The departure
// record and the DNS-over-HTTPS answer come from the case's `http` map through a stubbed fetch, so nothing leaves the
// machine; the RPC stays on 127.0.0.1 (withChain) and is forwarded to the real fetch.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { withChain, type VectorAnswers } from "./chain.js";
import { argv, makeIo } from "./harness.js";

const fixture = (rel: string): string => fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));

interface HttpAnswer {
  status?: number;
  body?: unknown;
}

interface Options {
  checkDeparture?: boolean;
  checkDns?: boolean;
  dohUrl?: string;
}

interface Case {
  name: string;
  /** The bundle, under vectors/ (the default the loader gives a case that names none). */
  file: string;
  /** The DID documents, under vectors/. */
  documents: string;
  issuerDocument?: Record<string, unknown>;
  http: Record<string, HttpAnswer>;
  answers: VectorAnswers | null;
  options: Options;
  expect: Record<string, unknown>;
  asked: string[];
}

/**
 * A case file's cases. A case names its own bundle and DID documents only when it differs from the default, which the
 * live-dns vectors do not: they all verify receipts/a3v4.bundle.json against receipts/v4-did-documents.json.
 */
async function loadCases(rel: string): Promise<Case[]> {
  const raw = JSON.parse(await readFile(fixture(rel), "utf8")) as { cases: Array<Partial<Case> & Omit<Case, "file" | "documents">> };
  return raw.cases.map((c) => ({ file: "receipts/a3v4.bundle.json", documents: "receipts/v4-did-documents.json", ...c }));
}

const DEPARTURE = { cases: await loadCases("verify/issuer-departure.cases.json") };
const DNS = { cases: await loadCases("verify/live-dns.cases.json") };
const ISSUER = "did:web:verify.agreely.ca:c:demo-co";

/** The exit code of each departure case, as the verdict the SDK reads makes it: verified 0, failed 6. */
const DEPARTURE_EXIT: Readonly<Record<string, number>> = {
  "signed before the departure: the signature stands": EXIT.OK,
  "signed during the departure: the signature stands": EXIT.OK,
  "dated after the purge: failed": EXIT.VERIFY_FAILED,
  // Verified, but the departure counts under a confirmed key: the chain no longer reads the consent in force, so with
  // --onchain the existing withdrawal rule exits 4 (no new code for the departure).
  "before, under a key the registry confirms: the consent stops reading active": EXIT.UNAVAILABLE,
  "a departure record that cannot be read changes nothing": EXIT.OK,
  "checkDeparture false asks for nothing": EXIT.OK,
};

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agreely-cli-departure-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The v4 DID documents, the issuer's patched with a case's issuerDocument, written one file per document for --did-doc. */
async function didDocFlags(documents: string, patch: Record<string, unknown> | undefined, prefix: string): Promise<string[]> {
  const docs = JSON.parse(await readFile(fixture(`vectors/${documents}`), "utf8")) as Record<string, Record<string, unknown>>;
  const flags: string[] = [];
  let i = 0;
  for (const doc of Object.values(docs)) {
    const copy = structuredClone(doc);
    if (patch !== undefined && copy["id"] === ISSUER) Object.assign(copy, patch);
    const path = join(dir, `${prefix}-${String(i++)}.did.json`);
    await writeFile(path, JSON.stringify(copy));
    flags.push("--did-doc", path);
  }
  return flags;
}

/**
 * Stubs fetch for the run: an `http` answer by exact URL, a network error for any other external URL (and recorded in
 * `asked`), and the local RPC forwarded to the real fetch. Restored by afterEach.
 */
function stubFetch(http: Record<string, HttpAnswer>): string[] {
  const asked: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://127.0.0.1")) return real(input, init);
    asked.push(url);
    const answer = http[url];
    if (answer === undefined) throw new TypeError("fetch failed");
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return asked;
}

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

/** The CLI flags a vector case's options ask for: checkDeparture false, checkDns false, dohUrl. */
function flagsFor(options: Options): string[] {
  return [
    ...(options.checkDeparture === false ? ["--no-departure"] : []),
    ...(options.checkDns === false ? ["--no-dns"] : []),
    ...(options.dohUrl !== undefined ? ["--doh-url", options.dohUrl] : []),
  ];
}

/** Each key of a vector case's `expect` is read field by field: `absent` lists fields that must not be there. */
function expectFields(json: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (key === "absent") {
      for (const field of value as string[]) expect(json).not.toHaveProperty(field);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      expect(json[key]).toMatchObject(value as Record<string, unknown>);
    } else {
      expect(json[key]).toEqual(value);
    }
  }
}

describe("issuer-departure.json: the departure of the issuer, through the CLI", () => {
  it("every vector case has an exit code here", () => {
    expect(DEPARTURE.cases.map((c) => c.name).sort()).toEqual(Object.keys(DEPARTURE_EXIT).sort());
  });

  it.each(DEPARTURE.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    await withChain(c.answers ?? {}, async (chain) => {
      const asked = stubFetch(c.http);
      const docs = await didDocFlags(c.documents, c.issuerDocument, "departure");
      const onchain = c.answers !== null ? ["--onchain", "--rpc-url", chain.url] : [];
      const { json, human } = await verify(fixture(`vectors/${c.file}`), ...docs, ...onchain, ...flagsFor(c.options));
      expectFields(json.json, c.expect);
      // Two runs (--json, then the matrix) ask each URL once each, in order.
      expect(asked).toEqual([...c.asked, ...c.asked]);
      expect(json.code).toBe(DEPARTURE_EXIT[c.name]);
      expect(human.code).toBe(DEPARTURE_EXIT[c.name]);
      if (c.expect["departure"] !== undefined) expect(human.out).toMatch(/issuerDeparture\s+\S+\s+\S+/);
      else expect(human.out).not.toContain("issuerDeparture");
    });
  });
});

describe("live-dns.json: the company domain's DNS declaration, through the CLI", () => {
  it("every vector case is run here", () => {
    expect(DNS.cases.length).toBe(6);
  });

  it.each(DNS.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    await withChain(c.answers ?? {}, async (chain) => {
      const asked = stubFetch(c.http);
      const docs = await didDocFlags(c.documents, c.issuerDocument, "dns");
      const onchain = ["--onchain", "--rpc-url", chain.url, ...flagsFor(c.options)];
      const { json, human } = await verify(fixture(`vectors/${c.file}`), ...docs, ...onchain);
      expectFields(json.json, c.expect);
      expect(asked).toEqual([...c.asked, ...c.asked]);
      // liveDns never changes the exit code: the same run without it (--no-dns) exits the same way.
      const without = await verify(fixture(`vectors/${c.file}`), ...docs, "--onchain", "--rpc-url", chain.url, "--no-dns");
      expect(json.code).toBe(without.json.code);
      expect(human.code).toBe(without.human.code);
      if (c.expect["liveDns"] !== undefined) {
        expect(human.out).toMatch(/liveDns\s+\S+\s+\S+/);
        expect(human.out).toContain(String((c.expect["liveDns"] as { keyId: string }).keyId));
      } else {
        expect(human.out).not.toContain("liveDns");
      }
    });
  });
});

describe("the flags, one by one", () => {
  const departedCase = DEPARTURE.cases.find((c) => c.name === "dated after the purge: failed")!;

  it("--no-departure asks no departure record, and the verdict is the one the SDK reads without the check", async () => {
    const asked = stubFetch(departedCase.http);
    const docs = await didDocFlags(departedCase.documents, departedCase.issuerDocument, "flag-departure");
    const { json, human } = await verify(fixture(`vectors/${departedCase.file}`), ...docs, "--no-departure");
    expect(asked).toEqual([]);
    expect(json.json).not.toHaveProperty("issuerDeparture");
    expect(human.out).not.toContain("issuerDeparture");
    expect(json.code).toBe(EXIT.OK);
  });

  it("--no-dns asks no DNS-over-HTTPS resolver and prints no liveDns row", async () => {
    const dnsCase = DNS.cases.find((c) => c.name === "the zone declares the key the registry names: confirmed")!;
    await withChain(dnsCase.answers ?? {}, async (chain) => {
      const asked = stubFetch(dnsCase.http);
      const docs = await didDocFlags(dnsCase.documents, dnsCase.issuerDocument, "flag-dns");
      const { json, human } = await verify(fixture(`vectors/${dnsCase.file}`), ...docs, "--onchain", "--rpc-url", chain.url, "--no-dns");
      expect(asked).toEqual([]);
      expect(json.json).not.toHaveProperty("liveDns");
      expect(human.out).not.toContain("liveDns");
    });
  });

  it("--doh-url asks the resolver it names, and nothing else", async () => {
    const dohCase = DNS.cases.find((c) => c.name === "dohUrl names the resolver")!;
    await withChain(dohCase.answers ?? {}, async (chain) => {
      const asked = stubFetch(dohCase.http);
      const docs = await didDocFlags(dohCase.documents, dohCase.issuerDocument, "flag-doh");
      const { json } = await verify(fixture(`vectors/${dohCase.file}`), ...docs, "--onchain", "--rpc-url", chain.url, "--doh-url", dohCase.options.dohUrl!);
      expect(asked).toEqual([dohCase.options.dohUrl + "?name=_agreely.demo-co.example&type=TXT", dohCase.options.dohUrl + "?name=_agreely.demo-co.example&type=TXT"]);
      expect((json.json["liveDns"] as { resolver: string }).resolver).toBe(dohCase.options.dohUrl);
    });
  });

  it.each([["ftp://dns.example/dns-query"], ["http://dns.example/dns-query"], ["not a url"], ["dns.example/dns-query"]])(
    "--doh-url %s is refused before any request is sent",
    async (value) => {
      const asked = stubFetch({});
      const { human } = await verify(fixture("vectors/receipts/a3v4.bundle.json"), "--doh-url", value);
      expect(human.code).toBe(EXIT.USAGE);
      expect(asked).toEqual([]);
    },
  );
});

describe("the --onchain withdrawal hint for a departed issuer", () => {
  it("says the record was read and the issuer departed, not that no consent record is named, and exits 4", async () => {
    const departed = DEPARTURE.cases.find(
      (c) => c.name === "before, under a key the registry confirms: the consent stops reading active",
    )!;
    await withChain(departed.answers ?? {}, async (chain) => {
      stubFetch(departed.http);
      const docs = await didDocFlags(departed.documents, departed.issuerDocument, "hint-departure");
      const { human } = await verify(fixture(`vectors/${departed.file}`), ...docs, "--onchain", "--rpc-url", chain.url);
      expect(human.code).toBe(EXIT.UNAVAILABLE);
      expect(human.out).toContain("the consent record was read, but the issuer has departed");
      expect(human.out).not.toContain("names no consent record");
    });
  });
});

describe("the matrix rows", () => {
  it("a departed issuer's row names the state, its two days, and where the signing instant falls", async () => {
    const before = DEPARTURE.cases.find((c) => c.name === "signed before the departure: the signature stands")!;
    stubFetch(before.http);
    const docs = await didDocFlags(before.documents, before.issuerDocument, "row-departure");
    const { human } = await verify(fixture(`vectors/${before.file}`), ...docs);
    const line = human.out.split("\n").find((l) => l.includes("issuerDeparture")) ?? "";
    expect(line).toMatch(/issuerDeparture\s+pass\s+departed/);
    expect(line).toContain("2026-07-01");
    expect(line).toContain("2026-08-01");
  });

  it("a live issuer has no issuerDeparture row, and no liveDns row without --onchain", async () => {
    stubFetch({});
    const docs = await didDocFlags("receipts/v4-did-documents.json", undefined, "row-live");
    const { json, human } = await verify(fixture("vectors/receipts/a3v4.bundle.json"), ...docs);
    expect(json.json).not.toHaveProperty("issuerDeparture");
    expect(json.json).not.toHaveProperty("liveDns");
    expect(human.out).not.toContain("issuerDeparture");
    expect(human.out).not.toContain("liveDns");
  });
});

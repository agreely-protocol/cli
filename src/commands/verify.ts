// agreely verify <receipt.json> [--onchain] [--ipfs] [--rpc-url <url>]
//                               [--did-doc <file>...] [--json]
//
// THE headline: verify a consent receipt OFFLINE-FIRST and print the honesty
// matrix — exactly what is PROVED vs merely trusted. The signature/assertion
// checks need the signing key from the issuer/citizen DID document: by default
// that is ONE HTTPS resolution, or pass --did-doc <file> (repeatable) to supply
// the DID document(s) locally for a fully AIR-GAPPED verify with no network at
// all. The IPFS disclosure copy (--ipfs) and the on-chain document-anchor check
// (--onchain, needs an RPC URL) are OPT-IN extra network calls.
//
//   overall "verified"     -> exit 0   (a company-attested receipt, fully sound)
//   overall "partial"      -> exit 0   (a citizen receipt offline — honest, not a failure)
//   overall "failed"       -> exit 6   (a check ACTIVELY did not verify — a tamper)
//   overall "unavailable"  -> exit 4   (a check could NOT complete — a DID could not
//                                       be resolved; INCONCLUSIVE, not a forgery)

import { readFile } from "node:fs/promises";
import { Agreely, type DidDocument, type ReceiptVerification, type VerifyReceiptOptions } from "@agreely/sdk";
import type { Context } from "../context.js";
import { EXIT, UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface VerifyFlags {
  onchain?: boolean;
  ipfs?: boolean;
  rpcUrl?: string;
  /** Local DID document file(s) — supply the signing key(s) for an air-gapped verify. */
  didDoc?: string[];
}

export async function verifyCommand(ctx: Context, path: string, flags: VerifyFlags): Promise<void> {
  let receipt: unknown;
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UsageError(`Could not read or parse the receipt file "${path}".`);
  }

  const opts: VerifyReceiptOptions = { verifyDisclosure: flags.ipfs === true };

  // --did-doc: resolve DIDs from local files ONLY (no network) — an air-gapped
  // verify. Each file is a DID document keyed by its `id`; an unknown DID
  // resolves to null, so the check reports "unavailable" rather than reaching out.
  if (flags.didDoc && flags.didDoc.length > 0) {
    const docs = await loadDidDocs(flags.didDoc);
    opts.resolver = (did: string): DidDocument | null => docs[did] ?? null;
  }

  if (flags.onchain) {
    const rpcUrl = flags.rpcUrl?.trim() || ctx.io.env.AGREELY_RPC_URL?.trim();
    if (!rpcUrl) {
      throw new UsageError("--onchain needs an RPC URL: pass --rpc-url <url> or set AGREELY_RPC_URL.");
    }
    opts.rpcUrl = rpcUrl;
  }

  const result: ReceiptVerification = await Agreely.verifyReceipt(receipt, opts);

  if (ctx.agent) {
    emitJson(ctx, result);
  } else {
    printMatrix(ctx, result);
  }

  // failed (a real tamper) -> 6; unavailable (a DID could not be resolved —
  // inconclusive, treated as an outage) -> 4; verified/partial -> 0.
  ctx.exit =
    result.overall === "failed"
      ? EXIT.VERIFY_FAILED
      : result.overall === "unavailable"
        ? EXIT.UNAVAILABLE
        : EXIT.OK;
}

/** Load DID document files and key them by their `id` for the local resolver. */
async function loadDidDocs(paths: string[]): Promise<Record<string, DidDocument>> {
  const docs: Record<string, DidDocument> = {};
  for (const p of paths) {
    let doc: DidDocument;
    try {
      doc = JSON.parse(await readFile(p, "utf8")) as DidDocument;
    } catch {
      throw new UsageError(`Could not read or parse the DID document file "${p}".`);
    }
    if (typeof doc.id !== "string" || doc.id === "") {
      throw new UsageError(`The DID document "${p}" has no "id" — it cannot be resolved by DID.`);
    }
    docs[doc.id] = doc;
  }
  return docs;
}

function printMatrix(ctx: Context, r: ReceiptVerification): void {
  const verdict =
    r.overall === "verified"
      ? pc.green("✓ VERIFIED")
      : r.overall === "partial"
        ? pc.yellow("~ PARTIAL")
        : r.overall === "unavailable"
          ? pc.yellow("? UNAVAILABLE")
          : pc.red("✗ FAILED");
  emitLine(ctx, `${verdict}  ${pc.dim(`(${r.receiptType})`)}`);
  emitLine(ctx, `  companySignature  ${statusLabel(r.companySignature)}`);
  emitLine(ctx, `  citizenAssertion  ${statusLabel(r.citizenAssertion)}`);
  emitLine(ctx, `  disclosureCopy    ${statusLabel(r.disclosureCopy)}`);
  emitLine(ctx, `  documentAnchor    ${statusLabel(r.documentAnchor)}`);
  emitLine(ctx, "");
  if (r.overall === "unavailable") {
    emitLine(
      ctx,
      `  ${pc.yellow("!")} UNVERIFIABLE: a DID could not be resolved, so verification could not complete. ` +
        "This is NOT a forgery — retry with connectivity, or pass --did-doc <file> to verify air-gapped.",
    );
    emitLine(ctx, "");
  }
  for (const note of r.notes) {
    emitLine(ctx, `  ${pc.dim("·")} ${note}`);
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "pass":
      return pc.green("pass");
    case "fail":
      return pc.red("fail");
    case "unavailable":
      return pc.yellow("unavailable");
    case "unsupported":
      return pc.dim("unsupported");
    default:
      return pc.dim("skipped");
  }
}

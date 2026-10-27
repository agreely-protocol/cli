// agreely verify <bundle-or-receipt.json> [--onchain] [--ipfs] [--rpc-url <url>]
//                                        [--did-doc <file>...] [--json]
//
// THE headline: verify a consent OFFLINE-FIRST and print the honesty matrix,
// exactly what is PROVED vs merely trusted. The file is the verification bundle a
// passkey consent issues (receipt, signedOffer, merkleRoot) or a receipt. The
// signature/assertion checks need the signing key from the issuer/citizen DID
// document: by default that is ONE HTTPS resolution, or pass --did-doc <file>
// (repeatable) to supply the DID document(s) locally for a fully AIR-GAPPED verify.
// The bundle's own didDocuments are never trusted. The IPFS disclosure copy (--ipfs)
// and the on-chain anchors (--onchain, needs an RPC URL) are OPT-IN network calls.
//
//   "verified"                       -> exit 0   (a passkey bundle or a paper receipt, sound)
//   "partial" on a telephone receipt -> exit 0   (the organisation's signed word, sound)
//   "incomplete"                     -> exit 11  (a bare passkey receipt: verify its bundle)
//   "failed"                         -> exit 6   (a check ACTIVELY did not verify: a tamper)
//   "malformed"                      -> exit 6   (not a file Agreely issued: unreadable, never a tamper)
//   "unavailable"                    -> exit 4   (a check could NOT complete: inconclusive)
//   "withdrawn"                      -> exit 12  (authentic, and the chain records its withdrawal: --onchain)
//   a --onchain or --ipfs check that could not complete turns a 0 into 4: what was
//   asked for was not proved.
//
// --did-doc documents are TRUSTED AS GIVEN: they supply the signing keys. Take them from
// the issuer and citizen, never out of the file under test.

import { readFile } from "node:fs/promises";
import { Agreely, type DidDocument, type ReceiptVerification, type VerifyReceiptOptions } from "@agreely/sdk";
import type { Context } from "../context.js";
import { EXIT, UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface VerifyFlags {
  onchain?: boolean;
  ipfs?: boolean;
  rpcUrl?: string;
  /** Local DID document file(s): supply the signing key(s) for an air-gapped verify. */
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

  // --did-doc: resolve DIDs from local files ONLY (no network), an air-gapped
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
    printMatrix(ctx, result, flags);
  }

  ctx.exit = exitFor(result, flags);
}

/**
 * 0 only for what the SDK proved, including every opt-in check the caller asked for. An overall this
 * CLI does not know is never read as a success.
 */
export function exitFor(r: ReceiptVerification, asked: Pick<VerifyFlags, "onchain" | "ipfs"> = {}): number {
  const code = exitForOverall(r);
  return code === EXIT.OK && askedCheckUnavailable(r, asked) ? EXIT.UNAVAILABLE : code;
}

function askedCheckUnavailable(r: ReceiptVerification, asked: Pick<VerifyFlags, "onchain" | "ipfs">): boolean {
  const onchain = asked.onchain === true && (r.documentAnchor === "unavailable" || r.consentAnchor === "unavailable");
  return onchain || (asked.ipfs === true && r.disclosureCopy === "unavailable");
}

function exitForOverall(r: ReceiptVerification): number {
  switch (r.overall) {
    case "verified":
      return EXIT.OK;
    case "partial":
      return r.receiptType === "company_documented" ? EXIT.OK : EXIT.ERROR;
    case "incomplete":
      return EXIT.VERIFY_INCOMPLETE;
    case "failed":
    case "malformed":
      return EXIT.VERIFY_FAILED;
    case "unavailable":
      return EXIT.UNAVAILABLE;
    case "withdrawn":
      return EXIT.WITHDRAWN;
    default:
      return EXIT.ERROR;
  }
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
      throw new UsageError(`The DID document "${p}" has no "id": it cannot be resolved by DID.`);
    }
    docs[doc.id] = doc;
  }
  return docs;
}

function printMatrix(ctx: Context, r: ReceiptVerification, asked: Pick<VerifyFlags, "onchain" | "ipfs">): void {
  const verdict =
    r.overall === "verified"
      ? pc.green("✓ VERIFIED")
      : r.overall === "partial"
        ? pc.yellow("~ PARTIAL")
        : r.overall === "incomplete"
          ? pc.yellow("~ INCOMPLETE")
          : r.overall === "unavailable"
            ? pc.yellow("? UNAVAILABLE")
            : r.overall === "withdrawn"
              ? pc.yellow("~ WITHDRAWN")
              : r.overall === "malformed"
                ? pc.red("✗ MALFORMED")
                : pc.red("✗ FAILED");
  emitLine(ctx, `${verdict}  ${pc.dim(`(${r.receiptType}, read as a ${r.input})`)}`);
  emitLine(ctx, `  companySignature  ${statusLabel(r.companySignature)}`);
  emitLine(ctx, `  receiptIntegrity  ${statusLabel(r.receiptIntegrity)}`);
  emitLine(ctx, `  citizenAssertion  ${statusLabel(r.citizenAssertion)}`);
  emitLine(ctx, `  disclosureCopy    ${statusLabel(r.disclosureCopy)}`);
  emitLine(ctx, `  documentAnchor    ${statusLabel(r.documentAnchor)}`);
  emitLine(ctx, `  consentAnchor     ${statusLabel(r.consentAnchor)}`);
  emitLine(ctx, `  cellLabelBinding  ${statusLabel(r.cellLabelBinding)}`);
  emitLine(ctx, "");
  if (r.overall === "incomplete") {
    emitLine(
      ctx,
      `  ${pc.yellow("!")} INCOMPLETE: verify the bundle. A passkey receipt proves nothing on its own: pass the ` +
        "verification bundle issued with it (the file that carries receipt, signedOffer and merkleRoot).",
    );
    emitLine(ctx, "");
  }
  if (r.overall === "unavailable") {
    const refused = registryRefused(r);
    if (refused) {
      emitLine(
        ctx,
        `  ${pc.yellow("!")} UNVERIFIABLE ON CHAIN: the bundle names an on-chain registry this verifier does not read ` +
          "(it reads only the Base mainnet registry), so nothing was read on chain and the consent is not shown as " +
          "verified. This is NOT a forgery, and retrying will not change it. Without --onchain, the signatures are " +
          "still checked offline.",
      );
    }
    if (!refused || [r.companySignature, r.receiptIntegrity, r.citizenAssertion, r.disclosureCopy].includes("unavailable")) {
      emitLine(
        ctx,
        `  ${pc.yellow("!")} UNVERIFIABLE: a check could not complete (a DID could not be resolved, or an RPC or ` +
          "gateway failed). This is NOT a forgery: retry with connectivity, or pass --did-doc <file> to verify air-gapped.",
      );
    }
    emitLine(ctx, "");
  }
  if (r.overall === "withdrawn") {
    emitLine(ctx, `  ${pc.yellow("!")} WITHDRAWN: ${withdrawalSentence(r)}`);
    emitLine(ctx, "");
  }
  if (r.overall === "malformed") {
    emitLine(
      ctx,
      `  ${pc.red("!")} MALFORMED: this file is not a verification bundle or receipt this verifier can read, so no ` +
        "check ran. It is NOT evidence of a tamper: ask the issuer for the file Agreely issued.",
    );
    emitLine(ctx, "");
  }
  if (exitForOverall(r) === EXIT.OK && askedCheckUnavailable(r, asked)) {
    emitLine(
      ctx,
      consentStillPending(r, asked)
        ? `  ${pc.yellow("!")} A CHECK YOU ASKED FOR could not complete (--onchain): the chain was read and does not carry ` +
          "this consent's anchor yet. Anchoring follows issuance by a few minutes, so this exits 4: retry later."
        : `  ${pc.yellow("!")} A CHECK YOU ASKED FOR could not complete (--onchain or --ipfs): it was not proved, so ` +
          "this exits 4. Retry with connectivity.",
    );
    emitLine(ctx, "");
  }
  for (const note of r.notes) {
    emitLine(ctx, `  ${pc.dim("·")} ${note}`);
  }
}

function registryRefused(r: ReceiptVerification): boolean {
  return r.registryRefused === true;
}

/**
 * The consent's cells were read and none is anchored yet (no unreadable cell), and no other check the operator asked
 * for is unavailable: the chain answered, the anchor is simply not there yet.
 */
function consentStillPending(r: ReceiptVerification, asked: Pick<VerifyFlags, "onchain" | "ipfs">): boolean {
  const counts = r.consentAnchorCounts;
  if (r.consentAnchor !== "unavailable" || !counts || counts.pending === 0 || counts.unreadable !== 0) return false;
  const otherAskedUnavailable =
    (asked.onchain === true && r.documentAnchor === "unavailable") || (asked.ipfs === true && r.disclosureCopy === "unavailable");
  return !otherAskedUnavailable;
}

/** The web verifier's English for a withdrawal, from the records the SDK read under the bundle's root. */
function withdrawalSentence(r: ReceiptVerification): string {
  const records = r.consentAnchorRecords ?? [];
  const withdrawn = records.filter((rec) => rec.state === "withdrawn");
  const latest = Math.max(0, ...withdrawn.map((rec) => rec.revokedAt));
  const date = latest > 0 ? new Date(latest * 1000).toISOString().replace(".000Z", "Z") : "";
  const authentic = "The receipt itself is still cryptographically authentic (it proves consent was given)";
  const k = withdrawn.length;
  const m = records.length;
  // Cells not anchored yet or unreadable are not withdrawn and not active: say so, in the web verifier's readable words.
  const counts = r.consentAnchorCounts;
  const unseen = (counts?.pending ?? 0) + (counts?.unreadable ?? 0);
  if (unseen > 0 && k > 0) {
    if (k === m && date) {
      return `The purposes that could be read from the chain were withdrawn (latest withdrawal on ${date}). ${authentic}.`;
    }
    const total = counts?.cells ?? m;
    const head = k === 1 ? `${String(k)} of ${String(total)} purposes has been withdrawn on-chain.` : `${String(k)} of ${String(total)} purposes have been withdrawn on-chain.`;
    return `${head}${date ? ` Most recent withdrawal on-chain on ${date}.` : ""} ${authentic}.`;
  }
  if (k === 0 || k === m) {
    return `This consent was withdrawn${date ? ` on ${date}` : ""}. ${authentic}, but the chain shows it has since been withdrawn.`;
  }
  const rest = m - k === 1 ? "the other remains active per the chain" : "the rest remain active per the chain";
  const when = date ? ` Most recent withdrawal on-chain on ${date}.` : "";
  return `${String(k)} of ${String(m)} purposes ${k === 1 ? "has" : "have"} been withdrawn; ${rest}.${when} ${authentic}.`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "pass":
      return pc.green("pass");
    case "fail":
      return pc.red("fail");
    case "unavailable":
      return pc.yellow("unavailable");
    case "unbound":
      return pc.yellow("unbound");
    case "unsupported":
      return pc.dim("unsupported");
    case "withdrawn":
      return pc.yellow("withdrawn");
    default:
      return pc.dim("skipped");
  }
}

// agreely verify <receipt.json> [--onchain] [--ipfs] [--rpc-url <url>] [--json]
//
// THE headline: verify a consent receipt OFFLINE and print the honesty matrix —
// exactly what is PROVED vs merely trusted. DID documents are resolved over the
// network (needed to fetch the signing keys); the IPFS disclosure-copy check
// (--ipfs) and the on-chain document-anchor check (--onchain, needs an RPC URL)
// are OPT-IN extra network calls.
//
//   overall "verified"  -> exit 0   (a company-attested receipt, fully sound)
//   overall "partial"   -> exit 0   (a citizen receipt offline — honest, not a failure)
//   overall "failed"    -> exit 6   (something did not verify)

import { readFile } from "node:fs/promises";
import { Agreely, type ReceiptVerification, type VerifyReceiptOptions } from "@agreely/sdk";
import type { Context } from "../context.js";
import { EXIT, UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface VerifyFlags {
  onchain?: boolean;
  ipfs?: boolean;
  rpcUrl?: string;
}

export async function verifyCommand(ctx: Context, path: string, flags: VerifyFlags): Promise<void> {
  let receipt: unknown;
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UsageError(`Could not read or parse the receipt file "${path}".`);
  }

  const opts: VerifyReceiptOptions = { verifyDisclosure: flags.ipfs === true };
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

  ctx.exit = result.overall === "failed" ? EXIT.VERIFY_FAILED : EXIT.OK;
}

function printMatrix(ctx: Context, r: ReceiptVerification): void {
  const verdict =
    r.overall === "verified"
      ? pc.green("✓ VERIFIED")
      : r.overall === "partial"
        ? pc.yellow("~ PARTIAL")
        : pc.red("✗ FAILED");
  emitLine(ctx, `${verdict}  ${pc.dim(`(${r.receiptType})`)}`);
  emitLine(ctx, `  companySignature  ${statusLabel(r.companySignature)}`);
  emitLine(ctx, `  citizenAssertion  ${statusLabel(r.citizenAssertion)}`);
  emitLine(ctx, `  disclosureCopy    ${statusLabel(r.disclosureCopy)}`);
  emitLine(ctx, `  documentAnchor    ${statusLabel(r.documentAnchor)}`);
  emitLine(ctx, "");
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
    case "unsupported":
      return pc.dim("unsupported");
    default:
      return pc.dim("skipped");
  }
}

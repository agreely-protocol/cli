// agreely consent-sheet create <customerRef> --document-version <id> --out <file.pdf>
//                              [--locale <fr|en>] [--idempotency-key <k>] [--force]
//
// Mints the signature sheet of one published version for one customer (scope: 'attest'),
// with a NEW claim. The PDF is written to --out and NEVER to stdout. The printed
// reference and the claim are returned ONCE and stored nowhere: this command prints them
// and cannot recover them later. A repeated Idempotency-Key is a 409 already_minted.
//
// TWO RULES, printed every time:
//   - never send the claim link in the same envelope as the sheet;
//   - never send the blank sheet's hash as evidence.pdfSha256 (the evidence is the SIGNED paper).

import type { ConsentSheet } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { assertWritable, need, oneOf, opt, writeBytes } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

export const SHEET_RULES = [
  "Never send the claim link in the same envelope as the sheet: the printed reference is its second factor.",
  "Never send the blank sheet's hash as evidence.pdfSha256: the evidence is the signed paper once it comes back.",
] as const;

export interface ConsentSheetCreateFlags {
  documentVersion?: string;
  out?: string;
  locale?: string;
  idempotencyKey?: string;
  force?: boolean;
}

export async function consentSheetCreateCommand(
  ctx: Context,
  customerRef: string,
  flags: ConsentSheetCreateFlags,
): Promise<void> {
  const ref = need(customerRef, "<customerRef>");
  const documentVersionId = need(flags.documentVersion, "--document-version <id>");
  const out = need(flags.out, "--out <file.pdf>");
  const locale = oneOf(opt(flags.locale) ?? "fr", ["fr", "en"] as const, "--locale");
  const key = opt(flags.idempotencyKey);
  if (out === "-") throw new UsageError("--out must be a file path: the PDF is never written to stdout.");
  await assertWritable(out, flags.force === true);

  const { client } = await buildClient(ctx);
  const sheet: ConsentSheet = await client.manualConsents.createConsentSheet(
    ref,
    { documentVersionId, locale },
    key !== undefined ? { idempotencyKey: key } : {},
  );

  const bytes = Buffer.from(sheet.signatureSheet.pdf, "base64");
  await writeBytes(out, bytes);

  if (ctx.agent) {
    emitJson(ctx, {
      customerRef: ref,
      documentVersionId: sheet.signatureSheet.documentVersionId,
      locale: sheet.signatureSheet.locale,
      file: out,
      bytes: bytes.length,
      printedReference: sheet.printedReference,
      claim: sheet.claim,
      rules: [...SHEET_RULES],
    });
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Consent sheet written to ${pc.bold(out)} ${pc.dim(`(${bytes.length} bytes)`)}`);
  emitLine(ctx, `  ${pc.bold("printedReference")}  ${sheet.printedReference}  ${pc.dim("(printed on the sheet)")}`);
  emitLine(ctx, "");
  emitLine(ctx, `${pc.bold("Claim link")} ${pc.dim("(shown once, keep it apart from the sheet)")}`);
  emitLine(ctx, `  ${pc.bold("claimUrl")}   ${sheet.claim.claimUrl}`);
  emitLine(ctx, `  ${pc.bold("token")}      ${sheet.claim.token}`);
  emitLine(ctx, `  ${pc.bold("expiresAt")}  ${sheet.claim.expiresAt}`);
  emitLine(ctx, "");
  for (const rule of SHEET_RULES) emitLine(ctx, pc.yellow(`  ! ${rule}`));
}

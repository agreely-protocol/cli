// agreely manual-consent: record a manual / offline (company-attested) consent,
// mint a claim link, or revoke one. Mirrors the request commands' agent-vs-human
// conventions: agent mode (--json or non-TTY) emits PURE JSON and never prompts.
//
//   create   --customer <id> --document-version <id>
//            --effective-date <YYYY-MM-DD> --valid-until <YYYY-MM-DD>
//            --item <id|cat:purpose> [--item ...] --pdf <path> [--upload] [--json]
//   claim-link --customer <id> [--reference <ref>] [--json]
//   revoke   <consentRef> --reason <text> [--json]
//
// The PDF is hashed LOCALLY (node crypto): only the "0x"+sha256 commitment is sent
// by default. The bytes leave the machine ONLY when --upload is passed. That local
// minimization is the whole point of the offline path.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ClaimLink,
  IssueItem,
  ManualConsentErasure,
  ManualConsentResult,
  ManualConsentRevocation,
  RecordManualConsentInput,
} from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { parseItem } from "../create-input.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONSENT_REF_RE = /^0x[0-9a-f]+$/i;

export interface ManualConsentCreateFlags {
  customer?: string;
  documentVersion?: string;
  effectiveDate?: string;
  validUntil?: string;
  item?: string[];
  pdf?: string;
  upload?: boolean;
}

export async function manualConsentCreateCommand(
  ctx: Context,
  flags: ManualConsentCreateFlags,
): Promise<void> {
  const { client } = await buildClient(ctx);
  const input = await buildRecordInput(flags);

  const recorded: ManualConsentResult = await client.manualConsents.record(input);

  if (ctx.agent) {
    emitJson(ctx, recorded);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Manual consent recorded`);
  emitLine(ctx, `  ${pc.bold("consentId")}   ${recorded.consentId}`);
  emitLine(ctx, `  ${pc.bold("merkleRoot")}  ${recorded.merkleRoot}`);
  emitLine(ctx, `  ${pc.bold("assurance")}   ${recorded.assurance}`);
  emitLine(ctx, `  ${pc.bold("anchored")}    ${recorded.anchored ? "yes" : "not yet"}`);
  for (const ref of recorded.consentRefs) {
    emitLine(ctx, `    · ${pc.cyan(ref)}`);
  }
}

/** Build (and validate) the SDK record input, hashing the PDF locally. Throws UsageError. */
async function buildRecordInput(flags: ManualConsentCreateFlags): Promise<RecordManualConsentInput> {
  const customerId = flags.customer?.trim();
  if (!customerId) throw new UsageError("--customer <id> is required.");

  const documentVersionId = flags.documentVersion?.trim();
  if (!documentVersionId) throw new UsageError("--document-version <id> is required.");

  const effectiveDate = flags.effectiveDate?.trim();
  if (!effectiveDate) throw new UsageError("--effective-date <YYYY-MM-DD> is required.");
  if (!DATE_RE.test(effectiveDate)) {
    throw new UsageError(`--effective-date "${effectiveDate}" must be YYYY-MM-DD.`);
  }

  const validUntil = flags.validUntil?.trim();
  if (!validUntil) throw new UsageError("--valid-until <YYYY-MM-DD> is required.");
  if (!DATE_RE.test(validUntil)) throw new UsageError(`--valid-until "${validUntil}" must be YYYY-MM-DD.`);

  const rawItems = flags.item ?? [];
  if (rawItems.length === 0) {
    throw new UsageError("At least one --item <catalogId|category:purpose> is required.");
  }
  const items: IssueItem[] = rawItems.map(parseItem);

  const pdfPath = flags.pdf?.trim();
  if (!pdfPath) throw new UsageError("--pdf <path> is required (its SHA-256 is computed locally).");

  let bytes: Buffer;
  try {
    bytes = await readFile(pdfPath);
  } catch {
    throw new UsageError(`Could not read --pdf "${pdfPath}".`);
  }
  const pdfSha256 = "0x" + createHash("sha256").update(bytes).digest("hex");

  return {
    customerId,
    documentVersionId,
    effectiveDate,
    validUntil,
    items,
    evidence: {
      pdfSha256,
      // The bytes leave the machine ONLY on an explicit --upload.
      ...(flags.upload ? { pdf: bytes.toString("base64") } : {}),
    },
  };
}

export interface ManualConsentClaimLinkFlags {
  customer?: string;
  reference?: string;
}

export async function manualConsentClaimLinkCommand(
  ctx: Context,
  flags: ManualConsentClaimLinkFlags,
): Promise<void> {
  const customerId = flags.customer?.trim();
  if (!customerId) throw new UsageError("--customer <id> is required.");

  const { client } = await buildClient(ctx);
  const link: ClaimLink = await client.manualConsents.createClaimLink({
    customerId,
    ...(flags.reference?.trim() ? { reference: flags.reference.trim() } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, link);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Claim link minted (hand it to the subject)`);
  emitLine(ctx, `  ${pc.bold("claimUrl")}   ${link.claimUrl}`);
  emitLine(ctx, `  ${pc.bold("token")}      ${link.token}`);
  emitLine(ctx, `  ${pc.bold("expiresAt")}  ${link.expiresAt}`);
}

export interface ManualConsentRevokeFlags {
  reason?: string;
}

export async function manualConsentRevokeCommand(
  ctx: Context,
  consentRef: string,
  flags: ManualConsentRevokeFlags,
): Promise<void> {
  if (!CONSENT_REF_RE.test(consentRef)) {
    throw new UsageError(`"${consentRef}" is not a valid consentRef (expected 0x + hex).`);
  }

  const { client } = await buildClient(ctx);
  const result: ManualConsentRevocation = await client.manualConsents.revoke(consentRef, {
    ...(flags.reason?.trim() ? { reason: flags.reason.trim() } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  const tag = result.alreadyRevoked ? pc.dim("(already revoked)") : "";
  emitLine(ctx, `${pc.green("✓")} Revoked ${pc.bold(result.consentRef)} ${tag}`);
}

export interface ManualConsentEraseFlags {
  reason?: string;
}

export async function manualConsentEraseCommand(
  ctx: Context,
  consentRef: string,
  flags: ManualConsentEraseFlags,
): Promise<void> {
  if (!CONSENT_REF_RE.test(consentRef)) {
    throw new UsageError(`"${consentRef}" is not a valid consentRef (expected 0x + hex).`);
  }

  const { client } = await buildClient(ctx);
  const result: ManualConsentErasure = await client.manualConsents.erase(consentRef, {
    ...(flags.reason?.trim() ? { reason: flags.reason.trim() } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  const tag = result.alreadyErased ? pc.dim("(already erased)") : "";
  emitLine(ctx, `${pc.green("✓")} Erased ${pc.bold(result.consentRef)} ${tag}`);
}

// agreely manual-consent: record a manual / offline (company-attested) consent,
// mint a claim link, or revoke one. Mirrors the request commands' agent-vs-human
// conventions: agent mode (--json or non-TTY) emits PURE JSON and never prompts.
//
//   create   --customer <id> --document-version <id>
//            --effective-date <YYYY-MM-DD> --valid-until <YYYY-MM-DD>
//            [--item <id|cat:purpose> ...] --pdf <path> [--upload] [--json]
//   claim-link --customer <id> [--reference <ref>] [--json]
//   revoke   <consentRef> --reason <text> [--json]
//
// The PDF is hashed LOCALLY (node crypto): only the "0x"+sha256 commitment is sent
// by default. The bytes leave the machine ONLY when --upload is passed. That local
// minimization is the whole point of the offline path.
//
// --item names the consent asks TICKED on the sheet, and may be omitted entirely (a
// sheet that answered "no" to every ask). The server adds every line the document
// gives for information as an acknowledgement (never a consent) and ignores one named
// here; the response reports those lines in `acknowledged` and says `asksDeclined`
// when no ask was consented. A document that asks no consent (a collection notice) is
// refused by the server. An empty file is refused locally, and so is an uploaded file
// that is not a PDF, because the server refuses both.

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
import { readEvidence } from "../evidence.js";
import { assertDate, keyOrNew } from "../flags.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const CONSENT_REF_RE = /^0x[0-9a-f]+$/i;

export interface ManualConsentCreateFlags {
  customer?: string;
  documentVersion?: string;
  effectiveDate?: string;
  validUntil?: string;
  item?: string[];
  pdf?: string;
  upload?: boolean;
  sensitiveExpressAttested?: boolean;
  versionAttested?: boolean;
  idempotencyKey?: string;
}

export async function manualConsentCreateCommand(
  ctx: Context,
  flags: ManualConsentCreateFlags,
): Promise<void> {
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;
  const { client } = await buildClient(ctx, { write: true });
  const input = await buildRecordInput(flags);

  const recorded: ManualConsentResult = await client.manualConsents.record(input, { idempotencyKey: key });

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
  if (recorded.acknowledged.length > 0) {
    emitLine(ctx, `  ${pc.bold("acknowledged")} ${pc.dim("(information given, never a consent)")}`);
    for (const line of recorded.acknowledged) {
      emitLine(ctx, `    · ${String(line.category)} / ${String(line.purpose)}`);
    }
  }
  if (recorded.asksDeclined) {
    emitLine(ctx, pc.yellow("  Every consent ask was answered no: only the acknowledgement was recorded."));
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
  assertDate(effectiveDate, "--effective-date");

  const validUntil = flags.validUntil?.trim();
  if (!validUntil) throw new UsageError("--valid-until <YYYY-MM-DD> is required.");
  assertDate(validUntil, "--valid-until");

  // May be empty: a sheet that answered "no" to every consent ask.
  const items: IssueItem[] = (flags.item ?? []).map(parseItem);

  const evidence = await readEvidence(flags.pdf, flags.upload === true);

  return {
    customerId,
    documentVersionId,
    effectiveDate,
    validUntil,
    items,
    evidence,
    ...(flags.sensitiveExpressAttested ? { sensitiveExpressAttested: true } : {}),
    ...(flags.versionAttested ? { versionAttested: true } : {}),
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

  const { client } = await buildClient(ctx, { write: true });
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

  const { client } = await buildClient(ctx, { write: true });
  const result: ManualConsentRevocation = await client.manualConsents.revoke(consentRef, {
    ...(flags.reason?.trim() ? { reason: flags.reason.trim() } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  const tag = result.alreadyRevoked ? pc.dim("(already revoked)") : "";
  emitLine(ctx, `${pc.green("✓")} Revoked ${pc.bold(result.consentRef)} ${tag}`);
  // `gate` says what check answers NOW for that purpose: "denied" (this consent backed
  // it), "superseded" (a later consent had already taken it over and is untouched) or
  // "unchanged" (an idempotent repeat).
  emitLine(ctx, `  ${pc.bold("gate")}  ${result.gate}`);
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

  const { client } = await buildClient(ctx, { write: true });
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

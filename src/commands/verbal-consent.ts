// agreely verbal-consent: a consent the person gave BY TELEPHONE, documented by the
// organisation. The weakest of three tiers (assurance company_documented, tier verbal).
//
//   record <--customer> <--document-version> --answer <category:purpose=yes|no> ...
//          --obtained-at <instant> --obtained-by <staff> --script-version <label>
//          --consented-by <self|self_with_assistant|representative>
//          [--capacity <c>] [--respondent-name <n>] --valid-until <date|instant>
//          [--sensitive-express-attested] [--minor] [--paper-expected] [--idempotency-key <k>]
//   show   <consentId>
//   paper  <consentId> --signed-at <instant> --answer ... --pdf <path> [--upload]
//
// Scopes: record needs attest_verbal, paper needs attest, show accepts either. Each
// answer is the person's own "yes" or "no", given explicitly. Instants are RFC 3339 WITH
// an offset and --valid-until is a plain date or such an instant, all checked before any
// call. A category that itself contains ":" cannot be written as --answer. An
// Idempotency-Key is generated when none is given and printed if the call times out.

import type {
  ConfirmVerbalPaperInput,
  RecordVerbalConsentInput,
  VerbalAnswer,
  VerbalConsentHistory,
  VerbalConsentResult,
  VerbalPaperResult,
  RepresentativeCapacity,
  VerbalRespondent,
} from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { readEvidence } from "../evidence.js";
import {
  assertDateOrInstant,
  assertInstant,
  keyOrNew,
  need,
  rawRef,
  oneOf,
  opt,
  splitPair,
} from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

const CONSENTED_BY = ["self", "self_with_assistant", "representative"] as const;
const CAPACITIES = [
  "tutelle",
  "mandat_protection_homologue",
  "representation_temporaire",
  "curatelle",
  "other",
  "undeclared",
  "titulaire_autorite_parentale",
  "tuteur_mineur",
] as const satisfies readonly RepresentativeCapacity[];

/** Parse one --answer "category:purpose=yes|no" (the answer after the last "=", then the shared category:purpose split). */
export function parseAnswer(raw: string): VerbalAnswer {
  const eq = raw.lastIndexOf("=");
  const pair = eq === -1 ? undefined : splitPair(raw.slice(0, eq));
  if (eq === -1 || pair === undefined) {
    throw new UsageError(`Invalid --answer "${raw}". Use "category:purpose=yes" or "category:purpose=no".`);
  }
  const { category, purpose } = pair;
  const answer = raw.slice(eq + 1).trim().toLowerCase();
  if (answer !== "yes" && answer !== "no") {
    throw new UsageError(`Invalid --answer "${raw}": the answer must be exactly yes or no.`);
  }
  return { category, purpose, answer };
}

export interface VerbalRecordFlags {
  customer?: string;
  documentVersion?: string;
  answer?: string[];
  obtainedAt?: string;
  obtainedBy?: string;
  scriptVersion?: string;
  consentedBy?: string;
  capacity?: string;
  respondentName?: string;
  validUntil?: string;
  sensitiveExpressAttested?: boolean;
  minor?: boolean;
  paperExpected?: boolean;
  idempotencyKey?: string;
}

export async function verbalConsentRecordCommand(ctx: Context, flags: VerbalRecordFlags): Promise<void> {
  const customerId = rawRef(flags.customer, "--customer <id>");
  const documentVersionId = need(flags.documentVersion, "--document-version <id>");
  const obtainedAt = assertInstant(need(flags.obtainedAt, "--obtained-at <instant>"), "--obtained-at");
  const obtainedBy = need(flags.obtainedBy, "--obtained-by <staff>");
  const scriptVersion = need(flags.scriptVersion, "--script-version <label>");
  const validUntil = assertDateOrInstant(need(flags.validUntil, "--valid-until <date|instant>"), "--valid-until");
  const consentedBy = oneOf(need(flags.consentedBy, "--consented-by"), CONSENTED_BY, "--consented-by");
  const answers = (flags.answer ?? []).map(parseAnswer);
  if (answers.length === 0) {
    throw new UsageError('At least one --answer "category:purpose=yes|no" is required.');
  }

  const capacityFlag = opt(flags.capacity);
  const capacity = capacityFlag !== undefined ? oneOf(capacityFlag, CAPACITIES, "--capacity") : undefined;
  if (consentedBy === "representative" && capacity === undefined) {
    throw new UsageError("--capacity is required when --consented-by is representative.");
  }
  if (consentedBy !== "representative" && capacity !== undefined) {
    throw new UsageError("--capacity applies to a representative only.");
  }
  const name = opt(flags.respondentName);
  const respondent: VerbalRespondent = {
    consentedBy,
    ...(capacity !== undefined ? { representativeCapacity: capacity } : {}),
    ...(name !== undefined ? { name } : {}),
  };

  const input: RecordVerbalConsentInput = {
    customerId,
    documentVersionId,
    answers,
    obtainedAt,
    obtainedBy,
    scriptVersion,
    respondent,
    validUntil,
    ...(flags.sensitiveExpressAttested ? { sensitiveExpressAttested: true } : {}),
    ...(flags.minor ? { isMinor: true } : {}),
    ...(flags.paperExpected ? { paperExpected: true } : {}),
  };
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;

  const { client } = await buildClient(ctx, { write: true });
  const recorded: VerbalConsentResult = await client.verbalConsents.record(input, { idempotencyKey: key });

  if (ctx.agent) {
    emitJson(ctx, recorded);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Verbal consent recorded`);
  emitLine(ctx, `  ${pc.bold("consentId")}      ${recorded.consentId}`);
  emitLine(ctx, `  ${pc.bold("tier")}           ${recorded.tier} (${recorded.assurance})`);
  emitLine(ctx, `  ${pc.bold("merkleRoot")}     ${recorded.merkleRoot}`);
  emitLine(ctx, `  ${pc.bold("anchored")}       ${recorded.anchored ? "yes" : "not yet"}`);
  emitLine(ctx, `  ${pc.bold("paperExpected")}  ${recorded.paperExpected ? "yes" : "no"}`);
  for (const ref of recorded.consentRefs) emitLine(ctx, `    · ${pc.cyan(ref)}`);
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

export async function verbalConsentShowCommand(ctx: Context, consentId: string): Promise<void> {
  const id = need(consentId, "<consentId>");
  const { client } = await buildClient(ctx);
  const h: VerbalConsentHistory = await client.verbalConsents.get(id);

  if (ctx.agent) {
    emitJson(ctx, h);
    return;
  }
  emitLine(ctx, `${pc.bold("Verbal consent")} ${h.consentId}  ${pc.dim(`(${h.state})`)}`);
  emitLine(ctx, `  tier         ${h.tier} (${h.assurance})`);
  emitLine(ctx, `  obtainedAt   ${h.obtainedAt}  ${pc.dim(`recorded ${h.recordedAt}`)}`);
  emitLine(ctx, `  validUntil   ${h.validUntil}`);
  emitLine(ctx, `  anchored     ${h.anchored ? "yes" : "not yet"}`);
  for (const p of h.purposes) {
    const status = p.status !== null ? ` ${p.status}` : "";
    const paper = p.paper !== null ? ` ${p.paper}` : "";
    emitLine(ctx, `    · ${String(p.category)} / ${String(p.purpose)}  ${p.answer}${status}${paper}`);
  }
  if (h.paper !== null) {
    emitLine(ctx, `  paper        signed ${h.paper.signedAt}, sha256 ${h.paper.pdfSha256}`);
  }
}

export interface VerbalPaperFlags {
  signedAt?: string;
  answer?: string[];
  pdf?: string;
  upload?: boolean;
  idempotencyKey?: string;
}

export async function verbalConsentPaperCommand(
  ctx: Context,
  consentId: string,
  flags: VerbalPaperFlags,
): Promise<void> {
  const id = need(consentId, "<consentId>");
  const signedAt = assertInstant(need(flags.signedAt, "--signed-at <instant>"), "--signed-at");
  const answers = (flags.answer ?? []).map(parseAnswer);
  if (answers.length === 0) {
    throw new UsageError('At least one --answer "category:purpose=yes|no" is required (each purpose still consented by telephone).');
  }
  const evidence = await readEvidence(flags.pdf, flags.upload === true);
  const input: ConfirmVerbalPaperInput = { signedAt, answers, evidence };
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;

  const { client } = await buildClient(ctx, { write: true });
  const result: VerbalPaperResult = await client.verbalConsents.confirmWithPaper(id, input, { idempotencyKey: key });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Paper recorded for verbal consent ${pc.bold(result.verbalConsentId)}`);
  emitLine(ctx, `  manualConsentId  ${result.manualConsentId ?? "none (every box came back unticked)"}`);
  for (const c of result.confirmed) emitLine(ctx, `    ${pc.green("confirmed")} ${c.category} / ${c.purpose}  ${pc.cyan(c.consentRef)}`);
  for (const w of result.withdrawn) emitLine(ctx, `    ${pc.yellow("withdrawn")} ${w.category} / ${w.purpose}  ${pc.cyan(w.consentRef)}`);
}

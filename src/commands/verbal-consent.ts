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
// answer is the person's own "yes" or "no", given explicitly. Dates and instants are
// passed through to the SDK, which validates them (RFC 3339 WITH an offset).

import type {
  ConfirmVerbalPaperInput,
  RecordVerbalConsentInput,
  VerbalAnswer,
  VerbalConsentHistory,
  VerbalConsentResult,
  VerbalPaperResult,
  VerbalRespondent,
} from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { readEvidence } from "../evidence.js";
import { need, oneOf, opt } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

const CONSENTED_BY = ["self", "self_with_assistant", "representative"] as const;

/** Parse one --answer "category:purpose=yes|no" (category/purpose split on the first colon, answer on the last "="). */
export function parseAnswer(raw: string): VerbalAnswer {
  const eq = raw.lastIndexOf("=");
  const colon = raw.indexOf(":");
  if (eq === -1 || colon === -1 || colon > eq) {
    throw new UsageError(`Invalid --answer "${raw}". Use "category:purpose=yes" or "category:purpose=no".`);
  }
  const category = raw.slice(0, colon).trim();
  const purpose = raw.slice(colon + 1, eq).trim();
  const answer = raw.slice(eq + 1).trim().toLowerCase();
  if (category === "" || purpose === "") {
    throw new UsageError(`Invalid --answer "${raw}". Use "category:purpose=yes" or "category:purpose=no".`);
  }
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
  const customerId = need(flags.customer, "--customer <id>");
  const documentVersionId = need(flags.documentVersion, "--document-version <id>");
  const obtainedAt = need(flags.obtainedAt, "--obtained-at <instant>");
  const obtainedBy = need(flags.obtainedBy, "--obtained-by <staff>");
  const scriptVersion = need(flags.scriptVersion, "--script-version <label>");
  const validUntil = need(flags.validUntil, "--valid-until <date|instant>");
  const consentedBy = oneOf(need(flags.consentedBy, "--consented-by"), CONSENTED_BY, "--consented-by");
  const answers = (flags.answer ?? []).map(parseAnswer);
  if (answers.length === 0) {
    throw new UsageError('At least one --answer "category:purpose=yes|no" is required.');
  }

  const capacity = opt(flags.capacity);
  const name = opt(flags.respondentName);
  const respondent = {
    consentedBy,
    ...(capacity !== undefined ? { representativeCapacity: capacity } : {}),
    ...(name !== undefined ? { name } : {}),
  } as VerbalRespondent;

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
  const key = opt(flags.idempotencyKey);

  const { client } = await buildClient(ctx);
  const recorded: VerbalConsentResult = await client.verbalConsents.record(
    input,
    key !== undefined ? { idempotencyKey: key } : {},
  );

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
  const signedAt = need(flags.signedAt, "--signed-at <instant>");
  const answers = (flags.answer ?? []).map(parseAnswer);
  if (answers.length === 0) {
    throw new UsageError('At least one --answer "category:purpose=yes|no" is required (each purpose still consented by telephone).');
  }
  const evidence = await readEvidence(flags.pdf, flags.upload === true);
  const input: ConfirmVerbalPaperInput = { signedAt, answers, evidence };
  const key = opt(flags.idempotencyKey);

  const { client } = await buildClient(ctx);
  const result: VerbalPaperResult = await client.verbalConsents.confirmWithPaper(
    id,
    input,
    key !== undefined ? { idempotencyKey: key } : {},
  );

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Paper recorded for verbal consent ${pc.bold(result.verbalConsentId)}`);
  emitLine(ctx, `  manualConsentId  ${result.manualConsentId ?? "none (every box came back unticked)"}`);
  for (const c of result.confirmed) emitLine(ctx, `    ${pc.green("confirmed")} ${c.category} / ${c.purpose}  ${pc.cyan(c.consentRef)}`);
  for (const w of result.withdrawn) emitLine(ctx, `    ${pc.yellow("withdrawn")} ${w.category} / ${w.purpose}  ${pc.cyan(w.consentRef)}`);
}

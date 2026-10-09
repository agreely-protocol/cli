// agreely check [customerId] [category] [purpose] [--batch <file.json>] [--json]
//
// Single mode (no --batch): check one (customerId, category, purpose) cell.
//   ALLOW -> exit 0, DENY -> exit 10 (a clean negative, NOT an error).
// An outage throws AgreelyUnavailableError from the SDK -> the top-level mapper
// resolves it to exit 4 (distinct from deny), honouring the fail-closed default.
// A lapsed company subscription throws AgreelyBillingInactiveError (HTTP 402) ->
// exit 7 (distinct from both deny and outage): fail-closed, but actionable.
//
// Batch mode (--batch <file>): read a JSON array of {customerRef, category, purpose},
//   call checkBatch() once, and print a decisions table (human) or JSON array (agent).
//   Exit 0 when ALL allow; exit 10 when ANY deny.
//
// category/purpose are sent RAW (the server normalizes). They may be given in French OR
// English, with or without accents, matched case- and whitespace-insensitively; English
// resolves only when the company disclosed an English label, and ambiguous/undeclared
// labels fail closed.
//
// NECESSITY ALLOWS. An allow can carry status "necessity": there is NO signed consent
// record, and the allow rests on a non-consent lawful basis the company DECLARED on the
// catalog cell (contract / necessary_for_service / security_fraud / legal_obligation /
// professional_contact). Such an allow has no consentRef and no assurance, so without
// the basis it is indistinguishable from a consented allow to anything reading this
// output. We therefore ALWAYS surface `basis`, in both --json and human mode. Agreely
// records the declared basis; it does not certify its legal validity, and a necessity
// allow must never be reported as "consented".
//
// PROOF TIER. A record-backed decision carries `assurance` (citizen_signed |
// company_attested | company_documented) and `tier` (full | manual | verbal), the same
// proof under two names. The HOST decides what each tier may unlock (a telephone
// consent is tier "verbal", assurance "company_documented"), so both are passed through
// in --json and shown in human mode. An acknowledged informed line (information given,
// never a consent) answers like no record; once withdrawn it denies "revoked" with a
// consentRef and NO assurance or tier. Treat an unknown assurance or tier as NOT
// acceptable.
//
// BATCH SIZE. The server caps a batch at 500 cells. The SDK refuses an over-cap file
// before the wire call (AgreelyConfigError -> exit 2), so split large files yourself.
// The /v1 tier also allows 120 requests per minute per company; one --batch run is one
// request, which is the point of batch mode.

import { readFile } from "node:fs/promises";
import type { BatchCheckItem, BatchDecision, CheckResult } from "@agreely/sdk";
import { AgreelyValidationError } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { EXIT } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function checkCommand(
  ctx: Context,
  customerId: string | undefined,
  category: string | undefined,
  purpose: string | undefined,
  batchFile?: string,
): Promise<void> {
  if (batchFile !== undefined) {
    await batchMode(ctx, batchFile);
  } else {
    await singleMode(ctx, customerId, category, purpose);
  }
}

async function singleMode(
  ctx: Context,
  customerId: string | undefined,
  category: string | undefined,
  purpose: string | undefined,
): Promise<void> {
  if (!customerId || !category || !purpose) {
    throw new AgreelyValidationError(
      "Provide <customerId> <category> <purpose> or use --batch <file.json>.",
      { code: "invalid_request", status: 422 },
    );
  }
  const { client } = await buildClient(ctx, { check: true });
  const result: CheckResult = await client.checkDetailed(customerId, category, purpose);
  const allowed = result.decision === "allow";

  const basis = declaredBasis(result);
  const proof = proofOf(result);

  if (ctx.agent) {
    emitJson(ctx, {
      decision: result.decision,
      status: result.status,
      ...(result.consentRef !== undefined ? { consentRef: result.consentRef } : {}),
      ...proof,
      ...(basis !== undefined ? { basis } : {}),
    });
  } else if (allowed) {
    const ref = result.consentRef ? pc.dim(` ref ${result.consentRef}`) : "";
    const why = basis !== undefined ? pc.dim(` declared basis ${basis}, no consent record`) : "";
    emitLine(
      ctx,
      `${pc.green("✓ ALLOW")}  ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}${proofLabel(proof)}${ref}${why}`,
    );
  } else {
    emitLine(
      ctx,
      `${pc.red("✗ DENY")}   ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}${proofLabel(proof)}`,
    );
  }

  ctx.exit = allowed ? EXIT.OK : EXIT.DENY;
}

async function batchMode(ctx: Context, filePath: string): Promise<void> {
  let items: BatchCheckItem[];
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new AgreelyValidationError(
        `${filePath}: expected a JSON array of {customerRef, category, purpose} objects.`,
        { code: "invalid_request", status: 422 },
      );
    }
    items = parsed.map((entry: unknown, idx: number) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>)["customerRef"] !== "string" ||
        typeof (entry as Record<string, unknown>)["category"] !== "string" ||
        typeof (entry as Record<string, unknown>)["purpose"] !== "string"
      ) {
        throw new AgreelyValidationError(
          `${filePath}[${idx}]: each item must be {customerRef: string, category: string, purpose: string}.`,
          { code: "invalid_request", status: 422 },
        );
      }
      const e = entry as { customerRef: string; category: string; purpose: string };
      return { customerRef: e.customerRef, category: e.category, purpose: e.purpose };
    });
  } catch (err) {
    if (err instanceof AgreelyValidationError) throw err;
    throw new AgreelyValidationError(
      `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { code: "invalid_request", status: 422 },
    );
  }

  const { client } = await buildClient(ctx, { check: true });
  const decisions: BatchDecision[] = await client.checkBatch(items);

  const anyDeny = decisions.some((d) => d.decision === "deny");

  if (ctx.agent) {
    emitJson(ctx, decisions.map((d) => {
      const basis = declaredBasis(d);
      return {
        customerRef: d.customerRef,
        category: d.category,
        purpose: d.purpose,
        decision: d.decision,
        status: d.status,
        ...(d.consentRef !== undefined ? { consentRef: d.consentRef } : {}),
        ...proofOf(d),
        ...(basis !== undefined ? { basis } : {}),
      };
    }));
  } else {
    for (const d of decisions) {
      if (d.decision === "allow") {
        const ref = d.consentRef ? pc.dim(` ref ${d.consentRef}`) : "";
        const basis = declaredBasis(d);
        const why = basis !== undefined ? pc.dim(` declared basis ${basis}, no consent record`) : "";
        emitLine(
          ctx,
          `${pc.green("✓ ALLOW")}  ${pc.bold(d.customerRef)} · ${d.category} / ${d.purpose}  ` +
            `${pc.dim(`(${d.status})`)}${proofLabel(proofOf(d))}${ref}${why}`,
        );
      } else {
        emitLine(
          ctx,
          `${pc.red("✗ DENY")}   ${pc.bold(d.customerRef)} · ${d.category} / ${d.purpose}  ` +
            `${pc.dim(`(${d.status})`)}${proofLabel(proofOf(d))}`,
        );
      }
    }
  }

  ctx.exit = anyDeny ? EXIT.DENY : EXIT.OK;
}

/** The DECLARED non-consent lawful basis behind a `status: "necessity"` allow, or undefined. */
function declaredBasis(decision: CheckResult | BatchDecision): string | undefined {
  return decision.basis ?? undefined;
}

/**
 * The proof fields of a record-backed decision, passed through verbatim when present:
 * `assurance`, `tier`, and the end of the consent (`validUntil`, plus `revokedAt` once
 * withdrawn). All are absent, never null, when no record backs the answer.
 */
function proofOf(
  decision: CheckResult | BatchDecision,
): { assurance?: string; tier?: string; validUntil?: string; revokedAt?: string } {
  return {
    ...(decision.validUntil ? { validUntil: decision.validUntil } : {}),
    ...(decision.revokedAt ? { revokedAt: decision.revokedAt } : {}),
    ...(decision.assurance ? { assurance: decision.assurance } : {}),
    ...(decision.tier ? { tier: decision.tier } : {}),
  };
}

/** The human rendering of the proof tier, e.g. " tier verbal (company_documented)", or "". */
function proofLabel(proof: { assurance?: string; tier?: string; validUntil?: string; revokedAt?: string }): string {
  let label = "";
  if (proof.tier !== undefined) {
    const assurance = proof.assurance !== undefined ? ` (${proof.assurance})` : "";
    label = pc.dim(` tier ${proof.tier}${assurance}`);
  } else if (proof.assurance !== undefined) {
    label = pc.dim(` ${proof.assurance}`);
  }
  if (proof.validUntil !== undefined) label += pc.dim(` validUntil ${proof.validUntil}`);
  if (proof.revokedAt !== undefined) label += pc.dim(` revokedAt ${proof.revokedAt}`);
  return label;
}

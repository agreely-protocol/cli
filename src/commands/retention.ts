// agreely retention show <customerRef>
// agreely retention dispose <customerRef> --disposition <destroyed|anonymized|legal_hold>
//                           [--reason <t>] [--retention-until <YYYY-MM-DD>] [--schedule-ref <r>]
//
// Per-customer retention (scope: 'registry'). Agreely records what the host DECLARES and
// verifies none of it. `dispose` needs the relationship to have ENDED first (409
// relationship_active otherwise); a legal_hold needs --reason naming the law. The
// response says what happened to Agreely's own copy of the identity (agreelyIdentity)
// and warns when an active hold stands (hold_active).

import type { CustomerRetention, DeclareDispositionInput, DeclaredDisposition } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { assertDate, need, rawRef, oneOf, opt } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

const DISPOSITIONS = ["destroyed", "anonymized", "legal_hold"] as const;

export async function retentionShowCommand(ctx: Context, customerRef: string): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  const { client } = await buildClient(ctx);
  const r: CustomerRetention = await client.retention.getCustomerRetention(ref);

  if (ctx.agent) {
    emitJson(ctx, r);
    return;
  }
  emitLine(ctx, `${pc.bold("Retention")} ${r.customerRef}`);
  emitLine(ctx, `  relationship  ${r.relationship.status}${r.relationship.endedAt ? ` (ended ${r.relationship.endedAt})` : ""}`);
  emitLine(ctx, `  clock dueAt   ${r.clock.dueAt ?? "none"}${r.clock.reason ? pc.dim(` (${r.clock.reason})`) : ""}`);
  for (const rule of r.clock.rules) {
    const held = rule.held ? pc.yellow(" HELD") : "";
    emitLine(ctx, `    · ${rule.ruleId}  ${rule.periodMonths} months, ${rule.action}, due ${rule.dueAt ?? "n/a"}${held}`);
  }
  if (r.disposition !== null) {
    const d = r.disposition;
    emitLine(ctx, `  disposition   ${d.disposition} declared ${d.declaredAt}  identity ${d.agreelyIdentity ?? "n/a"}`);
  } else {
    emitLine(ctx, "  disposition   none");
  }
  emitLine(ctx, `  holds         ${r.holds.length}${r.releasedTruncated ? " (older released holds left out)" : ""}`);
  for (const h of r.holds) emitLine(ctx, `    · ${h.id}  ${h.status}  started ${h.startedOn}`);
}

export interface RetentionDisposeFlags {
  disposition?: string;
  reason?: string;
  retentionUntil?: string;
  scheduleRef?: string;
}

export async function retentionDisposeCommand(
  ctx: Context,
  customerRef: string,
  flags: RetentionDisposeFlags,
): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  const disposition = oneOf(need(flags.disposition, "--disposition"), DISPOSITIONS, "--disposition");
  const reason = opt(flags.reason);
  const retentionUntil = opt(flags.retentionUntil);
  const scheduleRef = opt(flags.scheduleRef);

  if (disposition === "legal_hold" && reason === undefined) {
    throw new UsageError('--reason "<text>" is required for a legal_hold: name the law that imposes the delay.');
  }
  if (retentionUntil !== undefined) {
    if (disposition !== "legal_hold") {
      throw new UsageError("--retention-until applies to a legal_hold only.");
    }
    assertDate(retentionUntil, "--retention-until");
  }

  const base = scheduleRef !== undefined ? { scheduleRef } : {};
  const input: DeclareDispositionInput =
    disposition === "legal_hold"
      ? { ...base, disposition, reason: reason as string, ...(retentionUntil !== undefined ? { retentionUntil } : {}) }
      : { ...base, disposition, ...(reason !== undefined ? { reason } : {}) };

  const { client } = await buildClient(ctx, { write: true });
  const result: DeclaredDisposition = await client.retention.declareDisposition(ref, input);

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Disposition declared ${pc.bold(result.disposition)} for ${result.customerRef}${result.appended ? "" : pc.dim(" (the standing declaration was replayed)")}`);
  emitLine(ctx, `  ${pc.bold("agreelyIdentity")}  ${result.agreelyIdentity ?? "n/a"}`);
  for (const w of result.warnings) {
    emitLine(ctx, pc.yellow(`  warning ${w.code}: ${w.message} (${w.holdIds.join(", ")})`));
  }
}

// agreely customer get <customerRef>
// agreely customer set <customerRef> [--display-name <n>] [--email <e>] [--basis-note <t>]
//                      [--legal-basis <basis>] [--notice-locale <fr|en>]
//
// The customer registry (scope: 'registry'), one customerRef at a time. `get` returns
// METADATA only (every personal field is a boolean, never read back). `set` is a MERGE:
// an absent flag leaves the field as it stands, and an EMPTY value ("") clears it (every field follows the same rule).
// 409 identity_held / identity_erased means the identity cannot be changed now.

import type { CustomerRecord, RegistryBasis, UpsertCustomerInput, UpsertCustomerResult } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { oneOf, rawRef } from "../flags.js";

// The non-consent grounds of both acts the registry accepts (`consent` itself is refused).
export const LEGAL_BASES = [
  "contract",
  "necessary_for_service",
  "security_fraud",
  "legal_obligation",
  "professional_contact",
  "attributions",
  "programme",
  "entente_collecte",
  "compatible_use",
  "manifest_benefit",
  "law_application",
  "public_character",
  "depersonalized_research",
] as const satisfies readonly RegistryBasis[];
import { emitJson, emitLine, pc } from "../output.js";

function show(ctx: Context, r: CustomerRecord): void {
  emitLine(ctx, `  ${pc.bold("registered")}    ${r.registered ? "yes" : "no"}`);
  emitLine(ctx, `  ${pc.bold("source")}        ${r.source ?? "none"}`);
  emitLine(ctx, `  ${pc.bold("held")}          name ${yn(r.hasDisplayName)}, email ${yn(r.hasEmail)}, basis note ${yn(r.hasBasisNote)}`);
  emitLine(ctx, `  ${pc.bold("legalBasis")}    ${r.legalBasis ?? "none"}`);
  emitLine(ctx, `  ${pc.bold("noticeLocale")}  ${r.noticeLocale ?? "none"}`);
  emitLine(ctx, `  ${pc.bold("relationship")}  ${r.relationship.status}${r.relationship.endedAt ? ` (ended ${r.relationship.endedAt})` : ""}`);
}

function yn(b: boolean): string {
  return b ? "yes" : "no";
}

export async function customerGetCommand(ctx: Context, customerRef: string): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  const { client } = await buildClient(ctx);
  const record = await client.customers.get(ref);
  if (ctx.agent) {
    emitJson(ctx, record);
    return;
  }
  emitLine(ctx, `${pc.bold("Customer")} ${record.customerRef}`);
  show(ctx, record);
}

export interface CustomerSetFlags {
  displayName?: string;
  email?: string;
  basisNote?: string;
  legalBasis?: string;
  noticeLocale?: string;
}

export async function customerSetCommand(
  ctx: Context,
  customerRef: string,
  flags: CustomerSetFlags,
): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  // One rule for every field: a flag that was NOT passed leaves the field untouched, a
  // flag whose trimmed value is empty CLEARS it (null), anything else writes it.
  const clearable = (value: string | undefined): string | null | undefined =>
    value === undefined ? undefined : value.trim() === "" ? null : value.trim();
  const displayName = clearable(flags.displayName);
  const email = clearable(flags.email);
  const basisNote = clearable(flags.basisNote);
  const legalBasisRaw = clearable(flags.legalBasis);
  const noticeLocaleRaw = clearable(flags.noticeLocale);
  const legalBasis =
    typeof legalBasisRaw === "string" ? oneOf(legalBasisRaw, LEGAL_BASES, "--legal-basis") : legalBasisRaw;
  const noticeLocale =
    typeof noticeLocaleRaw === "string" ? oneOf(noticeLocaleRaw, ["fr", "en"] as const, "--notice-locale") : noticeLocaleRaw;
  const input: UpsertCustomerInput = {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(basisNote !== undefined ? { basisNote } : {}),
    ...(legalBasis !== undefined ? { legalBasis } : {}),
    ...(noticeLocale !== undefined ? { noticeLocale } : {}),
  };
  if (Object.keys(input).length === 0) {
    throw new UsageError(
      "Nothing to set: pass at least one of --display-name, --email, --basis-note, --legal-basis, --notice-locale (an empty value clears the field).",
    );
  }

  const { client } = await buildClient(ctx, { write: true });
  const result: UpsertCustomerResult = await client.customers.upsert(ref, input);
  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Customer ${result.created ? "created" : "updated"} ${pc.bold(result.customerRef)}`);
  show(ctx, result);
}

// agreely customer get <customerRef>
// agreely customer set <customerRef> [--display-name <n>] [--email <e>] [--basis-note <t>]
//                      [--legal-basis <basis>] [--notice-locale <fr|en>]
//
// The customer registry (scope: 'registry'), one customerRef at a time. `get` returns
// METADATA only (every personal field is a boolean, never read back). `set` is a MERGE:
// an absent flag leaves the field as it stands, and an EMPTY value ("") clears it.
// 409 identity_held / identity_erased means the identity cannot be changed now.

import type { CustomerRecord, UpsertCustomerInput, UpsertCustomerResult } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { need } from "../flags.js";
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
  const ref = need(customerRef, "<customerRef>");
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
  const ref = need(customerRef, "<customerRef>");
  // A flag that was passed carries its value as is: "" CLEARS the field (a merge, not a replace).
  const input = {
    ...(flags.displayName !== undefined ? { displayName: flags.displayName } : {}),
    ...(flags.email !== undefined ? { email: flags.email } : {}),
    ...(flags.basisNote !== undefined ? { basisNote: flags.basisNote } : {}),
    ...(flags.legalBasis !== undefined ? { legalBasis: flags.legalBasis === "" ? null : flags.legalBasis } : {}),
    ...(flags.noticeLocale !== undefined ? { noticeLocale: flags.noticeLocale === "" ? null : flags.noticeLocale } : {}),
  } as UpsertCustomerInput;
  if (Object.keys(input).length === 0) {
    throw new UsageError(
      "Nothing to set: pass at least one of --display-name, --email, --basis-note, --legal-basis, --notice-locale (an empty value clears the field).",
    );
  }

  const { client } = await buildClient(ctx);
  const result: UpsertCustomerResult = await client.customers.upsert(ref, input);
  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Customer ${result.created ? "created" : "updated"} ${pc.bold(result.customerRef)}`);
  show(ctx, result);
}

// agreely withdraw <customerRef> <consentRef> --channel <c> --operator <id>
//                  [--requested-at <instant>] [--reason <text>] [--idempotency-key <k>]
//
// Records a withdrawal the person asked for, on her behalf (scope: 'withdraw', never on
// a key by default). Always recordedOnBehalf and assurance company_attested. `gate` says
// what check answers NOW for that purpose: read it before telling anyone the use stopped.
// The operator is an opaque id of the staff member, never an email address. The daily cap
// (429 withdrawal_daily_cap) is NOT a rate window: do not retry (exit 8).

import type { ConsentWithdrawal, WithdrawalChannel } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { need, oneOf, opt } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

const CHANNELS = ["phone", "email", "mail", "in_person", "other"] as const satisfies readonly WithdrawalChannel[];
const CONSENT_REF_RE = /^0x[0-9a-f]+$/i;

export interface WithdrawFlags {
  channel?: string;
  operator?: string;
  requestedAt?: string;
  reason?: string;
  idempotencyKey?: string;
}

export async function withdrawCommand(
  ctx: Context,
  customerRef: string,
  consentRef: string,
  flags: WithdrawFlags,
): Promise<void> {
  const customer = need(customerRef, "<customerRef>");
  const ref = need(consentRef, "<consentRef>");
  if (!CONSENT_REF_RE.test(ref)) {
    throw new UsageError(`"${ref}" is not a valid consentRef (expected 0x + hex).`);
  }
  const channel = oneOf(need(flags.channel, "--channel"), CHANNELS, "--channel");
  const operator = need(flags.operator, "--operator <id>");
  const requestedAt = opt(flags.requestedAt);
  const reason = opt(flags.reason);
  const key = opt(flags.idempotencyKey);

  const { client } = await buildClient(ctx);
  const result: ConsentWithdrawal = await client.withdrawals.record(
    customer,
    ref,
    {
      channel,
      operator,
      ...(requestedAt !== undefined ? { requestedAt } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    key !== undefined ? { idempotencyKey: key } : {},
  );

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }
  const tag = result.alreadyWithdrawn ? pc.dim("(already withdrawn)") : "";
  emitLine(ctx, `${pc.green("✓")} Withdrawal recorded ${pc.bold(result.consentRef)} ${tag}`);
  emitLine(ctx, `  ${pc.bold("gate")}        ${result.gate}`);
  emitLine(ctx, `  ${pc.bold("assurance")}   ${result.assurance} (recorded on behalf of the person)`);
  for (const other of result.alsoWithdrawn) emitLine(ctx, `    also withdrawn ${pc.cyan(other)}`);
}

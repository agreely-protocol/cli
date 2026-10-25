// agreely withdraw <customerRef> <consentRef> --channel <c> --operator <id>
//                  [--requested-at <instant>] [--reason <text>] [--idempotency-key <k>]
//                  [--other-consents keep|withdraw | --also-withdraw <ref,...>]
//
// Records a withdrawal the person asked for, on her behalf (scope: 'withdraw', never on
// a key by default). Always recordedOnBehalf and assurance company_documented. `gate` says
// what check answers NOW for that purpose: read it before telling anyone the use stopped.
// The other consents of the purpose are withdrawn only when the scope names them; without
// a scope, a purpose with another consent in force is refused (422 other_consents_running,
// exit 2) and the error lists their refs. `stillInForce` lists those left in force.
// The operator is an opaque id of the staff member, never an email address. The daily cap
// (429 withdrawal_daily_cap) is NOT a rate window: do not retry (exit 8). An
// Idempotency-Key is generated when none is given and printed if the call times out.

import { WITHDRAWAL_CHANNELS, WITHDRAWAL_SCOPE_MAX } from "@agreely/sdk";
import type { ConsentWithdrawal } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { CONSENT_REF_RE, assertInstant, keyOrNew, need, rawRef, oneOf, opt } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";


export interface WithdrawFlags {
  channel?: string;
  operator?: string;
  requestedAt?: string;
  reason?: string;
  idempotencyKey?: string;
  otherConsents?: string;
  alsoWithdraw?: string[];
}

const OTHER_CONSENTS = ["keep", "withdraw"] as const;

/** The scope toward the other consents of the purpose, refused here the way the SDK refuses it. */
export function withdrawalScope(
  otherConsents: string | undefined,
  alsoWithdraw: string[] | undefined,
): { otherConsents?: "keep" | "withdraw"; alsoWithdraw?: string[] } {
  const refs = alsoWithdraw?.flatMap((raw) => raw.split(",")).map((ref) => ref.trim()).filter((ref) => ref !== "");
  if (otherConsents !== undefined && refs !== undefined) {
    throw new UsageError("Declare the scope once: --other-consents or --also-withdraw, never both.");
  }
  if (otherConsents !== undefined) return { otherConsents: oneOf(otherConsents, OTHER_CONSENTS, "--other-consents") };
  if (refs === undefined) return {};
  if (refs.length === 0 || refs.length > WITHDRAWAL_SCOPE_MAX) {
    throw new UsageError(`--also-withdraw takes 1 to ${WITHDRAWAL_SCOPE_MAX} consentRefs, comma-separated.`);
  }
  const bad = refs.find((ref) => !CONSENT_REF_RE.test(ref));
  if (bad !== undefined) {
    throw new UsageError(`"${bad}" is not a valid consentRef (expected 64 hex characters, 0x prefix optional).`);
  }
  return { alsoWithdraw: refs };
}

export async function withdrawCommand(
  ctx: Context,
  customerRef: string,
  consentRef: string,
  flags: WithdrawFlags,
): Promise<void> {
  const customer = rawRef(customerRef, "<customerRef>");
  const ref = need(consentRef, "<consentRef>");
  if (!CONSENT_REF_RE.test(ref)) {
    throw new UsageError(`"${ref}" is not a valid consentRef (expected 64 hex characters, 0x prefix optional).`);
  }
  const channel = oneOf(need(flags.channel, "--channel"), WITHDRAWAL_CHANNELS, "--channel");
  const operator = need(flags.operator, "--operator <id>");
  const requestedAtFlag = opt(flags.requestedAt);
  const requestedAt = requestedAtFlag !== undefined ? assertInstant(requestedAtFlag, "--requested-at") : undefined;
  const reason = opt(flags.reason);
  const scope = withdrawalScope(flags.otherConsents?.trim(), flags.alsoWithdraw);
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;

  const { client } = await buildClient(ctx, { write: true });
  const result: ConsentWithdrawal = await client.withdrawals.record(
    customer,
    ref,
    {
      channel,
      operator,
      ...(requestedAt !== undefined ? { requestedAt } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...scope,
    },
    { idempotencyKey: key },
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
  for (const other of result.stillInForce ?? []) emitLine(ctx, `    still in force ${pc.cyan(other)}`);
}

// agreely check <customerId> <category> <purpose> [--json]
//
// The core agent verb. category/purpose are sent RAW (the server normalizes).
//   ALLOW -> exit 0,  DENY -> exit 10 (a clean negative, NOT an error).
// An outage throws AgreelyUnavailableError from the SDK -> the top-level mapper
// resolves it to exit 4 (distinct from deny), honouring the fail-closed default.

import type { CheckResult } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { EXIT } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function checkCommand(
  ctx: Context,
  customerId: string,
  category: string,
  purpose: string,
): Promise<void> {
  const { client } = await buildClient(ctx);
  const result: CheckResult = await client.checkDetailed(customerId, category, purpose);
  const allowed = result.decision === "allow";

  if (ctx.agent) {
    emitJson(ctx, {
      decision: result.decision,
      status: result.status,
      ...(result.consentRef !== undefined ? { consentRef: result.consentRef } : {}),
    });
  } else if (allowed) {
    const ref = result.consentRef ? pc.dim(` ref ${result.consentRef}`) : "";
    emitLine(
      ctx,
      `${pc.green("✓ ALLOW")}  ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}${ref}`,
    );
  } else {
    emitLine(
      ctx,
      `${pc.red("✗ DENY")}   ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}`,
    );
  }

  ctx.exit = allowed ? EXIT.OK : EXIT.DENY;
}
